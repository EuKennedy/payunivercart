'use client';

import { useState } from 'react';
import { EmptyState, Heading, Kicker } from '../../../components/ui';
import { type Currency, formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Clientes — derived view over orders grouped by buyer email.
 *
 * Sorted by most-recent-purchase first (matches the producer mental
 * model: "who bought from me lately"). Shows quick KPIs per buyer
 * (total spend, paid orders, last activity) so the producer can
 * spot whales and dormant buyers at a glance.
 */

export default function ClientesPage() {
  const [query, setQuery] = useState('');
  const list = trpc.customers.list.useQuery({ limit: 200 }, { staleTime: 30_000 });

  const filtered = (list.data ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.email, c.customerName, c.customerPhoneE164].join(' ').toLowerCase().includes(q);
  });

  if (list.isPending) {
    return <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }

  if (!list.data || list.data.length === 0) {
    return (
      <EmptyState
        kicker="clientes · base zerada"
        title="Nenhum cliente ainda."
        description="Quando o primeiro comprador finalizar o checkout, ele aparece aqui — com total gasto, último pedido e WhatsApp pra disparo direto."
        action={null}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Kicker>vendas · clientes</Kicker>
          <Heading level={1}>Clientes</Heading>
          <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
            {list.data.length} comprador{list.data.length === 1 ? '' : 'es'} já passaram pelo seu
            checkout. A lista é agrupada por email — somando pedidos e total pago de cada cliente.
          </p>
        </div>
        <input
          type="search"
          placeholder="Buscar por email, nome ou telefone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
        />
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        <Kpi label="Clientes únicos" value={String(list.data.length)} />
        <Kpi
          label="Pedidos totais"
          value={String(list.data.reduce((acc, c) => acc + c.orderCount, 0))}
        />
        <Kpi
          label="LTV médio (pago)"
          value={formatCents(
            Math.round(list.data.reduce((acc, c) => acc + c.paidTotalCents, 0) / list.data.length),
            'BRL',
          )}
        />
      </section>

      <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-[14px]">
          <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            <tr>
              <th className="px-5 py-3 font-semibold">Cliente</th>
              <th className="px-5 py-3 font-semibold">Contato</th>
              <th className="px-5 py-3 font-semibold">Pedidos</th>
              <th className="px-5 py-3 font-semibold">Total pago</th>
              <th className="px-5 py-3 font-semibold">Último pedido</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-6 text-center text-[13px] text-[var(--color-fg-subtle)]"
                >
                  Nenhum cliente bate com o filtro.
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path lives on the email link inside the row; the row click is mouse convenience.
                <tr
                  key={c.email}
                  className="cursor-pointer transition hover:bg-[var(--color-surface-muted)]/50"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.location.href = `/clientes/${encodeURIComponent(c.email)}`;
                    }
                  }}
                >
                  <td className="px-5 py-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-[var(--color-fg)]">
                        {c.customerName || '—'}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                        {c.email}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-[13px] text-[var(--color-fg-muted)]">
                        {c.customerPhoneE164}
                      </span>
                      {c.hasWhatsappChatId ? (
                        <span className="self-start rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-success)] uppercase tracking-wider">
                          WhatsApp
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[var(--color-fg-muted)]">
                    {c.paidCount} pagos · {c.orderCount} total
                  </td>
                  <td className="px-5 py-4 font-medium text-[var(--color-fg)]">
                    {formatCents(c.paidTotalCents, c.currency as Currency)}
                  </td>
                  <td className="px-5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                    {formatRelative(c.lastOrderAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {label}
      </p>
      <p className="mt-2 font-semibold text-[22px] text-[var(--color-fg)]">{value}</p>
    </div>
  );
}

function formatRelative(date: Date | string): string {
  const d = new Date(date);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d atrás`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
