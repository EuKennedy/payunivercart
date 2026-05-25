import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAdapter, isProviderSupported } from '../tracking/providers';
import type { TrackingProvider } from '../tracking/types';
import { router, workspaceProcedure } from '../trpc';

/**
 * Producer-facing tracking-pixel management. Symmetric to
 * `gateways.ts`: list / upsert / test / setDefault / remove.
 *
 * Security model mirrors gateway credentials:
 *   - Credentials blob NEVER leaves the api in plaintext; sealed via
 *     CryptoService on the way in, decrypted only inside the dispatcher
 *     (PR 4 of Pilar 2).
 *   - `list` returns ONLY public fields; access tokens stay in the row.
 *   - Per-provider Zod schemas keep the validation tight.
 *
 * Pilar 2 PR 3/4 status: list + upsert + test + setDefault + remove.
 * The dispatcher + queue wiring lands in PR 4/4.
 */

const Provider = z.enum(['meta', 'google_ads', 'ga4', 'tiktok', 'pinterest', 'kwai']);

const MetaCredentialsInput = z.object({
  pixelId: z.string().trim().min(8).max(64),
  accessToken: z.string().trim().min(40).max(512),
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

const Ga4CredentialsInput = z.object({
  // Same regex as the adapter; mirrored here to fail fast on the API
  // boundary before we ever hit the adapter.
  measurementId: z
    .string()
    .trim()
    .regex(/^G-[A-Z0-9]{6,12}$/i, 'Use o formato G-XXXXXXXX.'),
  apiSecret: z.string().trim().min(8).max(256),
});

const TikTokCredentialsInput = z.object({
  pixelCode: z.string().trim().min(8).max(64),
  accessToken: z.string().trim().min(20).max(512),
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

const GoogleAdsCredentialsInput = z.object({
  customerId: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Customer ID: 10 dígitos sem hífen.'),
  conversionActionId: z
    .string()
    .trim()
    .regex(/^\d{6,12}$/),
  oauthRefreshToken: z.string().trim().min(40).max(512),
  oauthClientId: z.string().trim().min(20).max(160),
  oauthClientSecret: z.string().trim().min(20).max(160),
  developerToken: z.string().trim().min(10).max(60),
  loginCustomerId: z
    .string()
    .trim()
    .regex(/^\d{10}$/)
    .optional(),
});

const PinterestCredentialsInput = z.object({
  adAccountId: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/),
  conversionToken: z.string().trim().min(40).max(512),
  tagId: z.string().trim().min(8).max(64),
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

const KwaiCredentialsInput = z.object({
  pixelId: z.string().trim().min(8).max(64),
  accessToken: z.string().trim().min(20).max(512),
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

const CredentialsByProvider = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('meta'), credentials: MetaCredentialsInput }),
  z.object({ provider: z.literal('ga4'), credentials: Ga4CredentialsInput }),
  z.object({ provider: z.literal('tiktok'), credentials: TikTokCredentialsInput }),
  z.object({ provider: z.literal('google_ads'), credentials: GoogleAdsCredentialsInput }),
  z.object({ provider: z.literal('pinterest'), credentials: PinterestCredentialsInput }),
  z.object({ provider: z.literal('kwai'), credentials: KwaiCredentialsInput }),
]);

/**
 * Extract the producer-visible "public id" of a credential blob. Each
 * provider names it differently (pixelId / measurementId / pixelCode
 * / customerId / adAccountId); this collapses that ambiguity for the
 * `tracking_pixels.publicPixelId` column.
 */
function extractPublicPixelId(parsed: z.infer<typeof CredentialsByProvider>): string {
  switch (parsed.provider) {
    case 'meta':
      return parsed.credentials.pixelId;
    case 'ga4':
      return parsed.credentials.measurementId;
    case 'tiktok':
      return parsed.credentials.pixelCode;
    case 'google_ads':
      // Customer id is the "account-facing" identifier; the conversion
      // action id is per-event and lives inside the credentials blob.
      return parsed.credentials.customerId;
    case 'pinterest':
      // Tag id is what the producer sees in Pinterest Ads Manager UI;
      // ad account id is the API-side address.
      return parsed.credentials.tagId;
    case 'kwai':
      return parsed.credentials.pixelId;
  }
}

const PublicRow = z.object({
  id: z.string().uuid(),
  provider: Provider,
  label: z.string(),
  publicPixelId: z.string(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  testMode: z.boolean(),
  eventsEnabled: z.record(z.string(), z.boolean()),
  lastValidatedAt: z.date().nullable(),
  lastErrorMessage: z.string().nullable(),
  createdAt: z.date(),
});

export const trackingRouter = router({
  /**
   * List the workspace's saved tracking pixels. Secrets are NEVER returned.
   */
  list: workspaceProcedure.output(z.array(PublicRow)).query(async ({ ctx }) => {
    const rows = await ctx.services.db.db
      .select({
        id: schema.trackingPixels.id,
        provider: schema.trackingPixels.provider,
        label: schema.trackingPixels.label,
        publicPixelId: schema.trackingPixels.publicPixelId,
        isDefault: schema.trackingPixels.isDefault,
        enabled: schema.trackingPixels.enabled,
        testMode: schema.trackingPixels.testMode,
        eventsEnabled: schema.trackingPixels.eventsEnabled,
        lastValidatedAt: schema.trackingPixels.lastValidatedAt,
        lastErrorMessage: schema.trackingPixels.lastErrorMessage,
        createdAt: schema.trackingPixels.createdAt,
      })
      .from(schema.trackingPixels)
      .where(
        and(
          eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
          isNull(schema.trackingPixels.deletedAt),
        ),
      )
      .orderBy(schema.trackingPixels.createdAt);
    return rows.map((r) => ({
      ...r,
      provider: r.provider as TrackingProvider,
      eventsEnabled: r.eventsEnabled ?? {},
    }));
  }),

  /**
   * Create or replace a tracking pixel for the workspace.
   *
   * - Validates the credentials shape against the provider's Zod schema.
   * - Optionally calls `adapter.test(...)` so the producer learns
   *   immediately if their key is wrong, instead of at the next event.
   * - Encrypts with CryptoService and stores the sealed blob.
   * - When `isDefault: true`, clears every other row of the same
   *   provider/workspace so the dispatcher always picks a unique
   *   default.
   */
  upsert: workspaceProcedure
    .input(
      z
        .object({
          id: z.string().uuid().optional(),
          label: z.string().trim().min(1).max(120),
          isDefault: z.boolean().default(true),
          enabled: z.boolean().default(true),
          testMode: z.boolean().default(false),
          eventsEnabled: z.record(z.string(), z.boolean()).optional(),
          validateBeforeSave: z.boolean().default(true),
        })
        .and(CredentialsByProvider),
    )
    .output(z.object({ id: z.string().uuid(), validated: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!isProviderSupported(input.provider)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Provedor ${input.provider} ainda não está disponível.`,
        });
      }
      const adapter = getAdapter(input.provider);
      const parsed = adapter.parseCredentials(input.credentials);

      let validated = false;
      let lastError: string | null = null;
      if (input.validateBeforeSave) {
        const test = await adapter.test(parsed, {
          publicPixelId: extractPublicPixelId(input),
          testMode: input.testMode,
        });
        validated = test.ok;
        lastError = test.errorMessage;
        if (!validated) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              lastError ?? 'Não conseguimos validar o pixel — confira o access token e o pixel id.',
          });
        }
      }

      const { blob: sealed, keyId } = ctx.services.crypto.sealJson(
        parsed as Record<string, unknown>,
      );

      const now = new Date();
      return ctx.services.db.db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(schema.trackingPixels)
            .set({ isDefault: false })
            .where(
              and(
                eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
                eq(schema.trackingPixels.provider, input.provider),
              ),
            );
        }

        if (input.id) {
          await tx
            .update(schema.trackingPixels)
            .set({
              label: input.label,
              publicPixelId: extractPublicPixelId(input),
              credentialsEncrypted: sealed,
              keyId,
              encVersion: 1,
              isDefault: input.isDefault,
              enabled: input.enabled,
              testMode: input.testMode,
              eventsEnabled: input.eventsEnabled ?? {},
              lastValidatedAt: validated ? now : null,
              lastErrorMessage: validated ? null : lastError,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.trackingPixels.id, input.id),
                eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
              ),
            );
          return { id: input.id, validated };
        }

        const [row] = await tx
          .insert(schema.trackingPixels)
          .values({
            workspaceId: ctx.workspaceId,
            provider: input.provider,
            label: input.label,
            publicPixelId: extractPublicPixelId(input),
            credentialsEncrypted: sealed,
            keyId,
            encVersion: 1,
            isDefault: input.isDefault,
            enabled: input.enabled,
            testMode: input.testMode,
            eventsEnabled: input.eventsEnabled ?? {},
            lastValidatedAt: validated ? now : null,
            lastErrorMessage: validated ? null : lastError,
          })
          .returning({ id: schema.trackingPixels.id });
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Falha ao salvar pixel.',
          });
        }
        return { id: row.id, validated };
      });
    }),

  /**
   * Re-validate stored credentials. Useful after the producer rotated
   * tokens server-side. Refreshes `lastValidatedAt` + `lastErrorMessage`.
   */
  test: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.boolean(), error: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          provider: schema.trackingPixels.provider,
          publicPixelId: schema.trackingPixels.publicPixelId,
          testMode: schema.trackingPixels.testMode,
          credentialsEncrypted: schema.trackingPixels.credentialsEncrypted,
        })
        .from(schema.trackingPixels)
        .where(
          and(
            eq(schema.trackingPixels.id, input.id),
            eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pixel não encontrado.' });
      }
      const adapter = getAdapter(row.provider as TrackingProvider);
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<Record<string, unknown>>(row.credentialsEncrypted),
      );
      const result = await adapter.test(credentials, {
        publicPixelId: row.publicPixelId,
        testMode: row.testMode,
      });
      const now = new Date();
      await ctx.services.db.db
        .update(schema.trackingPixels)
        .set({
          lastValidatedAt: result.ok ? now : null,
          lastErrorMessage: result.ok ? null : result.errorMessage,
          updatedAt: now,
        })
        // Defense-in-depth: the SELECT above already confirmed ownership,
        // but the UPDATE keeps the workspaceId predicate so a future
        // refactor (or RLS toggle) can never leak this write across
        // tenants.
        .where(
          and(
            eq(schema.trackingPixels.id, input.id),
            eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: result.ok, error: result.errorMessage };
    }),

  setDefault: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const [pixel] = await ctx.services.db.db
        .select({ provider: schema.trackingPixels.provider })
        .from(schema.trackingPixels)
        .where(
          and(
            eq(schema.trackingPixels.id, input.id),
            eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!pixel) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pixel não encontrado.' });
      }
      await ctx.services.db.db.transaction(async (tx) => {
        await tx
          .update(schema.trackingPixels)
          .set({ isDefault: false })
          .where(
            and(
              eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
              eq(schema.trackingPixels.provider, pixel.provider),
            ),
          );
        await tx
          .update(schema.trackingPixels)
          .set({ isDefault: true })
          // Defense-in-depth: same rationale as `test` above — keep the
          // workspaceId predicate even after the SELECT confirmed
          // ownership.
          .where(
            and(
              eq(schema.trackingPixels.id, input.id),
              eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
            ),
          );
      });
      return { ok: true as const };
    }),

  remove: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      // Soft delete — dispatch ledger holds a FK; keeping the row lets
      // the producer audit historical dispatches even after they
      // remove the pixel from the UI.
      await ctx.services.db.db
        .update(schema.trackingPixels)
        .set({ deletedAt: new Date(), enabled: false, isDefault: false })
        .where(
          and(
            eq(schema.trackingPixels.id, input.id),
            eq(schema.trackingPixels.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /**
   * Dispatch ledger view. Producer-facing query for the "Eventos" tab.
   * Filters by status / provider / event type. Pagination via keyset
   * cursor (createdAt|id) — stable across replicas, no offset trauma.
   *
   * Response intentionally STRIPS the full payload + provider response
   * blobs by default — they can be 5-8 KB each and the dispatcher
   * already truncates them. We return summary fields the producer
   * needs for the table view; a future detail endpoint can pull the
   * full row by id when the producer drills in.
   */
  listEvents: workspaceProcedure
    .input(
      z
        .object({
          status: z.enum(['pending', 'sent', 'failed', 'dropped']).optional(),
          provider: z.enum(['meta', 'ga4', 'tiktok', 'google_ads', 'pinterest', 'kwai']).optional(),
          eventType: z
            .enum([
              'page_view',
              'view_content',
              'add_to_cart',
              'initiate_checkout',
              'add_payment_info',
              'purchase',
              'subscribe',
              'subscription_renew',
              'lead',
              'complete_registration',
            ])
            .optional(),
          pixelId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string().uuid(),
            pixelId: z.string().uuid(),
            pixelLabel: z.string(),
            provider: z.enum(['meta', 'ga4', 'tiktok', 'google_ads', 'pinterest', 'kwai']),
            eventType: z.string(),
            sourceType: z.string(),
            sourceId: z.string(),
            providerEventId: z.string().nullable(),
            status: z.enum(['pending', 'sent', 'failed', 'dropped']),
            httpStatus: z.number().int().nullable(),
            attemptCount: z.number().int().nonnegative(),
            lastError: z.string().nullable(),
            sentAt: z.date().nullable(),
            createdAt: z.date(),
          }),
        ),
        totals: z.object({
          sent: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          pending: z.number().int().nonnegative(),
          dropped: z.number().int().nonnegative(),
        }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;

      // Filters that scope BOTH the row list and the per-status totals
      // (provider, eventType, pixelId). Status is intentionally
      // separated — it's the column the totals group by, so applying
      // it would zero out every other bucket.
      const scopeFilters = and(
        eq(schema.trackingDispatches.workspaceId, ctx.workspaceId),
        input?.eventType ? eq(schema.trackingDispatches.eventType, input.eventType) : undefined,
        input?.pixelId ? eq(schema.trackingDispatches.pixelId, input.pixelId) : undefined,
        input?.provider ? eq(schema.trackingPixels.provider, input.provider) : undefined,
      );

      const where = input?.status
        ? and(scopeFilters, eq(schema.trackingDispatches.status, input.status))
        : scopeFilters;

      const rows = await ctx.services.db.db
        .select({
          id: schema.trackingDispatches.id,
          pixelId: schema.trackingDispatches.pixelId,
          pixelLabel: schema.trackingPixels.label,
          provider: schema.trackingPixels.provider,
          eventType: schema.trackingDispatches.eventType,
          sourceType: schema.trackingDispatches.sourceType,
          sourceId: schema.trackingDispatches.sourceId,
          providerEventId: schema.trackingDispatches.providerEventId,
          status: schema.trackingDispatches.status,
          httpStatus: schema.trackingDispatches.httpStatus,
          attemptCount: schema.trackingDispatches.attemptCount,
          lastError: schema.trackingDispatches.lastError,
          sentAt: schema.trackingDispatches.sentAt,
          createdAt: schema.trackingDispatches.createdAt,
        })
        .from(schema.trackingDispatches)
        .innerJoin(
          schema.trackingPixels,
          eq(schema.trackingPixels.id, schema.trackingDispatches.pixelId),
        )
        .where(where)
        .orderBy(desc(schema.trackingDispatches.createdAt))
        .limit(limit);

      // Per-status totals now mirror the *visible* slice: the producer
      // filtering by Meta + AddToCart sees the Meta/AddToCart counts in
      // the status pills, not the noisy workspace-wide totals. We join
      // tracking_pixels only when the provider filter is set (saves a
      // join on the hot, unfiltered case).
      const totalsQueryBuilder = ctx.services.db.db
        .select({
          status: schema.trackingDispatches.status,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.trackingDispatches);
      const totalsQuery = input?.provider
        ? totalsQueryBuilder.innerJoin(
            schema.trackingPixels,
            eq(schema.trackingPixels.id, schema.trackingDispatches.pixelId),
          )
        : totalsQueryBuilder;
      const totalRows = await totalsQuery
        .where(scopeFilters)
        .groupBy(schema.trackingDispatches.status);
      const totals = { sent: 0, failed: 0, pending: 0, dropped: 0 };
      for (const t of totalRows) {
        if (t.status in totals) {
          totals[t.status as keyof typeof totals] = Number(t.n ?? 0);
        }
      }

      return {
        items: rows.map((r) => ({
          ...r,
          provider: r.provider as 'meta' | 'ga4' | 'tiktok' | 'google_ads' | 'pinterest' | 'kwai',
          status: r.status as 'pending' | 'sent' | 'failed' | 'dropped',
        })),
        totals,
      };
    }),
});
