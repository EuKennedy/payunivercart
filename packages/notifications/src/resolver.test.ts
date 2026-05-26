import { describe, expect, it, vi } from 'vitest';
import { findEvent } from './defaults';
import { resolveTemplate } from './resolver';

/**
 * Resolver tests with a hand-rolled fake DB. We don't stand up real
 * Drizzle here — that's covered by the integration test in
 * `apps/api/src/routers/notification-templates.test.ts`. The unit
 * test's job is to lock in the fallback chain: workspace_override →
 * platform_default → null.
 */

function fakeDb(rows: Array<{ subject: string | null; body: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

describe('resolveTemplate', () => {
  it('returns the workspace override when one exists', async () => {
    const db = fakeDb([{ subject: 'Custom subject', body: 'Custom body' }]);
    const result = await resolveTemplate(db, {
      workspaceId: 'ws-1',
      eventKey: 'order_paid_buyer',
      channel: 'email',
    });
    expect(result).not.toBeNull();
    expect(result?.source).toBe('workspace_override');
    expect(result?.subject).toBe('Custom subject');
    expect(result?.body).toBe('Custom body');
  });

  it('falls back to the platform default when no override exists', async () => {
    const db = fakeDb([]);
    const result = await resolveTemplate(db, {
      workspaceId: 'ws-1',
      eventKey: 'order_paid_buyer',
      channel: 'email',
    });
    expect(result).not.toBeNull();
    expect(result?.source).toBe('platform_default');
    // Subject must match the catalogue entry exactly so the editor's
    // "reset to default" surfaces the same text the renderer uses.
    const def = findEvent('order_paid_buyer')?.defaults.email;
    expect(result?.subject).toBe(def?.subject);
    expect(result?.body).toBe(def?.body);
  });

  it('returns null when the channel has no default for this event', async () => {
    const db = fakeDb([]);
    // `order_paid_producer` is whatsapp-only by design.
    const result = await resolveTemplate(db, {
      workspaceId: 'ws-1',
      eventKey: 'order_paid_producer',
      channel: 'email',
    });
    expect(result).toBeNull();
  });

  it('respects an empty body override by falling back to default', async () => {
    // A producer who saves an empty body shouldn't dispatch a blank
    // email; the resolver treats it as if no override exists.
    const db = fakeDb([{ subject: 'subj', body: '' }]);
    const result = await resolveTemplate(db, {
      workspaceId: 'ws-1',
      eventKey: 'order_paid_buyer',
      channel: 'email',
    });
    expect(result?.source).toBe('platform_default');
  });
});
