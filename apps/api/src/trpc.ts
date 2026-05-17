import { schema } from '@payunivercart/db';
import { TRPCError, initTRPC } from '@trpc/server';
import { asc, eq, sql } from 'drizzle-orm';
import type { Context as HonoContext } from 'hono';
import { ZodError } from 'zod';
import type { AppServices } from './services';

/**
 * Per-request context. The Hono adapter calls `createContext` for every
 * RPC call and we hand the request-scoped values to procedures via
 * `ctx`.
 */
export interface TrpcContext {
  services: AppServices;
  /** Hono request — needed to read headers/cookies for auth. */
  honoCtx: HonoContext;
  /**
   * Workspace id (UUID) bound to this request. `null` for endpoints that
   * run without tenant context (auth login, health). Set by
   * `workspaceProcedure` from the user's memberships, optionally
   * honoring an `X-Workspace-Id` header to pick among multiple.
   */
  workspaceId: string | null;
  /** Role of the current user in `workspaceId`. Mirrors `workspaceId`. */
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  /** Better-Auth user id when the request is authenticated, else null. */
  userId: string | null;
}

const t = initTRPC.context<TrpcContext>().create({
  errorFormatter({ shape, error }) {
    // Surface Zod issues so clients can show field-level errors.
    if (error.cause instanceof ZodError) {
      return {
        ...shape,
        data: { ...shape.data, zodIssues: error.cause.issues },
      };
    }
    return shape;
  },
});

export const router = t.router;

/**
 * Public procedure — runs without an authenticated user. Use only for
 * health checks, public checkout endpoints, and webhooks.
 */
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure — guarantees `ctx.userId` is non-null.
 */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

/**
 * Workspace-scoped procedure — resolves `ctx.workspaceId` and `ctx.role`
 * from the user's memberships table.
 *
 * Resolution order:
 *   1. If `X-Workspace-Id` header is present AND the user is a member of
 *      that workspace, use it.
 *   2. Otherwise, pick the oldest membership by `joined_at` (the
 *      `acceptedAt` column when set, falling back to `createdAt`).
 *   3. If the user has zero memberships, throw FORBIDDEN — this should
 *      never happen because signup auto-provisions a workspace, but a
 *      manually-deleted membership row would land here.
 */
export const workspaceProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const { db } = ctx.services;
  const headerWs = ctx.honoCtx.req.header('x-workspace-id') ?? null;

  const rows = await db.db
    .select({
      workspaceId: schema.memberships.workspaceId,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, ctx.userId))
    .orderBy(
      asc(sql`coalesce(${schema.memberships.acceptedAt}, ${schema.memberships.createdAt})`),
    );

  if (rows.length === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'No workspace membership for this user',
    });
  }

  const selected = headerWs
    ? rows.find((r) => r.workspaceId === headerWs)
    : rows[0];

  if (!selected) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'User is not a member of the requested workspace',
    });
  }

  return next({
    ctx: {
      ...ctx,
      workspaceId: selected.workspaceId,
      role: selected.role,
    },
  });
});
