import { schema, withWorkspace } from '@payunivercart/db';
import {
  getAdapter,
  mercadoPagoCredentialsSchema,
  pagSeguroCredentialsSchema,
  pagarmeCredentialsSchema,
  stripeCredentialsSchema,
} from '@payunivercart/payments';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Payment-gateway credential management. Producer-facing tRPC surface
 * for storing the MP / Pagar.me / PagSeguro / Stripe secrets we'll use
 * to charge buyers on the producer's behalf.
 *
 * Security model:
 *   - The `credentials` blob NEVER leaves the api process in plaintext.
 *     It's encrypted with the workspace-aware CryptoService (AES-256-GCM
 *     with rotating KEKs) before the INSERT, and decrypted only inside
 *     `checkout.createOrder` + the webhook receiver.
 *   - `gateways.list` returns ONLY non-sensitive fields (label, gatewayId,
 *     isSandbox, isDefault, lastValidatedAt). Secrets stay in the row.
 *   - Each gateway exposes its own credentials Zod schema; we validate
 *     the shape before encryption so a misconfigured save can't sit in
 *     the DB until checkout time.
 */

const GatewayId = z.enum(['mercadopago', 'pagarme', 'pagseguro', 'stripe']);

const CredentialsByGateway = z.discriminatedUnion('gatewayId', [
  z.object({ gatewayId: z.literal('mercadopago'), credentials: mercadoPagoCredentialsSchema }),
  z.object({ gatewayId: z.literal('pagarme'), credentials: pagarmeCredentialsSchema }),
  z.object({ gatewayId: z.literal('pagseguro'), credentials: pagSeguroCredentialsSchema }),
  z.object({ gatewayId: z.literal('stripe'), credentials: stripeCredentialsSchema }),
]);

const PublicRow = z.object({
  id: z.string().uuid(),
  gatewayId: GatewayId,
  label: z.string(),
  isDefault: z.boolean(),
  isSandbox: z.boolean(),
  lastValidatedAt: z.date().nullable(),
  validationError: z.string().nullable(),
  createdAt: z.date(),
});

export const gatewaysRouter = router({
  /**
   * List the workspace's saved gateways. Secrets are NEVER returned.
   */
  list: workspaceProcedure.output(z.array(PublicRow)).query(async ({ ctx }) => {
    const rows = await ctx.services.db.db
      .select({
        id: schema.gatewayCredentials.id,
        gatewayId: schema.gatewayCredentials.gatewayId,
        label: schema.gatewayCredentials.label,
        isDefault: schema.gatewayCredentials.isDefault,
        isSandbox: schema.gatewayCredentials.isSandbox,
        lastValidatedAt: schema.gatewayCredentials.lastValidatedAt,
        validationError: schema.gatewayCredentials.validationError,
        createdAt: schema.gatewayCredentials.createdAt,
      })
      .from(schema.gatewayCredentials)
      .where(eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId))
      .orderBy(schema.gatewayCredentials.createdAt);
    return rows;
  }),

  /**
   * Create or replace a gateway credential row for the workspace.
   *
   * - Validates credentials shape against the gateway's Zod schema.
   * - Optionally calls `adapter.validateCredentials(...)` so the
   *   producer learns immediately if their key is wrong, instead of at
   *   the next buyer's checkout.
   * - Encrypts with CryptoService and stores the sealed blob.
   * - When `isDefault === true`, demotes every other gateway of the
   *   same `gatewayId` in this workspace inside the same tx.
   */
  upsert: workspaceProcedure
    .input(
      z
        .object({
          label: z.string().trim().min(1).max(80),
          isDefault: z.boolean().default(true),
          isSandbox: z.boolean().default(false),
          /** When true, refuse the save if the gateway rejects the creds. */
          validateBeforeSave: z.boolean().default(true),
        })
        .and(CredentialsByGateway),
    )
    .output(z.object({ id: z.string().uuid(), validated: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const adapter = getAdapter(input.gatewayId);

      let validated = false;
      let validationError: string | null = null;
      if (input.validateBeforeSave) {
        try {
          await adapter.validateCredentials(input.credentials);
          validated = true;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          validationError = message;
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Credenciais ${input.gatewayId} rejeitadas pelo gateway: ${message}`,
            cause,
          });
        }
      }

      const sealed = ctx.services.crypto.sealJson(input.credentials);

      const result = await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        // Real upsert: if a credential already exists for this
        // (workspace, gateway, sandbox) tuple we update it in place.
        // Without this we'd accumulate one row per save attempt and the
        // dashboard would have to babysit the `is_default` flag to keep
        // charges firing on the right credential.
        const [existing] = await tx
          .select({
            id: schema.gatewayCredentials.id,
            isDefault: schema.gatewayCredentials.isDefault,
          })
          .from(schema.gatewayCredentials)
          .where(
            and(
              eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
              eq(schema.gatewayCredentials.gatewayId, input.gatewayId),
              eq(schema.gatewayCredentials.isSandbox, input.isSandbox),
            ),
          )
          .limit(1);

        // Auto-default: when the workspace has zero credentials for this
        // gateway (regardless of sandbox), the first one wired up always
        // becomes the default. Prevents the producer from saving a
        // credential and then watching every checkout fail because they
        // forgot to tick a checkbox.
        const [anyForGateway] = await tx
          .select({ count: schema.gatewayCredentials.id })
          .from(schema.gatewayCredentials)
          .where(
            and(
              eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
              eq(schema.gatewayCredentials.gatewayId, input.gatewayId),
            ),
          )
          .limit(1);
        const shouldDefault = input.isDefault || (!anyForGateway && !existing);

        // Demote other rows for the same gatewayId only if we're about to
        // promote this one. The partial unique index `default_unique`
        // requires exactly zero or one default per (workspace, gateway).
        if (shouldDefault) {
          await tx
            .update(schema.gatewayCredentials)
            .set({ isDefault: false })
            .where(
              and(
                eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
                eq(schema.gatewayCredentials.gatewayId, input.gatewayId),
              ),
            );
        }

        if (existing) {
          const [updated] = await tx
            .update(schema.gatewayCredentials)
            .set({
              label: input.label,
              isDefault: shouldDefault,
              credentialsEncrypted: sealed.blob,
              keyId: sealed.keyId,
              encVersion: 'v1',
              lastValidatedAt: validated ? new Date() : null,
              validationError,
              updatedAt: new Date(),
            })
            .where(eq(schema.gatewayCredentials.id, existing.id))
            .returning({ id: schema.gatewayCredentials.id });
          if (!updated) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'gateway_credentials update returned no row',
            });
          }
          return updated;
        }

        const [row] = await tx
          .insert(schema.gatewayCredentials)
          .values({
            workspaceId: ctx.workspaceId,
            gatewayId: input.gatewayId,
            label: input.label,
            isDefault: shouldDefault,
            isSandbox: input.isSandbox,
            credentialsEncrypted: sealed.blob,
            keyId: sealed.keyId,
            encVersion: 'v1',
            lastValidatedAt: validated ? new Date() : null,
            validationError,
          })
          .returning({ id: schema.gatewayCredentials.id });

        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'gateway_credentials insert returned no row',
          });
        }
        return row;
      });

      return { id: result.id, validated };
    }),

  /**
   * Mark a specific gateway row as default for its gatewayId. Demotes
   * every other row for the same (workspace, gatewayId) inside one tx.
   */
  setDefault: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        const [target] = await tx
          .select({ gatewayId: schema.gatewayCredentials.gatewayId })
          .from(schema.gatewayCredentials)
          .where(
            and(
              eq(schema.gatewayCredentials.id, input.id),
              eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
            ),
          )
          .limit(1);
        if (!target) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway não encontrado.' });
        }
        await tx
          .update(schema.gatewayCredentials)
          .set({ isDefault: false })
          .where(
            and(
              eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
              eq(schema.gatewayCredentials.gatewayId, target.gatewayId),
            ),
          );
        await tx
          .update(schema.gatewayCredentials)
          .set({ isDefault: true })
          .where(
            and(
              eq(schema.gatewayCredentials.id, input.id),
              eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
            ),
          );
      });
      return { ok: true as const };
    }),

  /**
   * Flip the `isSandbox` flag on a single gateway credential. Useful
   * when the producer mistakenly saved a production account as
   * sandbox (or vice versa). Does NOT re-validate or touch the
   * encrypted credentials — only the env flag.
   */
  setSandboxFlag: workspaceProcedure
    .input(z.object({ id: z.string().uuid(), isSandbox: z.boolean() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.gatewayCredentials)
        .set({ isSandbox: input.isSandbox, updatedAt: new Date() })
        .where(
          and(
            eq(schema.gatewayCredentials.id, input.id),
            eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /**
   * Re-validate stored credentials by hitting the gateway's auth check.
   * Updates `lastValidatedAt` / `validationError` on success/failure.
   */
  test: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.boolean(), message: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          id: schema.gatewayCredentials.id,
          gatewayId: schema.gatewayCredentials.gatewayId,
          credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
        })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.id, input.id),
            eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway não encontrado.' });
      }

      const adapter = getAdapter(row.gatewayId);
      const credentials = ctx.services.crypto.unsealJson<Record<string, unknown>>(
        row.credentialsEncrypted,
      );

      try {
        await adapter.validateCredentials(adapter.parseCredentials(credentials));
        await ctx.services.db.db
          .update(schema.gatewayCredentials)
          .set({ lastValidatedAt: new Date(), validationError: null })
          .where(eq(schema.gatewayCredentials.id, row.id));
        return { ok: true, message: null };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await ctx.services.db.db
          .update(schema.gatewayCredentials)
          .set({ validationError: message })
          .where(eq(schema.gatewayCredentials.id, row.id));
        return { ok: false, message };
      }
    }),

  /**
   * Hard-delete a gateway credential. The producer can re-add it
   * afterward — we don't retain encrypted secrets after deletion.
   */
  remove: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .delete(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.id, input.id),
            eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),
});
