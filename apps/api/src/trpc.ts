import { TRPCError, initTRPC } from '@trpc/server';
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
   * run without tenant context (auth login, health). Procedures that
   * need RLS pass this to `withWorkspace(...)`.
   */
  workspaceId: string | null;
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
 * Workspace-scoped procedure — guarantees BOTH `ctx.userId` AND
 * `ctx.workspaceId` are non-null, AND that the user is a member of the
 * workspace. Membership check moves here once we wire the DB query.
 */
export const workspaceProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace context required (missing X-Workspace-Id header)',
    });
  }
  return next({ ctx: { ...ctx, workspaceId: ctx.workspaceId } });
});
