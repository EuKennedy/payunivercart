import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, fk, id } from './common.js';
import { workspaces } from './workspaces.js';

/**
 * Append-only audit log. `previousHash` makes the chain tamper-evident; the
 * background verifier walks the chain and alerts on mismatches.
 */
export const eventsAudit = pgTable(
  'events_audit',
  {
    id: id(),
    workspaceId: fk().references(() => workspaces.id, { onDelete: 'set null' }),
    actorUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    actorIp: text(),
    actorUserAgent: text(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text(),
    diff: jsonb(),
    metadata: jsonb().notNull().default({}),
    previousHash: text(),
    hash: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('events_audit_workspace_idx').on(table.workspaceId),
    index('events_audit_resource_idx').on(table.resourceType, table.resourceId),
    index('events_audit_action_idx').on(table.action),
  ],
);
