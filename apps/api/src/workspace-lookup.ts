import {
  type WorkspaceDb,
  type WorkspaceTx,
  provisionWorkspaceInTx,
  schema,
} from '@payunivercart/db';
import { asc, eq, sql } from 'drizzle-orm';

/**
 * Single source of truth for "fetch the user's workspaces, healing
 * orphan rows on the fly".
 *
 * Why heal here?
 *   Better-Auth's `databaseHooks.user.create.after` (the canonical
 *   provisioning path) only fires for users created post-Block-19.
 *   Any account that existed before this code landed (e.g. the founder's
 *   own test account) has zero memberships and would crash on every
 *   workspace-scoped request. Healing on the membership-lookup path
 *   migrates those accounts the first time they hit any authenticated
 *   endpoint after the deploy.
 *
 *   Once orphan accounts are migrated, the heal branch becomes dead
 *   code. A later block can rip it out and replace with a hard
 *   `throw new TRPCError({ code: 'FORBIDDEN' })`.
 *
 * Race serialization
 *   Two concurrent requests for the same orphan user previously both
 *   passed the empty-memberships check and each provisioned its own
 *   workspace — the user ended up owning two phantom workspaces. We now
 *   take a `pg_advisory_xact_lock` keyed on the user id at the start of
 *   the transaction, so the second concurrent caller blocks until the
 *   first one's transaction commits. By the time the lock is released
 *   the membership row exists and the second caller's check returns it
 *   instead of re-provisioning.
 */

export interface WorkspaceListRow {
  workspaceId: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  /** Customer-facing brand name. NULL when the producer hasn't filled
   *  in Configurações → Marca yet; UI falls back to `name`. */
  companyName: string | null;
  /** True when the workspace has uploaded a brand logo. UI uses this
   *  to decide between `<img src="/img/workspace/:id/logo">` and the
   *  initial-letter placeholder in the sidebar switcher. */
  hasLogo: boolean;
}

const joinedAtExpr = sql`coalesce(${schema.memberships.acceptedAt}, ${schema.memberships.createdAt})`;

async function selectMemberships(
  qb: WorkspaceDb | WorkspaceTx,
  userId: string,
): Promise<WorkspaceListRow[]> {
  const rows = await qb
    .select({
      workspaceId: schema.memberships.workspaceId,
      role: schema.memberships.role,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
      companyName: schema.workspaces.companyName,
      brandLogoMime: schema.workspaces.brandLogoMime,
    })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(joinedAtExpr));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    role: r.role,
    name: r.name,
    slug: r.slug,
    companyName: r.companyName ?? null,
    // The logo bytes column is mirrored on `brand_logo_mime` — present
    // iff a logo was uploaded. We use the MIME presence as the boolean
    // signal so we don't have to ship the bytea over the wire for what
    // is ultimately a UI render hint.
    hasLogo: r.brandLogoMime != null,
  }));
}

/**
 * Look up the user's workspace memberships, provisioning one if the
 * user has none. Returns the membership list (always non-empty on
 * return; throws if even provisioning fails or returns [] when the
 * userId points at a non-existent user).
 */
export async function listOrProvisionMemberships(
  db: WorkspaceDb,
  userId: string,
): Promise<WorkspaceListRow[]> {
  // Fast path: the user already has memberships. We check OUTSIDE the
  // transaction so the steady-state read path doesn't pay for the lock
  // — the lock+provision branch only fires for orphans.
  const existing = await selectMemberships(db, userId);
  if (existing.length > 0) return existing;

  return db.transaction(async (tx) => {
    // Serialize concurrent self-heal attempts for the same user. The
    // lock is scoped to this transaction; commit or rollback releases
    // it. `hashtext` collapses the UUID string to int4 for the
    // pg_advisory_xact_lock(int4) variant — collisions across different
    // userIds would just mean unrelated requests serialize, never a
    // correctness issue.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    // Re-check inside the lock — the other contender may have already
    // provisioned by the time we acquired it.
    const recheck = await selectMemberships(tx, userId);
    if (recheck.length > 0) return recheck;

    const [user] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      // Caller's session.user.id pointed at a non-existent row. Return
      // empty and let the caller decide on 401/403.
      return [];
    }

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        event: 'workspace.lookup.selfHeal',
        userId: user.id,
        email: user.email,
      })}\n`,
    );

    await provisionWorkspaceInTx(tx, {
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    return selectMemberships(tx, userId);
  });
}
