import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

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
      await ctx.services.db.db
        .update(schema.webhooksInbound)
        .set({ processedAt: null, error: null })
        .where(eq(schema.webhooksInbound.id, input.id));
      return { ok: true as const };
    }),
});
