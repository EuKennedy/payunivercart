import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, gatewayIdEnum, id, timestampTzNullable, updatedAt } from './common';
import { workspaces } from './workspaces';

/**
 * Postgres `bytea` mapped to `Uint8Array`. Used for sealed-box ciphertext
 * payloads so we don't pay the 33% base64 storage overhead and we don't
 * accidentally hand a string to a primitive that expects bytes.
 */
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

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
    /** Set when the OAuth/credential handshake completes. */
    connectedAt: timestampTzNullable(),
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
    index('integrations_status_idx').on(table.workspaceId, table.status),
  ],
);

/**
 * Encrypted gateway credentials. The `credentialsEncrypted` blob is a
 * libsodium sealed-box; the master key (KEK) is keyed by `keyId` and the
 * encryption scheme is identified by `encVersion`. Both columns are
 * required so we can rotate the master key without losing the ability to
 * decrypt rows written under the previous key version.
 *
 * The blob is stored as `bytea` rather than text so we never accidentally
 * round-trip ciphertext through base64 conversions and lose the binary
 * representation.
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
    /** Sealed-box ciphertext. NEVER a JSON string. NEVER plaintext. */
    credentialsEncrypted: bytea().notNull(),
    /** KEK identifier — matches an entry in `packages/crypto`'s key registry. */
    keyId: text().notNull(),
    /** Encryption scheme version. Bump on algorithm/parameter change. */
    encVersion: text().notNull().default('v1'),
    publicMetadata: jsonb().notNull().default({}),
    /** Last time we successfully called the gateway's auth endpoint. */
    lastValidatedAt: timestampTzNullable(),
    validationError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Partial unique index: at most ONE row with is_default=true per
    // (workspace_id, gateway_id). A regular composite unique on isDefault
    // would not work — multiple `false` rows would all share the same key.
    uniqueIndex('gateway_credentials_default_unique')
      .on(table.workspaceId, table.gatewayId)
      .where(sql`is_default = true`),
    index('gateway_credentials_workspace_idx').on(table.workspaceId),
    // Defense-in-depth: reject obviously-empty ciphertexts at the DB level
    // (the writer must always produce a non-empty sealed box). The full
    // `sb:v1:` prefix invariant is enforced by `packages/crypto` and a more
    // specific CHECK is added in the migration that ships with this schema.
    check('gateway_credentials_encrypted_not_empty', sql`octet_length(credentials_encrypted) > 0`),
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
    /** Set each time we render a fresh QR for pairing. */
    qrLastIssuedAt: timestampTzNullable(),
    connectedAt: timestampTzNullable(),
    disconnectedAt: timestampTzNullable(),
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
    /** Set when WAHA reports the chatId no longer exists; cache miss next read. */
    invalidatedAt: timestampTzNullable(),
  },
  (table) => [
    uniqueIndex('whatsapp_chat_ids_workspace_e164_unique').on(table.workspaceId, table.e164),
    index('whatsapp_chat_ids_workspace_idx').on(table.workspaceId),
  ],
);
