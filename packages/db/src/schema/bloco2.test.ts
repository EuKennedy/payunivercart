import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { eventsAudit } from './audit.js';
import { accounts, sessions, verifications } from './auth.js';
import { carts } from './carts.js';
import { gatewayCredentials, integrations, whatsappChatIds } from './integrations.js';
import { orders } from './orders.js';
import { platformInvoices, platformSubscriptions } from './platform_billing.js';
import { productCategoryMappings, productCoupons } from './products.js';
import { recoveryAttempts } from './recovery.js';
import { refunds, transactions } from './transactions.js';
import {
  webhookEndpoints,
  webhookSignatureStateEnum,
  webhooksInbound,
  webhooksOutbox,
} from './webhooks.js';
import { memberships } from './workspaces.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const dialect = new PgDialect({ casing: 'snake_case' });

function whereSqlOf(idx: ReturnType<typeof getTableConfig>['indexes'][number]): string {
  if (!idx.config.where) return '';
  return dialect.sqlToQuery(idx.config.where).sql;
}

function colByName<T extends { columns: ReadonlyArray<{ name: string }> }>(
  cfg: T,
  name: string,
): T['columns'][number] | undefined {
  return cfg.columns.find((c) => c.name === name);
}

function fkByColumn(
  cfg: ReturnType<typeof getTableConfig>,
  columnName: string,
): { onDelete?: string | undefined } | undefined {
  return cfg.foreignKeys
    .map((fk) => {
      const ref = fk.reference();
      const colNames = ref.columns.map((c) => c.name);
      if (colNames.includes(columnName)) {
        return { onDelete: fk.onDelete };
      }
      return undefined;
    })
    .find((x) => x !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Event-timestamp sweep                                                      */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — event-occurrence timestamps must not default to now()', () => {
  const cases: Array<{ table: ReturnType<typeof getTableConfig>; columns: string[] }> = [
    { table: getTableConfig(carts), columns: ['abandonedAt', 'recoveredAt'] },
    { table: getTableConfig(orders), columns: ['paidAt', 'cancelledAt', 'expiresAt'] },
    {
      table: getTableConfig(transactions),
      columns: ['authorizedAt', 'paidAt', 'refundedAt', 'chargedbackAt', 'expiresAt'],
    },
    { table: getTableConfig(refunds), columns: ['completedAt'] },
    { table: getTableConfig(webhooksInbound), columns: ['processedAt'] },
    {
      table: getTableConfig(webhooksOutbox),
      columns: ['lastAttemptAt', 'nextAttemptAt', 'deliveredAt'],
    },
    {
      table: getTableConfig(recoveryAttempts),
      columns: ['sentAt', 'openedAt', 'clickedAt'],
    },
    { table: getTableConfig(memberships), columns: ['acceptedAt'] },
    { table: getTableConfig(integrations), columns: ['connectedAt'] },
    {
      table: getTableConfig(gatewayCredentials),
      columns: ['lastValidatedAt'],
    },
    { table: getTableConfig(productCoupons), columns: ['expiresAt'] },
    { table: getTableConfig(platformSubscriptions), columns: ['cancelledAt'] },
    { table: getTableConfig(platformInvoices), columns: ['paidAt'] },
    { table: getTableConfig(whatsappChatIds), columns: ['invalidatedAt'] },
  ];

  for (const { table, columns } of cases) {
    for (const colName of columns) {
      it(`${table.name}.${colName} has no DB default and is nullable`, () => {
        const col = colByName(table, colName);
        expect(col, `column missing: ${table.name}.${colName}`).toBeDefined();
        expect(col?.hasDefault).toBe(false);
        expect(col?.notNull).toBe(false);
      });
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Type corrections                                                            */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — type corrections', () => {
  it('webhooks_inbound.signature_valid is the new enum (not free-form text)', () => {
    const cfg = getTableConfig(webhooksInbound);
    const col = colByName(cfg, 'signatureValid');
    expect(col?.columnType).toBe('PgEnumColumn');
    expect(col?.enumValues).toEqual(['unknown', 'valid', 'invalid']);
    expect(webhookSignatureStateEnum.enumValues).toEqual(['unknown', 'valid', 'invalid']);
  });

  it('webhook_endpoints.is_active is a real boolean', () => {
    const cfg = getTableConfig(webhookEndpoints);
    const col = colByName(cfg, 'isActive');
    expect(col?.columnType).toBe('PgBoolean');
    expect(col?.notNull).toBe(true);
  });

  it('platform_subscriptions.cancel_at_period_end is a real boolean', () => {
    const cfg = getTableConfig(platformSubscriptions);
    const col = colByName(cfg, 'cancelAtPeriodEnd');
    expect(col?.columnType).toBe('PgBoolean');
    expect(col?.notNull).toBe(true);
  });

  it('gateway_credentials.credentials_encrypted is bytea', () => {
    const cfg = getTableConfig(gatewayCredentials);
    const col = colByName(cfg, 'credentialsEncrypted');
    expect(col?.notNull).toBe(true);
    // customType backed columns report the data type via getSQLType() — Drizzle
    // exposes it on the column instance.
    const sqlType = (col as unknown as { getSQLType?: () => string } | undefined)?.getSQLType?.();
    expect(sqlType).toBe('bytea');
  });

  it('gateway_credentials carries keyId and encVersion columns', () => {
    const cfg = getTableConfig(gatewayCredentials);
    const keyId = colByName(cfg, 'keyId');
    const encVersion = colByName(cfg, 'encVersion');
    expect(keyId?.notNull).toBe(true);
    expect(encVersion?.notNull).toBe(true);
    expect(encVersion?.hasDefault).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Partial / scoped unique constraints                                         */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — partial unique constraints', () => {
  it('carts_workspace_email_unique only enforces when customer_email IS NOT NULL', () => {
    const cfg = getTableConfig(carts);
    const idx = cfg.indexes.find((i) => i.config.name === 'carts_workspace_email_unique');
    expect(idx?.config.unique).toBe(true);
    if (!idx) return;
    const where = whereSqlOf(idx);
    expect(where).toContain('customer_email');
    expect(where).toMatch(/is not null/i);
  });

  it('transactions_gateway_charge_unique is scoped to workspace AND skips null charge ids', () => {
    const cfg = getTableConfig(transactions);
    const idx = cfg.indexes.find((i) => i.config.name === 'transactions_gateway_charge_unique');
    expect(idx?.config.unique).toBe(true);
    if (!idx) return;
    const colNames = idx.config.columns.map((c) => ('name' in c ? c.name : ''));
    expect(colNames).toEqual(['workspaceId', 'gatewayId', 'gatewayChargeId']);
    const where = whereSqlOf(idx);
    expect(where).toContain('gateway_charge_id');
    expect(where).toMatch(/is not null/i);
  });
});

/* -------------------------------------------------------------------------- */
/* FK onDelete sanity                                                          */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — events_audit FKs are RESTRICT', () => {
  it('events_audit.workspace_id has onDelete=restrict', () => {
    const cfg = getTableConfig(eventsAudit);
    expect(fkByColumn(cfg, 'workspaceId')?.onDelete).toBe('restrict');
  });
  it('events_audit.actor_user_id has onDelete=restrict', () => {
    const cfg = getTableConfig(eventsAudit);
    expect(fkByColumn(cfg, 'actorUserId')?.onDelete).toBe('restrict');
  });
});

/* -------------------------------------------------------------------------- */
/* product_category_mappings now carries workspaceId                            */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — product_category_mappings tenant scoping', () => {
  it('has workspace_id column with FK to workspaces and onDelete=cascade', () => {
    const cfg = getTableConfig(productCategoryMappings);
    const col = colByName(cfg, 'workspaceId');
    expect(col?.notNull).toBe(true);
    expect(fkByColumn(cfg, 'workspaceId')?.onDelete).toBe('cascade');
  });

  it('declares a CHECK constraint that workspaceId is NOT NULL (belt + braces)', () => {
    const cfg = getTableConfig(productCategoryMappings);
    const check = cfg.checks.find((c) => c.name === 'product_category_mappings_workspace_not_null');
    expect(check, 'check constraint must exist').toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* accounts.password CHECK                                                     */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — accounts.password must look like argon2id', () => {
  it('declares a CHECK constraint enforcing the $argon2id$ prefix when not null', () => {
    const cfg = getTableConfig(accounts);
    const check = cfg.checks.find((c) => c.name === 'accounts_password_argon2id_format');
    expect(check, 'CHECK constraint must exist on accounts.password').toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* updatedAt $onUpdate                                                          */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — updatedAt auto-refresh on UPDATE', () => {
  for (const cfg of [
    getTableConfig(orders),
    getTableConfig(transactions),
    getTableConfig(integrations),
    getTableConfig(gatewayCredentials),
  ]) {
    it(`${cfg.name}.updated_at has $onUpdate hook`, () => {
      const col = colByName(cfg, 'updatedAt');
      expect(col?.onUpdateFn, `${cfg.name}.updatedAt missing $onUpdate`).toBeDefined();
      // Verify the hook returns a Date.
      const result = (col?.onUpdateFn as (() => unknown) | undefined)?.();
      expect(result).toBeInstanceOf(Date);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Bloco 1 still holds                                                          */
/* -------------------------------------------------------------------------- */

describe('Bloco 2 — Bloco 1 invariants regression', () => {
  it('sessions.expires_at still has no default', () => {
    const col = colByName(getTableConfig(sessions), 'expiresAt');
    expect(col?.hasDefault).toBe(false);
    expect(col?.notNull).toBe(true);
  });

  it('verifications.expires_at still has no default', () => {
    const col = colByName(getTableConfig(verifications), 'expiresAt');
    expect(col?.hasDefault).toBe(false);
    expect(col?.notNull).toBe(true);
  });
});
