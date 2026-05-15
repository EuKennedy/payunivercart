import { canonicalize } from './canonical.js';
import { AuditError } from './errors.js';
import { computeChainHash, hashesEqual } from './hash.js';
import type { AuditPort, AuditRow, AuditRowInsert } from './port.js';

/**
 * High-level audit log writer + verifier. Every change touching money or
 * tenant boundaries should go through this service.
 *
 *   - `append` writes one row, computing its `hash` from `previousHash`
 *     and a canonical serialization of the payload. The port guarantees
 *     per-workspace serialization via an advisory lock so two concurrent
 *     appends cannot fork the chain.
 *
 *   - `verify` walks the workspace's rows in `createdAt` order and
 *     re-derives each hash. Any mismatch surfaces as a typed AuditError;
 *     a tamper that flips, removes, or reorders a row is detected
 *     because every subsequent row's hash incorporates the previous one.
 *
 * The service holds no DB connection itself — every operation runs inside
 * the caller-supplied transaction via the `AuditPort.withChainLock`
 * callback. This lets `apps/api` bundle audit + business write atomically.
 */

export interface AppendInput {
  workspaceId?: string | null;
  actorUserId?: string | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  diff?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AppendResult {
  id: string;
  hash: string;
  previousHash: string | null;
  createdAt: Date;
}

export interface VerifyOptions {
  workspaceId: string | null;
  since?: Date;
}

export interface VerifyOk {
  ok: true;
  rowsVerified: number;
  workspaceId: string | null;
}

export interface VerifyFail {
  ok: false;
  rowsVerified: number;
  workspaceId: string | null;
  /** The row whose `hash` (or `previousHash` link) did not validate. */
  brokenRowId: string;
  reason: 'hash_mismatch' | 'previous_hash_mismatch' | 'genesis_violation';
}
export type VerifyReport = VerifyOk | VerifyFail;

export interface AuditServiceConfig {
  port: AuditPort;
  key: Uint8Array;
}

export class AuditService {
  private readonly port: AuditPort;
  private readonly key: Uint8Array;

  constructor(config: AuditServiceConfig) {
    this.port = config.port;
    this.key = config.key;
  }

  async append(input: AppendInput): Promise<AppendResult> {
    assertNonEmpty('action', input.action);
    assertNonEmpty('resourceType', input.resourceType);

    const workspaceId = input.workspaceId ?? null;
    return this.port.withChainLock(workspaceId, async (tx) => {
      const previousHash = await tx.getLatestHash(workspaceId);
      const insert: AuditRowInsert = {
        workspaceId,
        actorUserId: input.actorUserId ?? null,
        actorIp: input.actorIp ?? null,
        actorUserAgent: input.actorUserAgent ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        diff: input.diff ?? null,
        metadata: input.metadata ?? {},
        previousHash,
        hash: this.hashOf(previousHash, payloadFor(input, workspaceId)),
      };
      const row = await tx.insertRow(insert);
      return {
        id: row.id,
        hash: row.hash,
        previousHash: row.previousHash,
        createdAt: row.createdAt,
      };
    });
  }

  async verify(opts: VerifyOptions): Promise<VerifyReport> {
    return this.port.withChainLock(opts.workspaceId, async (tx) => {
      let previousHash: string | null = null;
      let rowsVerified = 0;

      for await (const row of tx.listRows(opts.workspaceId, opts.since)) {
        // 1. Genesis: very first row in the workspace must declare prev=null.
        //    Continuation rows must declare prev = previous row's hash.
        const expectedPrev = rowsVerified === 0 ? null : previousHash;
        if (!previousHashMatches(row.previousHash, expectedPrev)) {
          return {
            ok: false as const,
            rowsVerified,
            workspaceId: opts.workspaceId,
            brokenRowId: row.id,
            reason:
              rowsVerified === 0
                ? ('genesis_violation' as const)
                : ('previous_hash_mismatch' as const),
          };
        }

        // 2. Recompute the hash from the row's own fields and compare in
        //    constant time.
        const expectedHash = this.hashOf(row.previousHash, payloadForRow(row));
        if (!hashesEqual(expectedHash, row.hash)) {
          return {
            ok: false as const,
            rowsVerified,
            workspaceId: opts.workspaceId,
            brokenRowId: row.id,
            reason: 'hash_mismatch' as const,
          };
        }

        previousHash = row.hash;
        rowsVerified += 1;
      }

      return { ok: true as const, rowsVerified, workspaceId: opts.workspaceId };
    });
  }

  /** Exposed only for parity tests; never call from app code. */
  hashOf(previousHash: string | null, payload: AuditPayloadForHash): string {
    return computeChainHash(this.key, previousHash, canonicalize(payload));
  }
}

/**
 * The deterministic shape that feeds the hash. We intentionally do NOT
 * include `previousHash` here — it is already concatenated by the hash
 * function with a boundary byte. We do NOT include the row id (we don't
 * know it yet at insert time) or `createdAt` (clock skew between writer
 * and verifier would break the chain).
 *
 * Including `workspaceId` ties the chain to its tenant: a row physically
 * moved into another workspace would be flagged.
 */
export interface AuditPayloadForHash {
  workspaceId: string | null;
  actorUserId: string | null;
  actorIp: string | null;
  actorUserAgent: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  diff: unknown;
  metadata: Record<string, unknown>;
}

function payloadFor(input: AppendInput, workspaceId: string | null): AuditPayloadForHash {
  return {
    workspaceId,
    actorUserId: input.actorUserId ?? null,
    actorIp: input.actorIp ?? null,
    actorUserAgent: input.actorUserAgent ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    diff: input.diff ?? null,
    metadata: input.metadata ?? {},
  };
}

function payloadForRow(row: AuditRow): AuditPayloadForHash {
  return {
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    actorIp: row.actorIp,
    actorUserAgent: row.actorUserAgent,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    diff: row.diff,
    metadata: row.metadata,
  };
}

function previousHashMatches(actual: string | null, expected: string | null): boolean {
  if (actual === null && expected === null) return true;
  if (actual === null || expected === null) return false;
  return hashesEqual(actual, expected);
}

function assertNonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuditError('INVALID_INPUT', `audit field "${name}" must be a non-empty string`);
  }
}
