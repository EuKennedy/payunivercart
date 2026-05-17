import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, router } from '../trpc';

/**
 * Workspace-discovery procedures. These run on `authedProcedure`
 * (not `workspaceProcedure`) because they are the very thing the
 * dashboard calls to LEARN which workspace the user belongs to —
 * requiring a tenant context here would be circular.
 *
 * Both procedures join `memberships` against `workspaces` to surface
 * the workspace's human-readable name and slug in a single round-trip.
 * Ordering is by `acceptedAt` (membership creation, when set) so the
 * "first" workspace returned is the one the user joined first — the
 * dashboard's default selection when no header is sent.
 */

const MembershipRow = z.object({
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(['owner', 'admin', 'editor', 'viewer']),
  joinedAt: z.date(),
});

const RoleEnum = z.enum(['owner', 'admin', 'editor', 'viewer']);

const joinedAtExpr = sql<Date>`coalesce(${schema.memberships.acceptedAt}, ${schema.memberships.createdAt})`;

export const workspaceRouter = router({
  /**
   * All workspaces the current user is a member of. Drives the sidebar
   * switcher. Returns `[]` if the user has no memberships (shouldn't
   * happen post-Block-19, but defensively handled by the dashboard).
   */
  list: authedProcedure.output(z.array(MembershipRow)).query(async ({ ctx }) => {
    const rows = await ctx.services.db.db
      .select({
        workspaceId: schema.memberships.workspaceId,
        role: schema.memberships.role,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        joinedAt: joinedAtExpr,
      })
      .from(schema.memberships)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
      .where(eq(schema.memberships.userId, ctx.userId))
      .orderBy(asc(joinedAtExpr));

    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      slug: r.slug,
      role: r.role,
      joinedAt: r.joinedAt,
    }));
  }),

  /**
   * Current workspace + role. Resolves to the `X-Workspace-Id` header
   * when set and valid for this user; otherwise the oldest membership.
   * Used by the dashboard to render the active workspace + role-gate
   * destructive UI.
   */
  me: authedProcedure
    .output(
      z.object({
        workspace: z.object({
          id: z.string().uuid(),
          name: z.string(),
          slug: z.string(),
        }),
        role: RoleEnum,
      }),
    )
    .query(async ({ ctx }) => {
      const headerWs = ctx.honoCtx.req.header('x-workspace-id') ?? null;

      const rows = await ctx.services.db.db
        .select({
          workspaceId: schema.memberships.workspaceId,
          role: schema.memberships.role,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
        })
        .from(schema.memberships)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
        .where(eq(schema.memberships.userId, ctx.userId))
        .orderBy(asc(joinedAtExpr));

      if (rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'No workspace membership for this user',
        });
      }

      const selected = headerWs ? rows.find((r) => r.workspaceId === headerWs) : rows[0];
      if (!selected) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'User is not a member of the requested workspace',
        });
      }

      return {
        workspace: {
          id: selected.workspaceId,
          name: selected.name,
          slug: selected.slug,
        },
        role: selected.role,
      };
    }),
});
