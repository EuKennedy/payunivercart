import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
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

const CredentialsByProvider = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('meta'), credentials: MetaCredentialsInput }),
  z.object({ provider: z.literal('ga4'), credentials: Ga4CredentialsInput }),
  z.object({ provider: z.literal('tiktok'), credentials: TikTokCredentialsInput }),
  // Future providers slot in here once their adapter lands.
]);

/**
 * Extract the producer-visible "public id" of a credential blob. Each
 * provider names it differently (pixelId / measurementId / pixelCode);
 * this collapses that ambiguity for `tracking_pixels.publicPixelId`.
 */
function extractPublicPixelId(parsed: z.infer<typeof CredentialsByProvider>): string {
  switch (parsed.provider) {
    case 'meta':
      return parsed.credentials.pixelId;
    case 'ga4':
      return parsed.credentials.measurementId;
    case 'tiktok':
      return parsed.credentials.pixelCode;
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
        .where(eq(schema.trackingPixels.id, input.id));
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
          .where(eq(schema.trackingPixels.id, input.id));
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
});
