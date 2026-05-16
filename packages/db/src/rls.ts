import { PayunivercartError } from '@payunivercart/shared';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm/relations';
import type * as schema from './schema/index';

/**
 * Row-Level Security plumbing for `apps/api` and any Drizzle caller that
 * touches tenant-scoped tables.
 *
 * The contract (see `packages/db/sql/02_rls_policies.sql`):
 *
 *   - Every tenant table has a policy that checks
 *     `workspace_id = current_setting('app.workspace_id')::uuid`.
 *   - The `app` Postgres role has RLS forced; it cannot read across
 *     tenants regardless of what queries it issues.
 *   - Callers MUST set the variable per-transaction with
 *     `SET LOCAL app.workspace_id = '<uuid>'`. Without it,
 *     `current_setting` returns NULL, the policy fails, and every
 *     tenant query returns zero rows.
 *
 * This module gives callers two helpers:
 *
 *   - `setWorkspaceContext(tx, workspaceId)` — for code that already
 *     opened its own transaction (e.g. nested business logic).
 *   - `withWorkspace(db, workspaceId, fn)` — opens a transaction, sets
 *     the context, runs the callback, commits/rolls back. The common
 *     entry point.
 *
 * Both validate `workspaceId` is a UUID before issuing SQL. The variable
 * is set via `set_config('app.workspace_id', $1, true)` with a real
 * parameter so we never concatenate user input into the statement.
 */

type SchemaWithRelations = ExtractTablesWithRelations<typeof schema>;

/** Type of the transaction object produced by `db.transaction(...)`. */
export type WorkspaceTx = PgTransaction<PgQueryResultHKT, typeof schema, SchemaWithRelations>;

/** Minimal subset of the Drizzle DB needed by `withWorkspace`. */
export type WorkspaceDb = PgDatabase<PgQueryResultHKT, typeof schema, SchemaWithRelations>;

/** RFC 4122 UUID (any version). Reject anything else BEFORE issuing SQL. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a database transaction with the workspace context set
 * for the duration of that transaction. The context is scoped via
 * `SET LOCAL`, so a commit or rollback drops it automatically — there is
 * no way for the value to leak to a subsequent query on the same
 * connection.
 *
 * The callback receives the Drizzle transaction object. Pass it to your
 * repository functions instead of `db` so every query inside the
 * callback sees the policy in effect.
 */
export async function withWorkspace<T>(
  db: WorkspaceDb,
  workspaceId: string,
  fn: (tx: WorkspaceTx) => Promise<T>,
): Promise<T> {
  assertUuid(workspaceId);
  return db.transaction(async (tx) => {
    await setWorkspaceContext(tx, workspaceId);
    return fn(tx);
  });
}

/**
 * Imperatively set the workspace context on an existing transaction.
 * Useful when the caller already opened the transaction (e.g. to bundle
 * audit appends with business writes).
 */
export async function setWorkspaceContext(tx: WorkspaceTx, workspaceId: string): Promise<void> {
  assertUuid(workspaceId);
  // `set_config(name, value, is_local)` is parameter-safe. `is_local =
  // true` makes the value transaction-scoped, identical to `SET LOCAL`.
  await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
}

/**
 * Clear the workspace context on the current transaction. Rarely needed
 * — committing or rolling back the transaction does the same thing —
 * but useful for tests that share a transaction across cases.
 */
export async function clearWorkspaceContext(tx: WorkspaceTx): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.workspace_id', '', true)`);
}

function assertUuid(workspaceId: unknown): asserts workspaceId is string {
  if (typeof workspaceId !== 'string' || !UUID_REGEX.test(workspaceId)) {
    throw new PayunivercartError({
      code: 'VALIDATION',
      message: 'workspaceId must be a UUID',
      details: { received: typeof workspaceId === 'string' ? workspaceId : typeof workspaceId },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  SQL fragments — exported for unit-testing the SQL we render               */
/* -------------------------------------------------------------------------- */

/**
 * Render the SQL fragment that `setWorkspaceContext` would issue, for
 * tests that want to inspect the statement without a database. Wraps the
 * Drizzle `sql` template so callers can pipe it through `PgDialect`.
 */
export function workspaceContextSql(workspaceId: string): ReturnType<typeof sql> {
  return sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}
