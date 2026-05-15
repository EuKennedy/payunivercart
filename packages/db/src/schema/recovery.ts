import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { carts } from './carts.js';
import { createdAt, fk, id, timestampTz, timestampTzNullable, updatedAt } from './common.js';
import { workspaces } from './workspaces.js';

export const recoveryChannelEnum = pgEnum('recovery_channel', ['whatsapp', 'email']);

export const recoveryCampaigns = pgTable(
  'recovery_campaigns',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    isActive: boolean().notNull().default(false),
    steps: jsonb().notNull().default([]),
    triggerWindowMinutes: integer().notNull().default(30),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('recovery_campaigns_workspace_name_unique').on(table.workspaceId, table.name),
    index('recovery_campaigns_workspace_idx').on(table.workspaceId),
  ],
);

export const recoveryAttempts = pgTable(
  'recovery_attempts',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cartId: fk()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    campaignId: fk()
      .notNull()
      .references(() => recoveryCampaigns.id, { onDelete: 'cascade' }),
    stepIndex: integer().notNull(),
    channel: recoveryChannelEnum().notNull(),
    targetIdentifier: text().notNull(),
    status: text().notNull().default('queued'),
    failureReason: text(),
    /** Required: every attempt is scheduled for a specific moment in the future. */
    scheduledFor: timestampTz(),
    sentAt: timestampTzNullable(),
    openedAt: timestampTzNullable(),
    clickedAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('recovery_attempts_cart_idx').on(table.cartId),
    index('recovery_attempts_workspace_status_idx').on(table.workspaceId, table.status),
    index('recovery_attempts_scheduled_idx').on(table.status, table.scheduledFor),
  ],
);
