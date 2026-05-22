import { mintApiKey, mintJwtSecret, mintWebhookSecret } from '@payunivercart/connect';
import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, router, superuserProcedure } from '../trpc';

/**
 * Univercart Connect partner management.
 *
 * Two surfaces:
 *
 *   - `admin*` procedures (superuserProcedure) — full CRUD on partner
 *     accounts, API keys, webhook endpoints, roles. Used by the
 *     internal admin dashboard to onboard new SaaS partners.
 *
 *   - `list*` procedures (authedProcedure) — read-only catalogue for
 *     producers picking a partner+role when configuring a subscription
 *     plan. Returns only `status=active` partners + their roles. No
 *     credentials surface here.
 */

const eventTypeSchema = z.enum([
  'entitlement.granted',
  'entitlement.role_changed',
  'entitlement.suspended',
  'entitlement.reactivated',
  'entitlement.revoked',
]);

export const partnersRouter = router({
  /* ===================== producer-facing (read-only) ===================== */

  /** Active partners surfaced in the producer plan editor. */
  list: authedProcedure
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          slug: z.string(),
          name: z.string(),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.partnerAccounts.id,
          slug: schema.partnerAccounts.slug,
          name: schema.partnerAccounts.name,
        })
        .from(schema.partnerAccounts)
        .where(eq(schema.partnerAccounts.status, 'active'))
        .orderBy(asc(schema.partnerAccounts.name));
      return rows;
    }),

  /** Active roles for a given partner. */
  listRoles: authedProcedure
    .input(z.object({ partnerId: z.string().uuid() }))
    .output(
      z.array(
        z.object({
          slug: z.string(),
          displayName: z.string(),
          description: z.string().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          slug: schema.partnerRoles.slug,
          displayName: schema.partnerRoles.displayName,
          description: schema.partnerRoles.description,
        })
        .from(schema.partnerRoles)
        .where(eq(schema.partnerRoles.partnerId, input.partnerId))
        .orderBy(asc(schema.partnerRoles.sortOrder), asc(schema.partnerRoles.slug));
      return rows;
    }),

  /* ===================== admin (superuser only) ========================== */

  adminList: superuserProcedure.query(async ({ ctx }) => {
    const rows = await ctx.services.db.db
      .select({
        id: schema.partnerAccounts.id,
        slug: schema.partnerAccounts.slug,
        name: schema.partnerAccounts.name,
        contactEmail: schema.partnerAccounts.contactEmail,
        status: schema.partnerAccounts.status,
        trialAccessEnabled: schema.partnerAccounts.trialAccessEnabled,
        setupBaseUrl: schema.partnerAccounts.setupBaseUrl,
        // JWT signing secret is returned so the admin UI can surface
        // it via the reveal+copy widget. Plaintext is necessary
        // because partners need to verify magic-link tokens with the
        // exact same secret we sign with (HS256, symmetric).
        jwtSigningSecret: schema.partnerAccounts.jwtSigningSecret,
        createdAt: schema.partnerAccounts.createdAt,
      })
      .from(schema.partnerAccounts)
      .orderBy(desc(schema.partnerAccounts.createdAt));
    return rows;
  }),

  adminCreate: superuserProcedure
    .input(
      z.object({
        slug: z
          .string()
          .trim()
          .min(2)
          .max(40)
          .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
        name: z.string().trim().min(1).max(120),
        contactEmail: z.string().email(),
        trialAccessEnabled: z.boolean().default(true),
        setupBaseUrl: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const [row] = await ctx.services.db.db
          .insert(schema.partnerAccounts)
          .values({
            slug: input.slug,
            name: input.name,
            contactEmail: input.contactEmail,
            status: 'active',
            trialAccessEnabled: input.trialAccessEnabled,
            setupBaseUrl: input.setupBaseUrl,
            jwtSigningSecret: mintJwtSecret(),
          })
          .returning({ id: schema.partnerAccounts.id });
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Falha ao criar partner.',
          });
        }
        return { id: row.id };
      } catch (cause) {
        if ((cause as { code?: string }).code === '23505') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Slug já em uso por outro partner.' });
        }
        throw cause;
      }
    }),

  adminUpdate: superuserProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        contactEmail: z.string().email().optional(),
        status: z.enum(['pending', 'active', 'suspended']).optional(),
        trialAccessEnabled: z.boolean().optional(),
        setupBaseUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      if (Object.keys(patch).length === 0) return { ok: true };
      await ctx.services.db.db
        .update(schema.partnerAccounts)
        .set(patch)
        .where(eq(schema.partnerAccounts.id, id));
      return { ok: true };
    }),

  /** Lists keys WITHOUT cleartext — only prefix, mode, name, lastUsedAt, revokedAt. */
  adminListApiKeys: superuserProcedure
    .input(z.object({ partnerId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.partnerApiKeys.id,
          name: schema.partnerApiKeys.name,
          mode: schema.partnerApiKeys.mode,
          prefix: schema.partnerApiKeys.prefix,
          lastUsedAt: schema.partnerApiKeys.lastUsedAt,
          revokedAt: schema.partnerApiKeys.revokedAt,
          createdAt: schema.partnerApiKeys.createdAt,
        })
        .from(schema.partnerApiKeys)
        .where(eq(schema.partnerApiKeys.partnerId, input.partnerId))
        .orderBy(desc(schema.partnerApiKeys.createdAt));
      return rows;
    }),

  /**
   * Mint a new API key and return the cleartext exactly ONCE. The
   * cleartext is never recoverable after this call returns — the
   * caller MUST surface it to the operator immediately.
   */
  adminCreateApiKey: superuserProcedure
    .input(
      z.object({
        partnerId: z.string().uuid(),
        name: z.string().trim().min(1).max(120),
        mode: z.enum(['test', 'live']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const minted = mintApiKey('secret', input.mode);
      const [row] = await ctx.services.db.db
        .insert(schema.partnerApiKeys)
        .values({
          partnerId: input.partnerId,
          name: input.name,
          mode: input.mode,
          prefix: minted.prefix,
          hash: minted.hash,
        })
        .returning({ id: schema.partnerApiKeys.id });
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Falha ao mintar API key.',
        });
      }
      return {
        id: row.id,
        cleartext: minted.cleartext,
        prefix: minted.prefix,
      };
    }),

  adminRevokeApiKey: superuserProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.partnerApiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(schema.partnerApiKeys.id, input.id), isNull(schema.partnerApiKeys.revokedAt)),
        );
      return { ok: true };
    }),

  adminListWebhookEndpoints: superuserProcedure
    .input(z.object({ partnerId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.partnerWebhookEndpoints.id,
          url: schema.partnerWebhookEndpoints.url,
          mode: schema.partnerWebhookEndpoints.mode,
          description: schema.partnerWebhookEndpoints.description,
          eventTypes: schema.partnerWebhookEndpoints.eventTypes,
          isActive: schema.partnerWebhookEndpoints.isActive,
          signingSecret: schema.partnerWebhookEndpoints.signingSecret,
          createdAt: schema.partnerWebhookEndpoints.createdAt,
        })
        .from(schema.partnerWebhookEndpoints)
        .where(eq(schema.partnerWebhookEndpoints.partnerId, input.partnerId))
        .orderBy(desc(schema.partnerWebhookEndpoints.createdAt));
      return rows;
    }),

  adminCreateWebhookEndpoint: superuserProcedure
    .input(
      z.object({
        partnerId: z.string().uuid(),
        url: z.string().url(),
        mode: z.enum(['test', 'live']),
        description: z.string().max(160).nullable().default(null),
        eventTypes: z
          .array(eventTypeSchema)
          .min(1)
          .default([
            'entitlement.granted',
            'entitlement.role_changed',
            'entitlement.suspended',
            'entitlement.reactivated',
            'entitlement.revoked',
          ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .insert(schema.partnerWebhookEndpoints)
        .values({
          partnerId: input.partnerId,
          url: input.url,
          mode: input.mode,
          description: input.description,
          eventTypes: input.eventTypes,
          signingSecret: mintWebhookSecret(),
        })
        .returning({
          id: schema.partnerWebhookEndpoints.id,
          signingSecret: schema.partnerWebhookEndpoints.signingSecret,
        });
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Falha ao criar webhook endpoint.',
        });
      }
      return row;
    }),

  adminToggleWebhookEndpoint: superuserProcedure
    .input(z.object({ id: z.string().uuid(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.partnerWebhookEndpoints)
        .set({ isActive: input.isActive })
        .where(eq(schema.partnerWebhookEndpoints.id, input.id));
      return { ok: true };
    }),

  adminListAllRoles: superuserProcedure
    .input(z.object({ partnerId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.partnerRoles.id,
          slug: schema.partnerRoles.slug,
          displayName: schema.partnerRoles.displayName,
          description: schema.partnerRoles.description,
          sortOrder: schema.partnerRoles.sortOrder,
          createdAt: schema.partnerRoles.createdAt,
        })
        .from(schema.partnerRoles)
        .where(eq(schema.partnerRoles.partnerId, input.partnerId))
        .orderBy(asc(schema.partnerRoles.sortOrder), asc(schema.partnerRoles.slug));
      return rows;
    }),

  adminCreateRole: superuserProcedure
    .input(
      z.object({
        partnerId: z.string().uuid(),
        slug: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/),
        displayName: z.string().trim().min(1).max(120),
        description: z.string().max(280).nullable().default(null),
        sortOrder: z.number().int().min(0).max(9999).default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const [row] = await ctx.services.db.db
          .insert(schema.partnerRoles)
          .values(input)
          .returning({ id: schema.partnerRoles.id });
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Falha ao criar role.',
          });
        }
        return { id: row.id };
      } catch (cause) {
        if ((cause as { code?: string }).code === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Slug já em uso para este partner.',
          });
        }
        throw cause;
      }
    }),

  adminDeleteRole: superuserProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .delete(schema.partnerRoles)
        .where(eq(schema.partnerRoles.id, input.id));
      return { ok: true };
    }),

  /**
   * Recent delivery log for a partner — used by the admin dashboard
   * to debug webhook integrations. Returns the latest 50 deliveries
   * across all endpoints of the partner, joined with the parent event
   * type + endpoint URL.
   */
  adminListDeliveries: superuserProcedure
    .input(
      z.object({
        partnerId: z.string().uuid(),
        status: z.enum(['pending', 'delivered', 'failed', 'dead_letter']).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const baseWhere = eq(schema.connectEvents.partnerId, input.partnerId);
      const whereExpr = input.status
        ? and(baseWhere, eq(schema.connectWebhookDeliveries.status, input.status))
        : baseWhere;
      const rows = await ctx.services.db.db
        .select({
          deliveryId: schema.connectWebhookDeliveries.id,
          eventType: schema.connectEvents.type,
          endpointUrl: schema.partnerWebhookEndpoints.url,
          status: schema.connectWebhookDeliveries.status,
          attempts: schema.connectWebhookDeliveries.attempts,
          lastResponseStatus: schema.connectWebhookDeliveries.lastResponseStatus,
          deliveredAt: schema.connectWebhookDeliveries.deliveredAt,
          nextAttemptAt: schema.connectWebhookDeliveries.nextAttemptAt,
          createdAt: schema.connectWebhookDeliveries.createdAt,
        })
        .from(schema.connectWebhookDeliveries)
        .innerJoin(
          schema.connectEvents,
          eq(schema.connectEvents.id, schema.connectWebhookDeliveries.eventId),
        )
        .innerJoin(
          schema.partnerWebhookEndpoints,
          eq(schema.partnerWebhookEndpoints.id, schema.connectWebhookDeliveries.endpointId),
        )
        .where(whereExpr)
        .orderBy(desc(schema.connectWebhookDeliveries.createdAt))
        .limit(50);
      return rows;
    }),

  adminRetryDelivery: superuserProcedure
    .input(z.object({ deliveryId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Reset to pending + due-now so the next sweep picks it up.
      await ctx.services.db.db
        .update(schema.connectWebhookDeliveries)
        .set({
          status: 'pending',
          nextAttemptAt: new Date(),
        })
        .where(eq(schema.connectWebhookDeliveries.id, input.deliveryId));
      return { ok: true };
    }),
});

// Avoid "no exported member" tree-shake removal:
void sql; // keeps drizzle's sql import alive if future helpers need it
