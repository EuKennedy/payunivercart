'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { type Currency, formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Pedidos — list view. Compact table sorted by most-recent-first.
 *
 * Click a row to open `/pedidos/[id]` with the full customer details +
 * the "Disparar mensagem no WhatsApp" CTA. The list itself stays read-
 * only — anything mutating happens on the detail page so the producer
 * always sees the full context before acting.
 */

const STATUS_OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'pending_payment', label: 'Aguardando pagamento' },
  { value: 'paid', label: 'Pagos' },
  { value: 'cancelled', label: 'Cancelados' },
  { value: 'expired', label: 'Expirados' },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value'];

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho',
  pending_payment: 'Pendente',
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

export default function PedidosPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>('all');
  // Polls every 5s so the producer sees the pending → paid flip
  // arrive in close-to-real-time after a buyer pays. The webhook
  // is the source of truth — this just shortens the discovery
  // window on the dashboard surface.
  const list = trpc.orders.list.useQuery(
    { limit: 100, ...(filter !== 'all' ? { status: filter } : {}) },
    { staleTime: 4_000, refetchInterval: 5_000, refetchIntervalInBackground: false },
  );

  if (list.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }

  if (!list.data || list.data.length === 0) {
    return (
      <EmptyState
        kicker="pedidos · ainda vazio"
        title={filter === 'all' ? 'Nenhum pedido ainda.' : 'Nenhum pedido nesse status.'}
        description={
          filter === 'all'
            ? 'Quando um cliente abrir seu checkout e iniciar o pagamento, o pedido vai aparecer aqui em tempo real.'
            : 'Mude o filtro pra ver pedidos em outros estados.'
        }
        action={
          filter === 'all' ? null : <Button onClick={() => setFilter('all')}>Ver todos</Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Kicker>vendas</Kicker>
          <Heading level={1}>Pedidos</Heading>
          <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
            {list.data.length} pedido{list.data.length === 1 ? '' : 's'}. Clique em qualquer linha
            pra ver detalhes do cliente, valor, status e disparar uma mensagem direta no WhatsApp.
          </p>
        </div>
        <div className="flex gap-2">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={`rounded-full border px-3 py-1.5 font-medium text-[12px] transition ${
                filter === opt.value
                  ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>

      <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-[14px]">
          <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            <tr>
              <th className="px-5 py-3 font-semibold">Pedido</th>
              <th className="px-5 py-3 font-semibold">Cliente</th>
              <th className="px-5 py-3 font-semibold">Valor</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold">Quando</th>
              <th className="px-5 py-3 text-right font-semibold" aria-label="Abrir" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {list.data.map((order) => (
              <tr
                key={order.id}
                tabIndex={0}
                className="cursor-pointer transition hover:bg-[var(--color-surface-muted)]/50"
                onClick={() => router.push(`/pedidos/${order.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(`/pedidos/${order.id}`);
                  }
                }}
              >
                <td className="px-5 py-4 font-mono text-[12px] text-[var(--color-fg-muted)]">
                  {order.publicReference}
                </td>
                <td className="px-5 py-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-[var(--color-fg)]">{order.customerName}</span>
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      {order.customerPhoneE164}
                      {order.hasWhatsappChatId ? ' · WhatsApp confirmado' : ''}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-4 font-medium text-[var(--color-fg)]">
                  {formatCents(order.totalCents, order.currency as Currency)}
                </td>
                <td className="px-5 py-4">
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-medium text-[11px] uppercase tracking-wider ${
                      STATUS_TONE[order.status] ?? STATUS_TONE.draft
                    }`}
                  >
                    {STATUS_LABEL[order.status] ?? order.status}
                  </span>
                </td>
                <td className="px-5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                  {formatDate(order.createdAt)}
                </td>
                <td className="px-5 py-4 text-right text-[12px] text-[var(--color-fg-subtle)]">
                  →
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
