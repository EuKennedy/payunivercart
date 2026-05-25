'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { use } from 'react';
import { Heading, Kicker } from '../../../../components/ui';
import { formatCents } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Customer detail page. The customer "id" in the URL is actually the
 * email (URL-encoded) since we don't have a customers table; orders
 * are grouped by `customer_email` at query time. See the customers
 * router docblock for the reasoning.
 *
 * Layout:
 *   - Hero: avatar bubble (initial) + name + email + WhatsApp chip
 *   - 4 KPIs (lifetime, paid count, total orders, first→last span)
 *   - Recent orders table (last 50)
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const { email } = use(params);
  const decoded = decodeURIComponent(email);
  const customer = trpc.customers.byEmail.useQuery({ email: decoded });

  if (customer.isPending) {
    return (
      <div className="flex flex-col gap-8">
        <div className="h-40 animate-pulse rounded-3xl bg-[var(--color-surface-muted)]" />
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
              key={i}
              className="h-24 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!customer.data || customer.data.orderCount === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <Heading level={2}>Cliente não encontrado.</Heading>
        <p className="max-w-md text-[14px] text-[var(--color-fg-muted)]">
          Nenhum pedido associado a esse email nesta workspace.
        </p>
        <Link
          href="/clientes"
          className="rounded-xl bg-[var(--color-fg)] px-4 py-2 font-semibold text-[13px] text-[var(--color-fg-inverse)]"
        >
          Voltar pra clientes
        </Link>
      </div>
    );
  }

  const c = customer.data;
  const initial = (c.customerName || c.email).trim().charAt(0).toUpperCase() || '·';
  const lifetimeDays = Math.max(
    1,
    Math.round(
      (new Date(c.lastOrderAt).getTime() - new Date(c.firstOrderAt).getTime()) /
        (1000 * 60 * 60 * 24),
    ),
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-8"
    >
      <Link
        href="/clientes"
        className="inline-flex w-fit cursor-pointer items-center gap-1.5 font-medium text-[12px] text-[var(--color-fg-subtle)] transition hover:text-[var(--color-fg)]"
      >
        ← Todos os clientes
      </Link>

      {/* Hero */}
      <section className="flex flex-wrap items-start gap-6 rounded-3xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-brand-50)]/30 via-[var(--color-surface)] to-[var(--color-surface)] p-7 shadow-[0_18px_48px_-24px_rgba(0,0,0,0.18)]">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-bold text-[24px] text-white shadow-sm">
          {initial}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Kicker>cliente</Kicker>
          <h1 className="font-bold text-[28px] text-[var(--color-fg)] tracking-tight">
            {c.customerName || c.email}
          </h1>
          <div className="flex flex-wrap gap-4 text-[13px] text-[var(--color-fg-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <IconMail /> {c.email}
            </span>
            {c.customerPhoneE164 ? (
              <span className="inline-flex items-center gap-1.5">
                <IconPhone /> {c.customerPhoneE164}
                {c.hasWhatsappChatId ? (
                  <span className="rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-success)] uppercase tracking-wider">
                    WhatsApp ativo
                  </span>
                ) : null}
              </span>
            ) : null}
            {c.customerDocument ? (
              <span className="inline-flex items-center gap-1.5">
                <IconId /> {c.customerDocument}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {/* KPIs */}
      <section className="grid gap-4 md:grid-cols-4">
        <Kpi
          label="LTV"
          value={formatCents(c.paidTotalCents, c.currency)}
          hint="Soma dos pedidos pagos."
        />
        <Kpi
          label="Pedidos pagos"
          value={String(c.paidCount)}
          hint={`${c.orderCount} criados total.`}
        />
        <Kpi
          label="Conversão"
          value={`${c.orderCount > 0 ? Math.round((c.paidCount / c.orderCount) * 100) : 0}%`}
          hint="Pedidos pagos ÷ criados."
        />
        <Kpi
          label="Relacionamento"
          value={`${lifetimeDays} ${lifetimeDays === 1 ? 'dia' : 'dias'}`}
          hint="Do primeiro pedido até o último."
        />
      </section>

      {/* Orders */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Pedidos ({c.orders.length})
        </h2>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-muted)]/60">
              <tr className="text-left">
                <Th>Referência</Th>
                <Th>Status</Th>
                <Th>Total</Th>
                <Th>Criado</Th>
                <Th>Pago</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {c.orders.map((o, idx) => (
                <motion.tr
                  key={o.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18, delay: Math.min(idx * 0.012, 0.24) }}
                  className="transition hover:bg-[var(--color-surface-muted)]/40"
                >
                  <Td>
                    <Link
                      href={`/pedidos/${o.id}`}
                      className="font-medium font-mono text-[12px] text-[var(--color-fg)] hover:text-[var(--color-brand-600)] hover:underline"
                    >
                      {o.publicReference}
                    </Link>
                  </Td>
                  <Td>
                    <OrderStatus status={o.status} />
                  </Td>
                  <Td>
                    <span className="font-semibold text-[var(--color-fg)] tabular-nums">
                      {formatCents(o.totalCents, o.currency)}
                    </span>
                  </Td>
                  <Td>
                    <time
                      className="text-[11px] text-[var(--color-fg-subtle)]"
                      dateTime={new Date(o.createdAt).toISOString()}
                    >
                      {new Date(o.createdAt).toLocaleDateString('pt-BR')}
                    </time>
                  </Td>
                  <Td>
                    <time
                      className="text-[11px] text-[var(--color-fg-subtle)]"
                      dateTime={o.paidAt ? new Date(o.paidAt).toISOString() : ''}
                    >
                      {o.paidAt ? new Date(o.paidAt).toLocaleDateString('pt-BR') : '—'}
                    </time>
                  </Td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </motion.div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className="font-bold text-[24px] text-[var(--color-fg)] tabular-nums tracking-tight">
        {value}
      </span>
      <span className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.4]">{hint}</span>
    </div>
  );
}

function OrderStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    paid: { label: 'Pago', cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]' },
    pending_payment: {
      label: 'Pendente',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    cancelled: {
      label: 'Cancelado',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
    refunded: {
      label: 'Reembolsado',
      cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    expired: {
      label: 'Expirado',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
    draft: {
      label: 'Rascunho',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  };
  const meta = map[status] ?? map.draft;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta?.cls ?? ''}`}
    >
      {meta?.label ?? status}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.12em]">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-middle">{children}</td>;
}

function IconMail() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-3.5"
      aria-hidden
    >
      <title>email</title>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 5l6 4 6-4" />
    </svg>
  );
}

function IconPhone() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-3.5"
      aria-hidden
    >
      <title>telefone</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3.5a1 1 0 011-1h2l1.5 3.5L6 7.5a8 8 0 003 3l1.5-1.5 3.5 1.5v2a1 1 0 01-1 1A11 11 0 013 3.5z"
      />
    </svg>
  );
}

function IconId() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-3.5"
      aria-hidden
    >
      <title>documento</title>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <circle cx="6" cy="8" r="1.5" />
      <path strokeLinecap="round" d="M9.5 6.5h3M9.5 9.5h3" />
    </svg>
  );
}
