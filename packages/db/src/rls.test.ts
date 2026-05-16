import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PayunivercartError } from '@payunivercart/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { workspaceContextSql } from './rls';

const dialect = new PgDialect({ casing: 'snake_case' });
const VALID_UUID = '01935aa1-7b8c-7d80-9f01-a1b2c3d4e5f6';

/* -------------------------------------------------------------------------- */
/*  workspaceContextSql                                                       */
/* -------------------------------------------------------------------------- */

describe('workspaceContextSql', () => {
  it('renders a parameterized set_config statement (no string concat)', () => {
    const rendered = dialect.sqlToQuery(workspaceContextSql(VALID_UUID));
    expect(rendered.sql).toBe("SELECT set_config('app.workspace_id', $1, true)");
    expect(rendered.params).toEqual([VALID_UUID]);
  });

  it('does not inject the UUID into the SQL string itself', () => {
    const rendered = dialect.sqlToQuery(workspaceContextSql(VALID_UUID));
    expect(rendered.sql).not.toContain(VALID_UUID);
  });
});

/* -------------------------------------------------------------------------- */
/*  withWorkspace / setWorkspaceContext — UUID validation                      */
/* -------------------------------------------------------------------------- */

describe('UUID validation (defense before any SQL runs)', () => {
  // We exercise the validator by calling a tiny stand-in tx — the
  // validator runs before any tx call, so we don't need a real DB.
  // The error is thrown by `assertUuid` inside both `withWorkspace` and
  // `setWorkspaceContext`. We probe via dynamic import so the helper's
  // implementation detail (private function) is reachable.

  // Use `withWorkspace` with a stub `db` so we don't need Postgres.
  async function run(workspaceId: string) {
    const { withWorkspace } = await import('./rls.js');
    const stubDb = {
      // Drizzle's `transaction` returns whatever the callback returns;
      // the validator throws synchronously before the callback runs.
      transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    } as unknown as Parameters<typeof withWorkspace>[0];
    return withWorkspace(stubDb, workspaceId, async () => 'ok');
  }

  it('accepts a canonical UUID', async () => {
    // The stub `tx` does not actually run SQL; `setWorkspaceContext`
    // will call `tx.execute`, which is undefined on the stub. We mock
    // it inline so this happy-path test exercises validation only.
    const { withWorkspace } = await import('./rls.js');
    const stubDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
        fn({ execute: async () => undefined }),
    } as unknown as Parameters<typeof withWorkspace>[0];
    await expect(withWorkspace(stubDb, VALID_UUID, async () => 'ok')).resolves.toBe('ok');
  });

  it.each([
    ['empty string', ''],
    ['not a UUID', 'not-a-uuid'],
    ['contains semicolon (SQL injection attempt)', "'); DROP TABLE workspaces;--"],
    ['short UUID', '12345678-1234-1234-1234-1234567890'],
    ['uppercase UUID with wrong version', '01935AA1-7B8C-9D80-9F01-A1B2C3D4E5F6'],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrowError(PayunivercartError);
  });

  it('rejects non-string types at runtime', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard.
    await expect(run(123 as unknown as any)).rejects.toThrowError(PayunivercartError);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard.
    await expect(run(null as unknown as any)).rejects.toThrowError(PayunivercartError);
  });
});

/* -------------------------------------------------------------------------- */
/*  SQL file — surface-level lint                                              */
/* -------------------------------------------------------------------------- */

describe('packages/db/sql/02_rls_policies.sql', () => {
  it('enables AND forces RLS for every tenant table the schema declares', async () => {
    const sqlPath = join(__dirname, '..', 'sql', '02_rls_policies.sql');
    const contents = await readFile(sqlPath, 'utf-8');

    // Every tenant-scoped table referenced by `packages/db/src/schema`
    // must appear in the ALTER TABLE ... ENABLE / FORCE list below.
    // The list mirrors the audit `/hm-engineer` report — adding a new
    // tenant table without updating the SQL is a tenant-isolation bug
    // we want CI to catch.
    const tenantTables = [
      'organizations',
      'workspaces',
      'memberships',
      'integrations',
      'gateway_credentials',
      'whatsapp_sessions',
      'whatsapp_chat_ids',
      'products',
      'product_categories',
      'product_category_mappings',
      'product_offers',
      'product_coupons',
      'checkouts',
      'orders',
      'order_items',
      'transactions',
      'refunds',
      'carts',
      'recovery_campaigns',
      'recovery_attempts',
      'webhooks_inbound',
      'webhooks_outbox',
      'webhook_endpoints',
      'webhooks_inbound_gateway',
      'events_audit',
      'platform_subscriptions',
      'platform_invoices',
    ];

    for (const table of tenantTables) {
      // The bulk-enable loop emits both ENABLE and FORCE via `format`,
      // so we look for the literal entry in the array fed to that loop.
      expect(contents, `${table} missing from RLS enable list`).toContain(`'${table}'`);
    }
  });

  it('declares a workspace_isolation policy for every tenant table', async () => {
    const sqlPath = join(__dirname, '..', 'sql', '02_rls_policies.sql');
    const contents = await readFile(sqlPath, 'utf-8');

    // Explicit per-table policies (workspaces, organizations, *_inbound,
    // events_audit, order_items, refunds, webhooks_inbound_gateway).
    const explicitPolicyTables = [
      'organizations',
      'workspaces',
      'order_items',
      'refunds',
      'webhooks_inbound',
      'webhooks_inbound_gateway',
      'events_audit',
    ];
    for (const t of explicitPolicyTables) {
      expect(contents).toMatch(new RegExp(`CREATE POLICY workspace_isolation ON public\\.${t}`));
    }

    // Bulk-policy tables (asserted via inclusion in the second loop's
    // ARRAY) — workspace_id-direct tables.
    const bulkPolicyTables = [
      'memberships',
      'integrations',
      'gateway_credentials',
      'whatsapp_sessions',
      'whatsapp_chat_ids',
      'products',
      'product_categories',
      'product_category_mappings',
      'product_offers',
      'product_coupons',
      'checkouts',
      'orders',
      'transactions',
      'carts',
      'recovery_campaigns',
      'recovery_attempts',
      'webhooks_outbox',
      'webhook_endpoints',
      'platform_subscriptions',
      'platform_invoices',
    ];
    for (const t of bulkPolicyTables) {
      expect(contents).toContain(`'${t}'`);
    }
  });

  it('declares the current_workspace_id() helper as STABLE PARALLEL SAFE', async () => {
    const sqlPath = join(__dirname, '..', 'sql', '02_rls_policies.sql');
    const contents = await readFile(sqlPath, 'utf-8');
    expect(contents).toMatch(/CREATE OR REPLACE FUNCTION public\.current_workspace_id\(\)/);
    expect(contents).toContain('STABLE');
    expect(contents).toContain('PARALLEL SAFE');
  });

  it('uses parameterized `current_setting(...)` rather than hardcoded ids', async () => {
    const sqlPath = join(__dirname, '..', 'sql', '02_rls_policies.sql');
    const contents = await readFile(sqlPath, 'utf-8');
    expect(contents).toContain("current_setting('app.workspace_id', true)");
  });
});
