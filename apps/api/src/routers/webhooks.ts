import { schema } from '@payunivercart/db';
import { WebhookEventTypeSchema } from '@payunivercart/shared';
import { generateWebhookSecret } from '@payunivercart/shared/webhooks/signature';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';
import { emitWebhook } from '../webhooks/outbound-emit';

/**
 * Webhook monitoring router — Pilar 2/Ops surface.
 *
 * Producer-facing read of `webhooks_inbound` so the operator can see
 * which gateway/WAHA/partner events landed, which are still pending,
 * and which crashed mid-handler. Backs the dashboard
 * `/integrations/webhooks` page.
 *
 * Replay flow:
 *   1. Producer hits "Reprocessar" on a stuck row in the dashboard.
 *   2. `requeue` mutation clears `processedAt = NULL` + `error = NULL`.
 *   3. Next webhook delivery from the gateway with the same
 *      `(source, event_id)` falls into the case-(c) branch in
 *      `gateways.ts` handler and re-runs the side-effects. Side-effects
 *      are individually idempotent (Connect uses jti dedupe, tracking
 *      has ON CONFLICT DO NOTHING).
 *
 * NOTE: this surface intentionally redacts `rawBody` until the producer
 * explicitly opens a row — raw payloads contain customer email/CPF and
 * we don't want them in the list view's response body (LGPD: minimise
 * exposure surface).
 */

const StatusFilter = z.enum(['all', 'processed', 'pending', 'error']);
const SignatureFilter = z.enum(['all', 'valid', 'invalid', 'unknown']);

const WebhookSummaryRow = z.object({
  id: z.string().uuid(),
  source: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  signatureValid: z.enum(['valid', 'invalid', 'unknown']),
  status: z.enum(['processed', 'pending', 'error']),
  error: z.string().nullable(),
  processedAt: z.date().nullable(),
  createdAt: z.date(),
});

const WebhookDetailRow = WebhookSummaryRow.extend({
  rawHeaders: z.record(z.string(), z.unknown()),
  rawBody: z.string(),
});

export const webhooksRouter = router({
  /* ------------------------------------------------------------------ */
  /* List — paginated by createdAt desc.                                 */
  /* ------------------------------------------------------------------ */
  listInbound: workspaceProcedure
    .input(
      z
        .object({
          status: StatusFilter.default('all'),
          signature: SignatureFilter.default('all'),
          source: z.string().trim().min(1).max(40).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ status: 'all', signature: 'all', limit: 50 }),
    )
    .output(z.array(WebhookSummaryRow))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(schema.webhooksInbound.workspaceId, ctx.workspaceId)];
      if (input.status === 'processed') {
        conditions.push(isNotNull(schema.webhooksInbound.processedAt));
      } else if (input.status === 'pending') {
        conditions.push(isNull(schema.webhooksInbound.processedAt));
        conditions.push(isNull(schema.webhooksInbound.error));
      } else if (input.status === 'error') {
        conditions.push(isNotNull(schema.webhooksInbound.error));
      }
      if (input.signature !== 'all') {
        conditions.push(eq(schema.webhooksInbound.signatureValid, input.signature));
      }
      if (input.source) {
        conditions.push(eq(schema.webhooksInbound.source, input.source));
      }

      const rows = await ctx.services.db.db
        .select({
          id: schema.webhooksInbound.id,
          source: schema.webhooksInbound.source,
          eventId: schema.webhooksInbound.eventId,
          eventType: schema.webhooksInbound.eventType,
          signatureValid: schema.webhooksInbound.signatureValid,
          processedAt: schema.webhooksInbound.processedAt,
          error: schema.webhooksInbound.error,
          createdAt: schema.webhooksInbound.createdAt,
        })
        .from(schema.webhooksInbound)
        .where(and(...conditions))
        .orderBy(desc(schema.webhooksInbound.createdAt))
        .limit(input.limit);

      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        eventId: r.eventId,
        eventType: r.eventType,
        signatureValid:
          r.signatureValid === 'valid'
            ? ('valid' as const)
            : r.signatureValid === 'invalid'
              ? ('invalid' as const)
              : ('unknown' as const),
        status: r.processedAt
          ? ('processed' as const)
          : r.error
            ? ('error' as const)
            : ('pending' as const),
        error: r.error,
        processedAt: r.processedAt,
        createdAt: r.createdAt,
      }));
    }),

  /* ------------------------------------------------------------------ */
  /* Detail — full raw body + headers (LGPD-sensitive, opt-in only).    */
  /* ------------------------------------------------------------------ */
  inboundDetail: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(WebhookDetailRow)
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select()
        .from(schema.webhooksInbound)
        .where(
          and(
            eq(schema.webhooksInbound.id, input.id),
            eq(schema.webhooksInbound.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Webhook não encontrado.' });
      }
      return {
        id: row.id,
        source: row.source,
        eventId: row.eventId,
        eventType: row.eventType,
        signatureValid:
          row.signatureValid === 'valid'
            ? ('valid' as const)
            : row.signatureValid === 'invalid'
              ? ('invalid' as const)
              : ('unknown' as const),
        status: row.processedAt
          ? ('processed' as const)
          : row.error
            ? ('error' as const)
            : ('pending' as const),
        error: row.error,
        processedAt: row.processedAt,
        createdAt: row.createdAt,
        rawHeaders: row.rawHeaders as Record<string, unknown>,
        rawBody: row.rawBody,
      };
    }),

  /* ------------------------------------------------------------------ */
  /* Requeue — clear processedAt + error so the next gateway retry      */
  /* falls into the case-(c) branch in gateways.ts handler.             */
  /* ------------------------------------------------------------------ */
  requeue: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({ id: schema.webhooksInbound.id })
        .from(schema.webhooksInbound)
        .where(
          and(
            eq(schema.webhooksInbound.id, input.id),
            eq(schema.webhooksInbound.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Webhook não encontrado.' });
      }
      // Defense-in-depth: even though the SELECT above already filters
      // by workspaceId, repeat the predicate on the UPDATE to close the
      // TOCTOU window between the two statements.
      await ctx.services.db.db
        .update(schema.webhooksInbound)
        .set({ processedAt: null, error: null })
        .where(
          and(
            eq(schema.webhooksInbound.id, input.id),
            eq(schema.webhooksInbound.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /* ================================================================== */
  /* Outbound endpoints — producer-managed subscriptions.                */
  /* ================================================================== */

  endpointsList: workspaceProcedure
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          url: z.string(),
          description: z.string().nullable(),
          eventTypes: z.array(z.string()),
          isActive: z.boolean(),
          secretPrefix: z.string(),
          createdAt: z.date(),
          lastDeliveredAt: z.date().nullable(),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.webhookEndpoints.id,
          url: schema.webhookEndpoints.url,
          description: schema.webhookEndpoints.description,
          eventTypes: schema.webhookEndpoints.eventTypes,
          isActive: schema.webhookEndpoints.isActive,
          secret: schema.webhookEndpoints.secret,
          createdAt: schema.webhookEndpoints.createdAt,
        })
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId))
        .orderBy(desc(schema.webhookEndpoints.createdAt));

      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        description: r.description,
        eventTypes: Array.isArray(r.eventTypes) ? (r.eventTypes as string[]) : [],
        isActive: r.isActive,
        secretPrefix: `${r.secret.slice(0, 12)}...`,
        createdAt: r.createdAt,
        lastDeliveredAt: null,
      }));
    }),

  endpointsCreate: workspaceProcedure
    .input(
      z.object({
        url: z
          .string()
          .url()
          .refine((v) => v.startsWith('https://'), {
            message: 'Endpoint URL deve usar HTTPS.',
          }),
        eventTypes: z
          .array(z.union([WebhookEventTypeSchema, z.literal('*')]))
          .min(1, 'Selecione ao menos um evento.'),
        description: z.string().trim().max(280).optional(),
      }),
    )
    .output(
      z.object({
        id: z.string().uuid(),
        secret: z.string(),
        secretPrefix: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const secret = generateWebhookSecret();
      const [row] = await ctx.services.db.db
        .insert(schema.webhookEndpoints)
        .values({
          workspaceId: ctx.workspaceId,
          url: input.url,
          description: input.description ?? null,
          eventTypes: input.eventTypes,
          secret,
          isActive: true,
        })
        .returning({ id: schema.webhookEndpoints.id });
      if (!row) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Falha ao criar endpoint.' });
      }
      return {
        id: row.id,
        secret,
        secretPrefix: `${secret.slice(0, 12)}...`,
      };
    }),

  endpointsUpdate: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        url: z
          .string()
          .url()
          .refine((v) => v.startsWith('https://'), {
            message: 'Endpoint URL deve usar HTTPS.',
          })
          .optional(),
        eventTypes: z
          .array(z.union([WebhookEventTypeSchema, z.literal('*')]))
          .min(1)
          .optional(),
        isActive: z.boolean().optional(),
        description: z.string().trim().max(280).nullable().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {};
      if (input.url !== undefined) patch.url = input.url;
      if (input.eventTypes !== undefined) patch.eventTypes = input.eventTypes;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.description !== undefined) patch.description = input.description;

      if (Object.keys(patch).length === 0) {
        return { ok: true as const };
      }

      const result = await ctx.services.db.db
        .update(schema.webhookEndpoints)
        .set(patch)
        .where(
          and(
            eq(schema.webhookEndpoints.id, input.id),
            eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId),
          ),
        )
        .returning({ id: schema.webhookEndpoints.id });

      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Endpoint não encontrado.' });
      }
      return { ok: true as const };
    }),

  endpointsRegenerateSecret: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ secret: z.string(), secretPrefix: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const secret = generateWebhookSecret();
      const result = await ctx.services.db.db
        .update(schema.webhookEndpoints)
        .set({ secret })
        .where(
          and(
            eq(schema.webhookEndpoints.id, input.id),
            eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId),
          ),
        )
        .returning({ id: schema.webhookEndpoints.id });
      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Endpoint não encontrado.' });
      }
      return { secret, secretPrefix: `${secret.slice(0, 12)}...` };
    }),

  endpointsRemove: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .delete(schema.webhookEndpoints)
        .where(
          and(
            eq(schema.webhookEndpoints.id, input.id),
            eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId),
          ),
        )
        .returning({ id: schema.webhookEndpoints.id });
      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Endpoint não encontrado.' });
      }
      return { ok: true as const };
    }),

  /* ================================================================== */
  /* Deliveries — webhooks_outbox monitoring + replay.                   */
  /* ================================================================== */

  deliveriesList: workspaceProcedure
    .input(
      z
        .object({
          endpointId: z.string().uuid().optional(),
          status: z
            .enum(['pending', 'processing', 'delivered', 'failed', 'dead_letter'])
            .optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          endpoint: z.string(),
          eventType: z.string(),
          status: z.enum(['pending', 'processing', 'delivered', 'failed', 'dead_letter']),
          attempts: z.number().int(),
          lastAttemptAt: z.date().nullable(),
          nextAttemptAt: z.date().nullable(),
          lastResponseStatus: z.number().int().nullable(),
          deliveredAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(schema.webhooksOutbox.workspaceId, ctx.workspaceId)];

      if (input.endpointId) {
        const [endpoint] = await ctx.services.db.db
          .select({ url: schema.webhookEndpoints.url })
          .from(schema.webhookEndpoints)
          .where(
            and(
              eq(schema.webhookEndpoints.id, input.endpointId),
              eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId),
            ),
          )
          .limit(1);
        if (!endpoint) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Endpoint não encontrado.' });
        }
        conditions.push(eq(schema.webhooksOutbox.endpoint, endpoint.url));
      }

      if (input.status) {
        conditions.push(eq(schema.webhooksOutbox.status, input.status));
      }

      const rows = await ctx.services.db.db
        .select({
          id: schema.webhooksOutbox.id,
          endpoint: schema.webhooksOutbox.endpoint,
          eventType: schema.webhooksOutbox.eventType,
          status: schema.webhooksOutbox.status,
          attempts: schema.webhooksOutbox.attempts,
          lastAttemptAt: schema.webhooksOutbox.lastAttemptAt,
          nextAttemptAt: schema.webhooksOutbox.nextAttemptAt,
          lastResponseStatus: schema.webhooksOutbox.lastResponseStatus,
          deliveredAt: schema.webhooksOutbox.deliveredAt,
          createdAt: schema.webhooksOutbox.createdAt,
        })
        .from(schema.webhooksOutbox)
        .where(and(...conditions))
        .orderBy(desc(schema.webhooksOutbox.createdAt))
        .limit(input.limit);

      return rows.map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        eventType: r.eventType,
        status: r.status,
        attempts: r.attempts,
        lastAttemptAt: r.lastAttemptAt,
        nextAttemptAt: r.nextAttemptAt,
        lastResponseStatus: r.lastResponseStatus,
        deliveredAt: r.deliveredAt,
        createdAt: r.createdAt,
      }));
    }),

  deliveryDetail: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(
      z.object({
        id: z.string().uuid(),
        endpoint: z.string(),
        eventType: z.string(),
        status: z.enum(['pending', 'processing', 'delivered', 'failed', 'dead_letter']),
        attempts: z.number().int(),
        lastAttemptAt: z.date().nullable(),
        nextAttemptAt: z.date().nullable(),
        lastResponseStatus: z.number().int().nullable(),
        lastResponseBody: z.string().nullable(),
        deliveredAt: z.date().nullable(),
        createdAt: z.date(),
        payload: z.unknown(),
        signature: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select()
        .from(schema.webhooksOutbox)
        .where(
          and(
            eq(schema.webhooksOutbox.id, input.id),
            eq(schema.webhooksOutbox.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Delivery não encontrada.' });
      }
      return {
        id: row.id,
        endpoint: row.endpoint,
        eventType: row.eventType,
        status: row.status,
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt,
        nextAttemptAt: row.nextAttemptAt,
        lastResponseStatus: row.lastResponseStatus,
        lastResponseBody: row.lastResponseBody,
        deliveredAt: row.deliveredAt,
        createdAt: row.createdAt,
        payload: row.payload,
        signature: row.signature,
      };
    }),

  deliveryRetry: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .update(schema.webhooksOutbox)
        .set({ status: 'pending', nextAttemptAt: new Date() })
        .where(
          and(
            eq(schema.webhooksOutbox.id, input.id),
            eq(schema.webhooksOutbox.workspaceId, ctx.workspaceId),
          ),
        )
        .returning({ id: schema.webhooksOutbox.id });
      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Delivery não encontrada.' });
      }
      return { ok: true as const };
    }),

  testFire: workspaceProcedure
    .input(
      z.object({
        endpointId: z.string().uuid(),
        eventType: WebhookEventTypeSchema,
      }),
    )
    .output(z.object({ delivered_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [endpoint] = await ctx.services.db.db
        .select({ id: schema.webhookEndpoints.id })
        .from(schema.webhookEndpoints)
        .where(
          and(
            eq(schema.webhookEndpoints.id, input.endpointId),
            eq(schema.webhookEndpoints.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Endpoint não encontrado.' });
      }

      await emitWebhook(
        { services: ctx.services },
        {
          workspaceId: ctx.workspaceId,
          eventType: input.eventType,
          object: { test: true, message: 'Test event from Univercart' },
          livemode: false,
        },
      );

      // Return the most recent test delivery row for this endpoint so the
      // dashboard can deep-link straight into the detail view.
      const [endpointRow] = await ctx.services.db.db
        .select({ url: schema.webhookEndpoints.url })
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, input.endpointId))
        .limit(1);

      const [latest] = await ctx.services.db.db
        .select({ id: schema.webhooksOutbox.id })
        .from(schema.webhooksOutbox)
        .where(
          and(
            eq(schema.webhooksOutbox.workspaceId, ctx.workspaceId),
            eq(schema.webhooksOutbox.endpoint, endpointRow?.url ?? ''),
            eq(schema.webhooksOutbox.eventType, input.eventType),
          ),
        )
        .orderBy(desc(schema.webhooksOutbox.createdAt))
        .limit(1);

      if (!latest) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Test event enfileirado mas linha do outbox não encontrada.',
        });
      }
      return { delivered_id: latest.id };
    }),
});
