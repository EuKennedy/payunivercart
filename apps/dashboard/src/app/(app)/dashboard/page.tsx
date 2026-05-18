'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { Heading, Kicker, Surface } from '../../../components/ui';
import { useSession } from '../../../lib/auth';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Dashboard home — visão geral da operação. Real data via tRPC: GMV
 * + orders today, conversion last 30d, plus an activity feed of the
 * latest 10 orders. When the workspace is fresh (zero orders) we fall
 * back to a "Próximos passos" deck nudging the producer towards
 * connecting WhatsApp / cadastrando produto / personalizando checkout.
 */
export default function DashboardHome() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  const overview = trpc.metrics.overview.useQuery(undefined, {
    staleTime: 30_000,
    enabled: !!session.data,
  });
  const recent = trpc.metrics.recentOrders.useQuery(
    { limit: 10 },
    { staleTime: 30_000, enabled: !!session.data },
  );

  if (session.isPending) {
    return <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  const firstName = (session.data.user.name ?? 'produtor').split(' ')[0];
  const todayGmv = overview.data?.today.gmvCents ?? 0;
  const todayOrders = overview.data?.today.orderCount ?? 0;
  const yGmv = overview.data?.yesterday.gmvCents ?? 0;
  const yOrders = overview.data?.yesterday.orderCount ?? 0;
  const conversion = overview.data?.conversionRateLast30d ?? 0;
  const hasAnyOrders =
    (overview.data?.allTime.paidCount ?? 0) > 0 || (recent.data?.length ?? 0) > 0;

  return (
    <div className="space-y-12">
      <header className="space-y-3">
        <Kicker>Visão geral</Kicker>
        <Heading level={1}>Olá, {firstName}.</Heading>
        <p className="max-w-2xl text-[16px] text-[var(--color-fg-muted)] leading-[1.55]">
          {hasAnyOrders
            ? 'Acompanhe sua operação em tempo real. Os números abaixo são do seu workspace, atualizados a cada 30 segundos.'
            : 'Sua operação aparece aqui assim que a primeira venda chegar. Comece conectando o WhatsApp e cadastrando seu produto.'}
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard
          label="GMV hoje"
          value={formatCents(todayGmv, 'BRL')}
          trend={trendLine(todayGmv, yGmv, (n) => formatCents(n, 'BRL'))}
        />
        <MetricCard
          label="Pedidos hoje"
          value={String(todayOrders)}
          trend={trendLine(todayOrders, yOrders, (n) => String(n))}
        />
        <MetricCard
          label="Conversão (30d)"
          value={overview.data ? `${(conversion * 100).toFixed(1)}%` : '—'}
          trend="paid / created"
        />
      </section>

      {/* Activity feed OR onboarding deck */}
      {hasAnyOrders && recent.data && recent.data.length > 0 ? (
        <section>
          <div className="mb-5 flex items-baseline justify-between">
            <Heading level={3}>Últimos pedidos</Heading>
            <p className="text-[13px] text-[var(--color-fg-subtle)]">Atualiza a cada 30s</p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                <tr>
                  <th className="px-5 py-3 font-semibold">Pedido</th>
                  <th className="px-5 py-3 font-semibold">Cliente</th>
                  <th className="px-5 py-3 font-semibold">Valor</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 text-right font-semibold">Quando</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {recent.data.map((order) => (
                  <tr
                    key={order.id}
                    className="transition hover:bg-[var(--color-surface-muted)]/50"
                  >
                    <td className="px-5 py-3 font-mono text-[12px] text-[var(--color-fg)]">
                      {order.publicReference}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--color-fg)]">
                          {order.customerName}
                        </span>
                        <span className="text-[12px] text-[var(--color-fg-subtle)]">
                          {order.customerEmail}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-medium text-[var(--color-fg)]">
                      {formatCents(order.totalCents, order.currency)}
                    </td>
                    <td className="px-5 py-3">
                      <StatusPill status={order.status} />
                    </td>
                    <td className="px-5 py-3 text-right text-[12px] text-[var(--color-fg-subtle)]">
                      {timeAgo(new Date(order.createdAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section>
          <div className="mb-5 flex items-baseline justify-between">
            <Heading level={3}>Próximos passos</Heading>
            <p className="text-[13px] text-[var(--color-fg-subtle)]">Recomendado para começar</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <NextStep
              n="01"
              href="/integrations/whatsapp"
              title="Conectar WhatsApp"
              body="Escanear QR code e ativar o canal de mensagens."
            />
            <NextStep
              n="02"
              href="/produtos/novo"
              title="Cadastrar produto"
              body="Nome, preço, descrição. Link de checkout gerado automaticamente."
            />
            <NextStep
              n="03"
              href="/integrations/gateways"
              title="Conectar gateway"
              body="Mercado Pago, Pagar.me, PagSeguro ou Stripe. Sem gateway, sem cobrança."
            />
          </div>
        </section>
      )}
    </div>
  );
}

function MetricCard({ label, value, trend }: { label: string; value: string; trend: string }) {
  return (
    <Surface className="space-y-3">
      <p className="font-medium text-[12px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
        {label}
      </p>
      <p className="display font-semibold text-[36px] text-[var(--color-fg)] leading-none tracking-tight">
        {value}
      </p>
      <p className="text-[13px] text-[var(--color-fg-muted)]">{trend}</p>
    </Surface>
  );
}

function NextStep({
  n,
  href,
  title,
  body,
}: {
  n: string;
  href: string;
  title: string;
  body: ReactNode;
}) {
  return (
    <Link href={href} className="surface-interactive group flex flex-col gap-3 p-6">
      <span className="font-semibold text-[11px] text-[var(--color-brand-600)] uppercase tracking-[0.18em]">
        {n}
      </span>
      <p className="font-semibold text-[16px] text-[var(--color-fg)] tracking-tight">{title}</p>
      <p className="text-[14px] text-[var(--color-fg-muted)] leading-[1.5]">{body}</p>
      <span className="mt-1 inline-flex items-center gap-1 font-medium text-[13px] text-[var(--color-fg)] transition group-hover:gap-2">
        Abrir
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="size-3"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </span>
    </Link>
  );
}

const FALLBACK_STATUS_TONE = {
  bg: 'bg-[var(--color-surface-muted)]',
  fg: 'text-[var(--color-fg-subtle)]',
  label: 'Desconhecido',
} as const;

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    draft: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-subtle)]',
      label: 'Rascunho',
    },
    pending_payment: {
      bg: 'bg-[var(--color-warning-bg)]',
      fg: 'text-[var(--color-warning)]',
      label: 'Aguardando',
    },
    paid: { bg: 'bg-[var(--color-success-bg)]', fg: 'text-[var(--color-success)]', label: 'Pago' },
    partially_refunded: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-muted)]',
      label: 'Reembolso parcial',
    },
    refunded: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-muted)]',
      label: 'Reembolsado',
    },
    cancelled: {
      bg: 'bg-[var(--color-danger-bg)]',
      fg: 'text-[var(--color-danger)]',
      label: 'Cancelado',
    },
    expired: {
      bg: 'bg-[var(--color-danger-bg)]',
      fg: 'text-[var(--color-danger)]',
      label: 'Expirado',
    },
  };
  const tone = palette[status] ?? palette.draft ?? FALLBACK_STATUS_TONE;
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 font-medium text-[11px] uppercase tracking-wider ${tone.bg} ${tone.fg}`}
    >
      {tone.label}
    </span>
  );
}

/** Format a human delta vs yesterday. Returns "+R$ 120 vs ontem" or "—". */
function trendLine(now: number, prev: number, formatter: (n: number) => string): string {
  if (prev === 0 && now === 0) return '—';
  if (prev === 0) return `${formatter(now)} (ontem zero)`;
  const delta = now - prev;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const abs = Math.abs(delta);
  return `${sign}${formatter(abs)} vs ontem`;
}

/** Coarse "X min/h/d atrás" pt-BR formatter for the activity column. */
function timeAgo(date: Date): string {
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s atrás`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h atrás`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d atrás`;
  return date.toLocaleDateString('pt-BR');
}
