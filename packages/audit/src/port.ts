/**
 * Port interface decoupling the audit service from any specific DB driver.
 *
 * The production implementation (lands with `apps/api`) is backed by Drizzle
 * + Postgres and acquires a per-workspace `pg_advisory_xact_lock` before
 * reading the chain head to serialize concurrent appends. The test
 * implementation (`InMemoryAuditPort` in `service.test.ts`) uses an array
 * plus a mutex.
 *
 * Every method MUST execute inside the caller-supplied transaction; the
 * port itself does not start transactions. This lets the caller bundle
 * an audit append with the business write it describes, so an audit row
 * either both lands with its subject change or neither does.
 */

export interface AuditRowInsert {
  workspaceId: string | null;
  actorUserId: string | null;
  actorIp: string | null;
  actorUserAgent: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  diff: unknown;
  metadata: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
}

export interface AuditRow extends AuditRowInsert {
  id: string;
  createdAt: Date;
}

export interface AuditPort {
  /**
   * Run `fn` inside a transaction with a per-workspace advisory lock held
   * for the duration. The lock key MUST be derived deterministically from
   * `workspaceId` (or a sentinel for `null` / system events).
   */
  withChainLock<T>(workspaceId: string | null, fn: (tx: AuditTx) => Promise<T>): Promise<T>;
}

export interface AuditTx {
  /** Most recent `hash` for the given workspace (or `null` if no rows yet). */
  getLatestHash(workspaceId: string | null): Promise<string | null>;
  /** Append a row exactly as supplied — no mutation, no augmentation. */
  insertRow(row: AuditRowInsert): Promise<AuditRow>;
  /**
   * Yield every row for `workspaceId` ordered by `createdAt` ASC, optionally
   * starting from `since`. Used by the verifier; do NOT batch into memory
   * — the chain can grow arbitrarily large.
   */
  listRows(workspaceId: string | null, since?: Date): AsyncIterable<AuditRow>;
}
