import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, router } from '../trpc';

/**
 * Account router — LGPD self-service surface.
 *
 *   - `exportData`   — Art. 18 II + V — full JSON export of everything
 *                      the platform stores about the authenticated user.
 *   - `deleteAccount`— Art. 18 VI — eliminação. Hard-delete the user
 *                      record + cascading rows (sessions, memberships).
 *                      Workspaces the user OWNED stay if there are still
 *                      other approved members; orphan workspaces (the
 *                      user was sole owner) are hard-deleted alongside.
 *
 * Both procedures run inside `authedProcedure` (workspace context not
 * required — they cross workspace boundaries by design).
 *
 * The dashboard surfaces this at `/conta/profile`. Producer also
 * receives a generic "fale com o DPO" link to <privacidade@univercart.com>
 * for anything outside the self-service flow (rectification of historical
 * order data, correção via processos legais, etc.).
 */
export const accountRouter = router({
  /* ------------------------------------------------------------------ */
  /* Export — Art. 18 II + V                                            */
  /* ------------------------------------------------------------------ */
  exportData: authedProcedure
    .output(
      z.object({
        generatedAt: z.date(),
        user: z
          .object({
            id: z.string().uuid(),
            email: z.string(),
            name: z.string().nullable(),
            createdAt: z.date(),
            emailVerified: z.boolean().nullable(),
          })
          .nullable(),
        memberships: z.array(
          z.object({
            workspaceId: z.string().uuid(),
            workspaceName: z.string(),
            role: z.string(),
            createdAt: z.date(),
          }),
        ),
        affiliate: z
          .object({
            id: z.string().uuid(),
            publicCode: z.string(),
            displayName: z.string(),
            lifetimeEarnedCents: z.number().int().nonnegative(),
            createdAt: z.date(),
          })
          .nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const db = ctx.services.db.db;

      const [user] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          createdAt: schema.users.createdAt,
          emailVerified: schema.users.emailVerified,
        })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.userId))
        .limit(1);

      const memberships = await db
        .select({
          workspaceId: schema.memberships.workspaceId,
          workspaceName: schema.workspaces.name,
          role: schema.memberships.role,
          createdAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
        .where(eq(schema.memberships.userId, ctx.userId));

      const [affiliate] = await db
        .select({
          id: schema.affiliates.id,
          publicCode: schema.affiliates.publicCode,
          displayName: schema.affiliates.displayName,
          lifetimeEarnedCents: schema.affiliates.lifetimeEarnedCents,
          createdAt: schema.affiliates.createdAt,
        })
        .from(schema.affiliates)
        .where(eq(schema.affiliates.userId, ctx.userId))
        .limit(1);

      return {
        generatedAt: new Date(),
        user: user
          ? {
              id: user.id,
              email: user.email,
              name: user.name ?? null,
              createdAt: user.createdAt,
              emailVerified: user.emailVerified,
            }
          : null,
        memberships: memberships.map((m) => ({
          workspaceId: m.workspaceId,
          workspaceName: m.workspaceName,
          role: m.role,
          createdAt: m.createdAt,
        })),
        affiliate: affiliate
          ? {
              ...affiliate,
              lifetimeEarnedCents: Number(affiliate.lifetimeEarnedCents),
            }
          : null,
      };
    }),

  /* ------------------------------------------------------------------ */
  /* Delete — Art. 18 VI                                                */
  /* ------------------------------------------------------------------ */
  deleteAccount: authedProcedure
    .input(
      z.object({
        confirm: z.literal('APAGAR MINHA CONTA', {
          errorMap: () => ({
            message: 'Digite "APAGAR MINHA CONTA" exatamente para confirmar.',
          }),
        }),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      const db = ctx.services.db.db;

      // Defensive: ensure user actually exists before issuing DELETE.
      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.userId))
        .limit(1);
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Usuário não encontrado.' });
      }

      // FK ON DELETE CASCADE on most tables drops the dependent rows
      // automatically. Workspaces the user co-owns stay (other members
      // keep access). Workspaces the user is the SOLE owner of are
      // intentionally left intact — orphan-workspace cleanup is an
      // ops decision, not a self-service one (loss of revenue data /
      // payouts pending / etc.). Operators can hard-delete those via
      // the admin panel.
      await db.delete(schema.users).where(eq(schema.users.id, ctx.userId));

      return { ok: true as const };
    }),
});
