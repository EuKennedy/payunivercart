import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, router } from '../trpc';
import { listOrProvisionMemberships } from '../workspace-lookup';

/**
 * Workspace-discovery procedures. These run on `authedProcedure`
 * (not `workspaceProcedure`) because they are the very thing the
 * dashboard calls to LEARN which workspace the user belongs to —
 * requiring a tenant context here would be circular.
 *
 * Both procedures delegate to `listOrProvisionMemberships` which
 * self-heals pre-Block-19 users on the spot. See the module's docblock
 * for rationale.
 */

const MembershipRow = z.object({
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(['owner', 'admin', 'editor', 'viewer']),
});

const RoleEnum = z.enum(['owner', 'admin', 'editor', 'viewer']);

export const workspaceRouter = router({
  /**
   * All workspaces the current user is a member of. Drives the sidebar
   * switcher.
   */
  list: authedProcedure.output(z.array(MembershipRow)).query(async ({ ctx }) => {
    return listOrProvisionMemberships(ctx.services.db.db, ctx.userId);
  }),

  /**
   * Current workspace + role. Resolves to the `X-Workspace-Id` header
   * when set and valid for this user; otherwise the oldest membership.
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
      const rows = await listOrProvisionMemberships(ctx.services.db.db, ctx.userId);
      if (rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'No workspace membership for this user',
        });
      }
      const headerWs = ctx.honoCtx.req.header('x-workspace-id') ?? null;
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
