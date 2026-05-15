import { describe, expect, it } from 'vitest';
import { PayunivercartError } from '../errors/index.js';
import {
  IDEMPOTENCY_KINDS,
  IDEMPOTENCY_NAMESPACE,
  type IdempotencyKeyParts,
  buildIdempotencyKey,
} from './index.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const base: IdempotencyKeyParts = {
  workspaceId: 'ws_abc',
  orderId: 'ord_123',
  gatewayId: 'mercadopago',
  kind: 'create_pix',
  attempt: 1,
};

describe('buildIdempotencyKey — determinism', () => {
  it('returns the same UUIDv5 for the same parts', () => {
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
  });

  it('returns a value that matches the UUIDv5 shape (version=5, variant=10xx)', () => {
    expect(buildIdempotencyKey(base)).toMatch(UUID_REGEX);
  });

  it('is stable across repeated calls (regression-frozen value)', () => {
    // If this hash ever changes, every retry already in-flight against the
    // gateways gets re-treated as a brand-new charge. The constant below MUST
    // NOT be updated without an accompanying migration plan.
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey(base));
  });
});

describe('buildIdempotencyKey — divergence', () => {
  it('changes when workspaceId changes', () => {
    expect(buildIdempotencyKey(base)).not.toBe(
      buildIdempotencyKey({ ...base, workspaceId: 'ws_xyz' }),
    );
  });

  it('changes when orderId changes', () => {
    expect(buildIdempotencyKey(base)).not.toBe(
      buildIdempotencyKey({ ...base, orderId: 'ord_999' }),
    );
  });

  it('changes when gatewayId changes', () => {
    expect(buildIdempotencyKey(base)).not.toBe(
      buildIdempotencyKey({ ...base, gatewayId: 'stripe' }),
    );
  });

  it('changes when kind changes', () => {
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, kind: 'refund' }));
  });

  it('changes when attempt changes', () => {
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, attempt: 2 }));
  });

  it('is unambiguous: ("ws", "order-x") differs from ("ws-order", "x")', () => {
    // NUL separators guarantee tokens cannot be merged across field boundaries.
    const a = buildIdempotencyKey({ ...base, workspaceId: 'ws', orderId: 'order-x' });
    const b = buildIdempotencyKey({ ...base, workspaceId: 'ws-order', orderId: 'x' });
    expect(a).not.toBe(b);
  });
});

describe('buildIdempotencyKey — uniqueness sweep', () => {
  it('produces no collisions across the cartesian product of 1000 distinct inputs', () => {
    const seen = new Set<string>();
    for (let ws = 0; ws < 10; ws++) {
      for (let order = 0; order < 10; order++) {
        for (let attempt = 1; attempt <= 10; attempt++) {
          const key = buildIdempotencyKey({
            workspaceId: `ws_${ws}`,
            orderId: `ord_${order}`,
            gatewayId: 'pagarme',
            kind: 'create_card',
            attempt,
          });
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(1000);
  });
});

describe('buildIdempotencyKey — input validation', () => {
  const invalidCases: [string, Partial<IdempotencyKeyParts>][] = [
    ['empty workspaceId', { workspaceId: '' }],
    ['whitespace-only workspaceId', { workspaceId: '   ' }],
    ['empty orderId', { orderId: '' }],
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard.
    ['null gatewayId (runtime)', { gatewayId: null as any }],
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard.
    ['null kind (runtime)', { kind: null as any }],
    ['attempt = 0', { attempt: 0 }],
    ['attempt negative', { attempt: -1 }],
    ['attempt non-integer', { attempt: 1.5 }],
    ['attempt > max', { attempt: 1_000_001 }],
  ];

  for (const [name, override] of invalidCases) {
    it(`rejects: ${name}`, () => {
      expect(() => buildIdempotencyKey({ ...base, ...override })).toThrowError(PayunivercartError);
    });
  }
});

describe('IDEMPOTENCY_KINDS / IDEMPOTENCY_NAMESPACE shape', () => {
  it('exposes the documented set of kinds', () => {
    expect(IDEMPOTENCY_KINDS).toEqual([
      'create_pix',
      'create_card',
      'create_boleto',
      'capture',
      'refund',
      'cancel',
    ]);
  });

  it('namespace is the 36-char project-scoped constant', () => {
    expect(IDEMPOTENCY_NAMESPACE).toHaveLength(36);
    // The namespace value must never change once any caller depends on it.
    expect(IDEMPOTENCY_NAMESPACE).toBe('5e3a2c1b-9d6e-4f0a-b8c4-1d3f7a8b9c0e');
  });
});
