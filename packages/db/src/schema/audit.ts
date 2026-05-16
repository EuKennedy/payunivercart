import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { createdAt, fk, id } from './common';
import { workspaces } from './workspaces';

/**
 * Append-only audit log. `previousHash` makes the chain tamper-evident; the
 * background verifier walks the chain and alerts on mismatches.
 *
 * `workspaceId` and `actorUserId` use `onDelete: 'restrict'` so the audit
 * row is never silently disconnected from its subject. A workspace or user
 * with audit rows MUST be soft-deleted (via `deleted_at`) — hard delete is
 * rejected at the FK level. This protects both the integrity of the hash
 * chain (the FK changing would invalidate every downstream `previousHash`)
 * and LGPD/SOX obligations to keep the trail traversable.
 *
 * Direct `UPDATE`/`DELETE` on this table is additionally blocked at the
 * Postgres level via a migration that revokes those permissions and
 * installs a trigger; see `packages/audit` for the writer service.
 */
export const eventsAudit = pgTable(
  'events_audit',
  {
    id: id(),
    workspaceId: fk().references(() => workspaces.id, { onDelete: 'restrict' }),
    actorUserId: fk().references(() => users.id, { onDelete: 'restrict' }),
    actorIp: text(),
    actorUserAgent: text(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text(),
    diff: jsonb(),
    metadata: jsonb().notNull().default({}),
    /** Hex of the previous row's `hash`. NULL only for the genesis row. */
    previousHash: text(),
    /** Hex SHA-256 HMAC over `previous_hash || canonical(payload)`. */
    hash: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('events_audit_workspace_idx').on(table.workspaceId),
    index('events_audit_resource_idx').on(table.resourceType, table.resourceId),
    index('events_audit_action_idx').on(table.action),
    // The chain is linear per workspace; (workspace, created_at) is the
    // natural traversal key. Indexed for the verifier.
    index('events_audit_workspace_time_idx').on(table.workspaceId, table.createdAt),
    // No two rows may share the same hash within a workspace — uniqueness of
    // hashes prevents accidental duplicates and makes chain verification
    // cheap (collision = tampering or a bug in the writer).
    uniqueIndex('events_audit_hash_unique').on(table.hash),
  ],
);
