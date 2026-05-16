import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { sessions, verifications } from './auth';
import { gatewayCredentials } from './integrations';

/**
 * Drizzle stores columns by their JS-side camelCase name and resolves the
 * snake_case SQL name at runtime. Internally `column.default` is the SQL
 * default expression; `column.hasDefault` is the boolean flag we rely on.
 *
 * Index predicates (partial unique indexes) live on `index.config.where`,
 * which is a `SQL` object built from `queryChunks: StringChunk[]`. The
 * `StringChunk.value` is a string array we concatenate to inspect the SQL.
 */
function whereClauseOf(idx: ReturnType<typeof getTableConfig>['indexes'][number]): string {
  const where = idx.config.where;
  if (!where) return '';
  const chunks = (where as unknown as { queryChunks: Array<{ value?: unknown }> }).queryChunks;
  return chunks
    .map((c) => {
      const v = c.value;
      if (Array.isArray(v)) return v.join('');
      return typeof v === 'string' ? v : '';
    })
    .join('');
}

describe('schema regression — Bloco 1 críticos', () => {
  it('sessions.expiresAt has no default (must be set explicitly by the app)', () => {
    const config = getTableConfig(sessions);
    const col = config.columns.find((c) => c.name === 'expiresAt');
    expect(col, 'sessions.expiresAt column must exist').toBeDefined();
    expect(col?.default, 'sessions.expiresAt must NOT have a DB default').toBeUndefined();
    expect(col?.hasDefault, 'sessions.expiresAt must not be flagged hasDefault').toBe(false);
    expect(col?.notNull).toBe(true);
  });

  it('verifications.expiresAt has no default', () => {
    const config = getTableConfig(verifications);
    const col = config.columns.find((c) => c.name === 'expiresAt');
    expect(col?.hasDefault).toBe(false);
    expect(col?.notNull).toBe(true);
  });

  it('gateway_credentials_default_unique is a partial unique index (WHERE is_default = true)', () => {
    const config = getTableConfig(gatewayCredentials);
    const index = config.indexes.find(
      (i) => i.config.name === 'gateway_credentials_default_unique',
    );
    expect(index, 'expected named unique index to exist').toBeDefined();
    if (!index) return;

    expect(index.config.unique).toBe(true);

    const whereSql = whereClauseOf(index);
    expect(whereSql, 'index must carry a WHERE clause for partial uniqueness').not.toBe('');
    expect(whereSql).toContain('is_default');
    expect(whereSql).toMatch(/=\s*true/);
  });

  it('gateway_credentials partial unique renders the exact SQL Postgres will see', () => {
    // Render the index's WHERE clause through the real Drizzle PgDialect so
    // we are testing what actually gets emitted into the migration, not
    // just the in-memory description.
    const config = getTableConfig(gatewayCredentials);
    const index = config.indexes.find(
      (i) => i.config.name === 'gateway_credentials_default_unique',
    );
    expect(index?.config.where).toBeDefined();
    if (!index?.config.where) return;

    const dialect = new PgDialect({ casing: 'snake_case' });
    const rendered = dialect.sqlToQuery(index.config.where);
    expect(rendered.sql).toBe('is_default = true');
    expect(rendered.params).toEqual([]);
  });
});
