import { schema } from '@payunivercart/db';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionNotifier } from './subscription-notify';

/**
 * Minimal drizzle stub. The notifier only ever issues
 * `select(cols).from(table).where(cond).limit(n)` and
 * `update(table).set(v).where(cond)`. We key canned rows off the table
 * REFERENCE (schema.subscriptions etc.) so each query resolves to the
 * right fixture without parsing SQL.
 */
function fakeDb(rowsByTable: Map<unknown, unknown[]>, onUpdate?: (table: unknown) => void) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(rowsByTable.get(table) ?? []);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      onUpdate?.(table);
      return {
        set() {
          return { where: () => Promise.resolve() };
        },
      };
    },
    // biome-ignore lint/suspicious/noExplicitAny: drizzle's typed client collapses to any at the call boundary.
  } as any;
}

function fakeWaha(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getSessionStatus: vi.fn().mockResolvedValue('WORKING'),
    checkExists: vi.fn().mockResolvedValue({ numberExists: true, chatId: '5511988887777@c.us' }),
    sendTextWithRetry: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: only the methods the notifier calls are stubbed.
  } as any;
}

const SUB_ID = '11111111-1111-1111-1111-111111111111';
const WS_ID = '22222222-2222-2222-2222-222222222222';

function baseRows(): Map<unknown, unknown[]> {
  return new Map<unknown, unknown[]>([
    [
      schema.subscriptions,
      [
        {
          customerPhoneE164: '+5511988887777',
          customerWahaChatId: '5511988887777@c.us',
          pixCurrentChargeId: null,
        },
      ],
    ],
    [schema.workspaces, [{ name: 'Workspace Legal', companyName: 'Acme Cursos' }]],
    [schema.whatsappSessions, [{ sessionName: 'sess-1' }]],
    // resolveTemplate looks here first; empty → platform default kicks in.
    [schema.notificationTemplates, []],
  ]);
}

describe('createSubscriptionNotifier', () => {
  it('renders the platform default and sends WhatsApp with brand + vars', async () => {
    const waha = fakeWaha();
    const notify = createSubscriptionNotifier({ db: fakeDb(baseRows()), waha });

    await notify({
      workspaceId: WS_ID,
      subscriptionId: SUB_ID,
      eventKey: 'subscription_renewal_reminder',
      vars: {
        nome: 'Ana',
        produto: 'Comunidade Mensal',
        valor: 'R$ 97,00',
        vencimento: '03/06/2026',
        codigo: 'SUB-1',
      },
    });

    expect(waha.sendTextWithRetry).toHaveBeenCalledTimes(1);
    const [input] = waha.sendTextWithRetry.mock.calls[0];
    expect(input.chatId).toBe('5511988887777@c.us');
    expect(input.session).toBe('sess-1');
    // Vars + injected brand all interpolated (no leftover {placeholder}).
    expect(input.text).toContain('Ana');
    expect(input.text).toContain('Comunidade Mensal');
    expect(input.text).toContain('Acme Cursos');
    expect(input.text).not.toMatch(/\{[a-z]+\}/);
  });

  it('fills the link var from the active charge copy-paste when blank', async () => {
    const rows = baseRows();
    rows.set(schema.subscriptions, [
      {
        customerPhoneE164: '+5511988887777',
        customerWahaChatId: '5511988887777@c.us',
        pixCurrentChargeId: 'charge-1',
      },
    ]);
    rows.set(schema.transactions, [{ copyPaste: '00020126-PIX-COPIA-E-COLA' }]);
    const waha = fakeWaha();
    const notify = createSubscriptionNotifier({ db: fakeDb(rows), waha });

    await notify({
      workspaceId: WS_ID,
      subscriptionId: SUB_ID,
      eventKey: 'subscription_renewal_due',
      vars: { nome: 'Ana', produto: 'Comunidade', valor: 'R$ 97,00', codigo: 'SUB-1', link: '' },
    });

    expect(waha.sendTextWithRetry).toHaveBeenCalledTimes(1);
    const [input] = waha.sendTextWithRetry.mock.calls[0];
    expect(input.text).toContain('00020126-PIX-COPIA-E-COLA');
  });

  it('soft-skips (no send) when the WhatsApp session is not WORKING', async () => {
    const waha = fakeWaha({ getSessionStatus: vi.fn().mockResolvedValue('SCAN_QR_CODE') });
    const notify = createSubscriptionNotifier({ db: fakeDb(baseRows()), waha });

    await notify({
      workspaceId: WS_ID,
      subscriptionId: SUB_ID,
      eventKey: 'subscription_grace_expired',
      vars: { nome: 'Ana', produto: 'Comunidade', codigo: 'SUB-1' },
    });

    expect(waha.sendTextWithRetry).not.toHaveBeenCalled();
  });

  it('soft-skips when the subscription row is gone', async () => {
    const rows = baseRows();
    rows.set(schema.subscriptions, []);
    const waha = fakeWaha();
    const notify = createSubscriptionNotifier({ db: fakeDb(rows), waha });

    await notify({
      workspaceId: WS_ID,
      subscriptionId: SUB_ID,
      eventKey: 'subscription_renewal_reminder',
      vars: { nome: 'Ana', produto: 'X', valor: 'R$ 1,00', vencimento: 'hoje', codigo: 'S' },
    });

    expect(waha.sendTextWithRetry).not.toHaveBeenCalled();
  });
});
