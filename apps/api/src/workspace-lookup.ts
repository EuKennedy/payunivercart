import { provisionWorkspaceForUser, schema, type WorkspaceDb } from '@payunivercart/db';
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
 *   endpoint after the deploy. Idempotent: a user who already has a
 *   membership never enters the provision path.
 *
 *   Once orphan accounts are migrated, the heal branch becomes dead
 *   code. A later block can rip it out and replace with a hard
 *   `throw new TRPCError({ code: 'FORBIDDEN' })`.
 */

export interface WorkspaceListRow {
  workspaceId: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

const joinedAtExpr = sql`coalesce(${schema.memberships.acceptedAt}, ${schema.memberships.createdAt})`;

async function selectMemberships(db: WorkspaceDb, userId: string): Promise<WorkspaceListRow[]> {
  const rows = await db
    .select({
      workspaceId: schema.memberships.workspaceId,
      role: schema.memberships.role,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(joinedAtExpr));
  return rows;
}

/**
 * Look up the user's workspace memberships, provisioning one if the
 * user has none. Returns the membership list (always non-empty on
 * return; throws if even provisioning fails).
 */
export async function listOrProvisionMemberships(
  db: WorkspaceDb,
  userId: string,
): Promise<WorkspaceListRow[]> {
  const existing = await selectMemberships(db, userId);
  if (existing.length > 0) return existing;

  // Self-heal: pre-Block-19 user. Look up their auth row and provision.
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    // Caller's session.user.id pointed at a non-existent row. Treat as
    // unauthenticated and let the caller respond appropriately.
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

  await provisionWorkspaceForUser(db, {
    userId: user.id,
    email: user.email,
    name: user.name,
  });

  return selectMemberships(db, userId);
}
