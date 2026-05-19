'use client';

import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { type Currency, formatCents } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Pedido — detail view.
 *
 * Shows every field the producer needs to act on a single order:
 * customer identity (name / email / CPF / phone), WhatsApp chatId
 * presence, line items, totals, status timeline. The "Disparar
 * mensagem no WhatsApp" CTA opens an inline composer; on send we hit
 * `orders.sendWhatsapp` which validates the workspace's WAHA session
 * is WORKING and falls back to `check-exists` when the order row
 * doesn't already carry a resolved chatId.
 */

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho',
  pending_payment: 'Aguardando pagamento',
  paid: 'Pago',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  chargedback: 'Chargeback',
  expired: 'Expirado',
};

const STATUS_TONE: Record<string, string> = {
  paid: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
  pending_payment: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  cancelled: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
  expired: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
  refunded: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
  chargedback: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  draft: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
};

export default function PedidoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const order = trpc.orders.byId.useQuery({ id });
  const [composerOpen, setComposerOpen] = useState(false);
  const [message, setMessage] = useState('');
  const send = trpc.orders.sendWhatsapp.useMutation({
    onSuccess: () => {
      setComposerOpen(false);
      setMessage('');
    },
  });
  const markPaid = trpc.orders.markPaidManually.useMutation({
    onSuccess: () => {
      utils.orders.byId.invalidate({ id });
      utils.orders.list.invalidate();
    },
  });
  const cancel = trpc.orders.cancel.useMutation({
    onSuccess: () => {
      utils.orders.byId.invalidate({ id });
      utils.orders.list.invalidate();
    },
  });

  if (order.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!order.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[15px] text-[var(--color-danger)]">Pedido não encontrado.</p>
        <Button variant="ghost" onClick={() => router.push('/pedidos')}>
          Voltar
        </Button>
      </div>
    );
  }
  const o = order.data;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Kicker>vendas · pedido</Kicker>
          <Heading level={1} className="font-mono text-[28px]">
            {o.publicReference}
          </Heading>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-2.5 py-0.5 font-medium text-[11px] uppercase tracking-wider ${
                STATUS_TONE[o.status] ?? STATUS_TONE.draft
              }`}
            >
              {STATUS_LABEL[o.status] ?? o.status}
            </span>
            <span className="text-[13px] text-[var(--color-fg-muted)]">
              Criado em {formatDate(o.createdAt)}
            </span>
            {o.paidAt ? (
              <span className="text-[13px] text-[var(--color-success)]">
                Pago em {formatDate(o.paidAt)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => router.push('/pedidos')}>
            Voltar
          </Button>
          {o.status === 'pending_payment' ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!confirm('Marcar este pedido como pago manualmente?')) return;
                  markPaid.mutate({ orderId: o.id });
                }}
                disabled={markPaid.isPending}
              >
                {markPaid.isPending ? 'Marcando…' : 'Marcar como pago'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (!confirm('Cancelar este pedido?')) return;
                  cancel.mutate({ orderId: o.id });
                }}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? 'Cancelando…' : 'Cancelar pedido'}
              </Button>
            </>
          ) : null}
          <Button onClick={() => setComposerOpen(true)}>Disparar mensagem no WhatsApp</Button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Cliente">
          <Row label="Nome">{o.customerName}</Row>
          <Row label="Email">{o.customerEmail}</Row>
          <Row label="CPF/CNPJ" mono>
            {o.customerDocument}
          </Row>
          <Row label="Telefone" mono>
            {o.customerPhoneE164}
          </Row>
          <Row label="WhatsApp chatId" mono>
            {o.customerWahaChatId ?? (
              <span className="text-[var(--color-fg-subtle)]">não resolvido ainda</span>
            )}
          </Row>
        </Card>

        <Card title="Pagamento">
          <Row label="Subtotal">{formatCents(o.subtotalCents, o.currency as Currency)}</Row>
          {o.discountCents > 0 ? (
            <Row label="Desconto">− {formatCents(o.discountCents, o.currency as Currency)}</Row>
          ) : null}
          {o.shippingCents > 0 ? (
            <Row label="Frete">{formatCents(o.shippingCents, o.currency as Currency)}</Row>
          ) : null}
          <Row label="Total" emphasis>
            {formatCents(o.totalCents, o.currency as Currency)}
          </Row>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-[var(--color-fg-muted)] uppercase tracking-[0.14em]">
          Itens
        </h2>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[14px]">
            <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              <tr>
                <th className="px-5 py-3 font-semibold">Produto</th>
                <th className="px-5 py-3 font-semibold">Quantidade</th>
                <th className="px-5 py-3 font-semibold">Unitário</th>
                <th className="px-5 py-3 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {o.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-5 py-6 text-center text-[13px] text-[var(--color-fg-subtle)]"
                  >
                    Sem itens registrados.
                  </td>
                </tr>
              ) : (
                o.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-5 py-4 font-medium text-[var(--color-fg)]">{item.name}</td>
                    <td className="px-5 py-4 text-[var(--color-fg-muted)]">{item.quantity}</td>
                    <td className="px-5 py-4 text-[var(--color-fg-muted)]">
                      {formatCents(item.unitAmountCents, o.currency as Currency)}
                    </td>
                    <td className="px-5 py-4 text-right font-medium text-[var(--color-fg)]">
                      {formatCents(item.totalCents, o.currency as Currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {composerOpen ? (
        <WhatsappComposer
          customerName={o.customerName}
          customerPhone={o.customerPhoneE164}
          message={message}
          onChange={setMessage}
          onCancel={() => setComposerOpen(false)}
          onSend={() => send.mutate({ orderId: o.id, text: message.trim() })}
          pending={send.isPending}
          error={send.error?.message ?? null}
          success={send.isSuccess && !send.isPending}
        />
      ) : null}
    </div>
  );
}

function WhatsappComposer({
  customerName,
  customerPhone,
  message,
  onChange,
  onCancel,
  onSend,
  pending,
  error,
  success,
}: {
  customerName: string;
  customerPhone: string;
  message: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSend: () => void;
  pending: boolean;
  error: string | null;
  success: boolean;
}) {
  const trimmed = message.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col">
            <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
              Mensagem WhatsApp
            </p>
            <h2 className="mt-1 font-semibold text-[18px] text-[var(--color-fg)]">
              Para {customerName}
            </h2>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              <span className="font-mono">{customerPhone}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        <textarea
          value={message}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          maxLength={4096}
          placeholder={`Oi ${customerName.split(' ')[0]}, tudo bem? …`}
          className="mt-4 w-full resize-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[14px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
        />
        <p className="mt-1 text-right text-[11px] text-[var(--color-fg-subtle)]">
          {message.length}/4096
        </p>

        {error ? <p className="mt-2 text-[13px] text-[var(--color-danger)]">{error}</p> : null}
        {success ? (
          <p className="mt-2 text-[13px] text-[var(--color-success)]">Mensagem enviada.</p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={onSend} disabled={pending || trimmed.length === 0}>
            {pending ? 'Enviando…' : 'Enviar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="mb-3 font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {title}
      </h3>
      <dl className="flex flex-col gap-2">{children}</dl>
    </div>
  );
}

function Row({
  label,
  children,
  mono,
  emphasis,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="text-[13px] text-[var(--color-fg-muted)]">{label}</dt>
      <dd
        className={`text-right text-[14px] ${mono ? 'font-mono text-[13px]' : ''} ${
          emphasis ? 'font-semibold text-[var(--color-fg)]' : 'text-[var(--color-fg)]'
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function formatDate(d: Date | string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d));
}
