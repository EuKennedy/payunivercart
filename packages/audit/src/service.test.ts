import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditError } from './errors.js';
import type { AuditPort, AuditRow, AuditRowInsert, AuditTx } from './port.js';
import { AuditService } from './service.js';

/**
 * In-memory port for testing. Stores every row, lets us peek and tamper
 * with the state to drive the verifier through every failure branch.
 */
class InMemoryPort implements AuditPort {
  readonly rows: AuditRow[] = [];

  async withChainLock<T>(_workspaceId: string | null, fn: (tx: AuditTx) => Promise<T>): Promise<T> {
    return fn(this.tx());
  }

  private tx(): AuditTx {
    const rows = this.rows;
    return {
      async getLatestHash(workspaceId) {
        const filtered = rows.filter((r) => r.workspaceId === workspaceId);
        const last = filtered[filtered.length - 1];
        return last ? last.hash : null;
      },
      async insertRow(insert: AuditRowInsert): Promise<AuditRow> {
        const row: AuditRow = { ...insert, id: randomUUID(), createdAt: new Date() };
        rows.push(row);
        return row;
      },
      async *listRows(workspaceId, since) {
        for (const r of rows) {
          if (r.workspaceId !== workspaceId) continue;
          if (since && r.createdAt < since) continue;
          yield r;
        }
      },
    };
  }
}

function buildService() {
  const port = new InMemoryPort();
  const key = new Uint8Array(randomBytes(32));
  return { port, service: new AuditService({ port, key }) };
}

/** Index helper that throws instead of returning undefined; keeps tests readable. */
function row(port: InMemoryPort, index: number): AuditRow {
  const r = port.rows[index];
  if (!r) throw new Error(`expected port.rows[${index}] to exist (have ${port.rows.length})`);
  return r;
}

function rowBy(port: InMemoryPort, predicate: (r: AuditRow) => boolean): AuditRow {
  const r = port.rows.find(predicate);
  if (!r) throw new Error('no row matched predicate');
  return r;
}

/* -------------------------------------------------------------------------- */
/* append                                                                      */
/* -------------------------------------------------------------------------- */

describe('AuditService.append', () => {
  it('genesis row has previousHash = null', async () => {
    const { service } = buildService();
    const r = await service.append({
      workspaceId: 'ws_1',
      action: 'order.created',
      resourceType: 'order',
      resourceId: 'ord_1',
    });
    expect(r.previousHash).toBeNull();
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('continuation row carries previous row hash as previousHash', async () => {
    const { service } = buildService();
    const first = await service.append({
      workspaceId: 'ws_1',
      action: 'a',
      resourceType: 'order',
    });
    const second = await service.append({
      workspaceId: 'ws_1',
      action: 'b',
      resourceType: 'order',
    });
    expect(second.previousHash).toBe(first.hash);
  });

  it('two workspaces maintain independent chains', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_2', action: 'a', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_1', action: 'b', resourceType: 'x' });

    const ws1 = port.rows.filter((r) => r.workspaceId === 'ws_1');
    expect(ws1).toHaveLength(2);
    const [ws1Genesis, ws1Continuation] = ws1;
    if (!ws1Genesis || !ws1Continuation) throw new Error('expected 2 rows in ws_1');
    expect(ws1Genesis.previousHash).toBeNull();
    expect(ws1Continuation.previousHash).toBe(ws1Genesis.hash);

    const ws2 = port.rows.filter((r) => r.workspaceId === 'ws_2');
    const ws2Genesis = ws2[0];
    if (!ws2Genesis) throw new Error('expected at least 1 row in ws_2');
    expect(ws2Genesis.previousHash).toBeNull();
  });

  it('null workspaceId works (system-level events)', async () => {
    const { service } = buildService();
    const r = await service.append({
      workspaceId: null,
      action: 'system.boot',
      resourceType: 'system',
    });
    expect(r.previousHash).toBeNull();
  });

  it('rejects empty action', async () => {
    const { service } = buildService();
    await expect(
      service.append({
        workspaceId: 'ws_1',
        action: '',
        resourceType: 'order',
      }),
    ).rejects.toBeInstanceOf(AuditError);
  });

  it('rejects empty resourceType', async () => {
    const { service } = buildService();
    await expect(
      service.append({
        workspaceId: 'ws_1',
        action: 'a',
        resourceType: '   ',
      }),
    ).rejects.toBeInstanceOf(AuditError);
  });
});

/* -------------------------------------------------------------------------- */
/* verify — happy path                                                         */
/* -------------------------------------------------------------------------- */

describe('AuditService.verify', () => {
  it('returns ok for an untampered chain', async () => {
    const { service } = buildService();
    for (let i = 0; i < 5; i++) {
      await service.append({
        workspaceId: 'ws_1',
        action: `event.${i}`,
        resourceType: 'order',
        resourceId: `ord_${i}`,
      });
    }
    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(true);
    expect(report.rowsVerified).toBe(5);
  });

  it('returns ok for an empty workspace', async () => {
    const { service } = buildService();
    const report = await service.verify({ workspaceId: 'ws_empty' });
    expect(report.ok).toBe(true);
    expect(report.rowsVerified).toBe(0);
  });

  it('verifies independently per workspace (cross-tenant tamper does not affect other chain)', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_2', action: 'a', resourceType: 'x' });

    // Tamper ws_2 only.
    rowBy(port, (r) => r.workspaceId === 'ws_2').action = 'TAMPERED';

    const r1 = await service.verify({ workspaceId: 'ws_1' });
    const r2 = await service.verify({ workspaceId: 'ws_2' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* verify — tamper detection                                                   */
/* -------------------------------------------------------------------------- */

describe('AuditService.verify — tamper detection', () => {
  it('detects a mutated action field (hash mismatch)', async () => {
    const { service, port } = buildService();
    await service.append({
      workspaceId: 'ws_1',
      action: 'original.event',
      resourceType: 'order',
    });
    row(port, 0).action = 'tampered.event';

    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe('hash_mismatch');
      expect(report.brokenRowId).toBe(row(port, 0).id);
    }
  });

  it('detects a mutated diff field', async () => {
    const { service, port } = buildService();
    await service.append({
      workspaceId: 'ws_1',
      action: 'order.updated',
      resourceType: 'order',
      diff: { before: { status: 'pending' }, after: { status: 'paid' } },
    });
    row(port, 0).diff = { before: { status: 'pending' }, after: { status: 'cancelled' } };

    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
  });

  it('detects a flipped previousHash on a continuation row', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_1', action: 'b', resourceType: 'x' });

    // Corrupt the second row's previousHash.
    row(port, 1).previousHash = 'deadbeef'.repeat(8);
    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.reason).toBe('previous_hash_mismatch');
  });

  it('detects a forged genesis with non-null previousHash', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    // Pretend the first row was actually a continuation.
    row(port, 0).previousHash = 'cafe'.repeat(16);

    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.reason).toBe('genesis_violation');
  });

  it('detects a deleted row (broken chain link)', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_1', action: 'b', resourceType: 'x' });
    await service.append({ workspaceId: 'ws_1', action: 'c', resourceType: 'x' });

    // Remove the middle row.
    port.rows.splice(1, 1);

    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
    // The (formerly third) row now has a previousHash that no longer points
    // at the (now first) row — `previous_hash_mismatch`.
    if (!report.ok) expect(report.reason).toBe('previous_hash_mismatch');
  });

  it('detects a forged genesis (first row swapped for fabricated payload)', async () => {
    const { service, port } = buildService();
    await service.append({ workspaceId: 'ws_1', action: 'a', resourceType: 'x' });
    // Replace the row's hash with garbage of the right shape.
    row(port, 0).hash = 'abcd1234'.repeat(8);

    const report = await service.verify({ workspaceId: 'ws_1' });
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.reason).toBe('hash_mismatch');
  });
});
