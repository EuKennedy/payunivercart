import { boolean, index, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, fk, gatewayIdEnum, id, updatedAt } from './common.js';
import { workspaces } from './workspaces.js';

export const integrationKindEnum = pgEnum('integration_kind', [
  'gateway',
  'whatsapp',
  'email',
  'webhook',
  'tracking',
]);

export const integrationStatusEnum = pgEnum('integration_status', [
  'pending',
  'connected',
  'failed',
  'disconnected',
]);

/**
 * Generic integrations table. Specific tables below give us typed columns for
 * the most common cases (gateway credentials, WhatsApp sessions).
 */
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: integrationKindEnum().notNull(),
    provider: text().notNull(),
    status: integrationStatusEnum().notNull().default('pending'),
    metadata: jsonb().notNull().default({}),
    lastError: text(),
    connectedAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('integrations_workspace_kind_provider_unique').on(
      table.workspaceId,
      table.kind,
      table.provider,
    ),
    index('integrations_workspace_idx').on(table.workspaceId),
  ],
);

/**
 * Encrypted gateway credentials. The `credentialsEncrypted` blob is a
 * libsodium sealed-box (master key from ENCRYPTION_KEY env var).
 */
export const gatewayCredentials = pgTable(
  'gateway_credentials',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    gatewayId: gatewayIdEnum().notNull(),
    label: text().notNull(),
    isDefault: boolean().notNull().default(false),
    isSandbox: boolean().notNull().default(false),
    credentialsEncrypted: text().notNull(),
    publicMetadata: jsonb().notNull().default({}),
    lastValidatedAt: createdAt(),
    validationError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('gateway_credentials_default_unique').on(
      table.workspaceId,
      table.gatewayId,
      table.isDefault,
    ),
    index('gateway_credentials_workspace_idx').on(table.workspaceId),
  ],
);

/**
 * WhatsApp session tracked per workspace. One WAHA session per workspace.
 */
export const whatsappSessions = pgTable(
  'whatsapp_sessions',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    wahaSessionId: text().notNull(),
    phoneNumber: text(),
    status: text().notNull().default('STARTING'),
    qrLastIssuedAt: createdAt(),
    connectedAt: createdAt(),
    disconnectedAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('whatsapp_sessions_waha_id_unique').on(table.wahaSessionId),
    uniqueIndex('whatsapp_sessions_workspace_unique').on(table.workspaceId),
  ],
);

/** Cache of resolved chatIds, augments Redis cache for durability. */
export const whatsappChatIds = pgTable(
  'whatsapp_chat_ids',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    e164: text().notNull(),
    chatId: text().notNull(),
    resolvedAt: createdAt(),
    invalidatedAt: createdAt(),
  },
  (table) => [
    uniqueIndex('whatsapp_chat_ids_workspace_e164_unique').on(table.workspaceId, table.e164),
  ],
);
