'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Heading, Kicker, Surface } from '../../../components/ui';
import { useSession } from '../../../lib/auth';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

const MASK_KEY = 'payunivercart.dashboard.mask';
const PERIOD_KEY = 'payunivercart.dashboard.period';

type Period = '7' | '30' | '90';
const PERIODS: { value: Period; label: string }[] = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
];

/**
 * Dashboard home — Apple/Linear-tier visão geral.
 *
 * Hierarchy:
 *   1. Greeting + period switcher + mask toggle
 *   2. Stat band — 4 large KPIs (Faturamento, Pedidos pagos, Ticket médio,
 *      Taxa de aprovação) com sparklines onde faz sentido.
 *   3. Hero chart — receita por dia (inline SVG area chart, sem dep externa).
 *   4. OnboardingFloating (no layout) acompanha o produtor em toda página.
 *   5. Grid 2-col: Top produtos · Métodos de pagamento (donut).
 *   6. Atividade recente (tabela compacta).
 *
 * Decisões de copy: "GMV" → "Faturamento bruto". A barra do BR não conhece
 * jargão de founder; a meta é o produtor entender o número no primeiro
 * piscar de olho.
 */
export default function DashboardHome() {
  const session = useSession();
  const router = useRouter();
  const [masked, setMasked] = useState(false);
  const [period, setPeriod] = useState<Period>('30');

  useEffect(() => {
    try {
      setMasked(localStorage.getItem(MASK_KEY) === '1');
      const stored = localStorage.getItem(PERIOD_KEY) as Period | null;
      if (stored && (stored === '7' || stored === '30' || stored === '90')) {
        setPeriod(stored);
      }
    } catch {
      /* private mode / SSR */
    }
  }, []);

  const toggleMask = () => {
    setMasked((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MASK_KEY, next ? '1' : '0');
      } catch {
        /* noop */
      }
      return next;
    });
  };

  const selectPeriod = (next: Period) => {
    setPeriod(next);
    try {
      localStorage.setItem(PERIOD_KEY, next);
    } catch {
      /* noop */
    }
  };

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  const overview = trpc.metrics.overview.useQuery(undefined, {
    staleTime: 30_000,
    enabled: !!session.data,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const timeline = trpc.metrics.timeline.useQuery(
    { days: period },
    {
      staleTime: 30_000,
      enabled: !!session.data,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    },
  );
  const topProducts = trpc.metrics.topProducts.useQuery(
    { days: period, limit: 5 },
    { staleTime: 60_000, enabled: !!session.data },
  );
  const paymentMethods = trpc.metrics.paymentMethods.useQuery(
    { days: period },
    { staleTime: 60_000, enabled: !!session.data },
  );
  const recent = trpc.metrics.recentOrders.useQuery(
    { limit: 10 },
    {
      staleTime: 4_000,
      enabled: !!session.data,
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    },
  );

  // Derived KPIs over the chosen period — computed locally from the
  // timeline so the user can switch 7/30/90 without a second roundtrip.
  const periodStats = useMemo(() => {
    const days = timeline.data ?? [];
    const revenueCents = days.reduce((s, d) => s + d.revenueCents, 0);
    const paidOrders = days.reduce((s, d) => s + d.paidOrders, 0);
    const createdOrders = days.reduce((s, d) => s + d.createdOrders, 0);
    const avgTicketCents = paidOrders > 0 ? Math.round(revenueCents / paidOrders) : 0;
    const approvalRate = createdOrders > 0 ? paidOrders / createdOrders : 0;
    return { revenueCents, paidOrders, createdOrders, avgTicketCents, approvalRate };
  }, [timeline.data]);

  if (session.isPending) {
    return <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  const firstName = (session.data.user.name ?? 'produtor').split(' ')[0];
  const hasAnyOrders =
    (overview.data?.allTime.paidCount ?? 0) > 0 || (recent.data?.length ?? 0) > 0;

  const maskValue = (rendered: string) => (masked ? 'R$ ••••' : rendered);
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? '30 dias';

  return (
    <div className="space-y-12">
      <header className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <Kicker>Painel</Kicker>
            <Heading level={1}>Oi, {firstName}.</Heading>
            <p className="max-w-xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
              {hasAnyOrders
                ? `Seu negócio nos últimos ${periodLabel.toLowerCase()}. Atualiza em tempo real.`
                : 'Sua operação aparece aqui assim que a primeira venda cair. Comece pelos passos abaixo.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PeriodSwitcher value={period} onChange={selectPeriod} />
            <button
              type="button"
              onClick={toggleMask}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
              aria-label={masked ? 'Mostrar valores' : 'Esconder valores'}
              title={masked ? 'Mostrar valores' : 'Esconder valores (screen-share safe)'}
            >
              {masked ? <IconEye /> : <IconEyeOff />}
            </button>
          </div>
        </div>
      </header>

      {/*
        Inline onboarding wizard moved to the floating widget mounted in
        the (app)/layout.tsx — `OnboardingFloating` follows the producer
        across every page instead of only the dashboard.
       */}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Faturamento bruto"
          hint={`Soma de pedidos pagos em ${periodLabel.toLowerCase()}.`}
          value={maskValue(formatCents(periodStats.revenueCents, 'BRL'))}
          tone="brand"
          icon={<IconRevenue />}
        />
        <KpiCard
          label="Pedidos pagos"
          hint={`${periodStats.createdOrders.toLocaleString('pt-BR')} criados no período.`}
          value={periodStats.paidOrders.toLocaleString('pt-BR')}
          icon={<IconOrders />}
        />
        <KpiCard
          label="Ticket médio"
          hint="Receita ÷ pedidos pagos."
          value={maskValue(
            periodStats.paidOrders > 0 ? formatCents(periodStats.avgTicketCents, 'BRL') : '—',
          )}
          icon={<IconTicket />}
        />
        <KpiCard
          label="Taxa de aprovação"
          hint="Pedidos pagos ÷ criados."
          value={
            periodStats.createdOrders > 0 ? `${(periodStats.approvalRate * 100).toFixed(1)}%` : '—'
          }
          icon={<IconCheckCircle />}
        />
      </section>

      <section className="rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-sm)]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <Heading level={3}>Receita por dia</Heading>
            <p className="text-[13px] text-[var(--color-fg-subtle)]">
              {periodLabel}. Cada barra é o total de pedidos pagos no fuso de São Paulo.
            </p>
          </div>
          <RevenueLegend totalCents={periodStats.revenueCents} maskValue={maskValue} />
        </div>
        <RevenueChart data={timeline.data ?? []} isPending={timeline.isPending} masked={masked} />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Surface className="p-6">
          <header className="mb-5 flex items-baseline justify-between">
            <Heading level={3}>Produtos mais vendidos</Heading>
            <span className="text-[12px] text-[var(--color-fg-subtle)]">{periodLabel}</span>
          </header>
          {topProducts.isPending ? (
            <SkeletonRows n={3} />
          ) : (topProducts.data?.length ?? 0) === 0 ? (
            <EmptyHint text="Sem vendas pagas ainda no período." />
          ) : (
            <ul className="space-y-3">
              {topProducts.data?.map((p, idx) => (
                <li
                  key={p.productId}
                  className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-[var(--color-surface-muted)]"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-50)] font-semibold text-[13px] text-[var(--color-brand-700)]">
                    {idx + 1}
                  </span>
                  <Link
                    href={`/produtos/${p.productId}`}
                    className="min-w-0 flex-1 font-medium text-[14px] text-[var(--color-fg)] hover:text-[var(--color-brand-700)]"
                  >
                    <span className="block truncate">{p.name}</span>
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      {p.paidOrders} {p.paidOrders === 1 ? 'pedido' : 'pedidos'}
                    </span>
                  </Link>
                  <span className="shrink-0 font-semibold text-[14px] text-[var(--color-fg)] tabular-nums">
                    {maskValue(formatCents(p.revenueCents, 'BRL'))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface className="p-6">
          <header className="mb-5 flex items-baseline justify-between">
            <Heading level={3}>Métodos de pagamento</Heading>
            <span className="text-[12px] text-[var(--color-fg-subtle)]">{periodLabel}</span>
          </header>
          {paymentMethods.isPending ? (
            <SkeletonRows n={3} />
          ) : (paymentMethods.data?.length ?? 0) === 0 ? (
            <EmptyHint text="Sem cobranças confirmadas ainda." />
          ) : (
            <PaymentMethodsBreakdown data={paymentMethods.data ?? []} maskValue={maskValue} />
          )}
        </Surface>
      </section>

      {hasAnyOrders && recent.data && recent.data.length > 0 ? (
        <section>
          <div className="mb-5 flex items-baseline justify-between">
            <Heading level={3}>Últimos pedidos</Heading>
            <p className="text-[13px] text-[var(--color-fg-subtle)]">Atualiza a cada 5s</p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
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
                    onClick={() => router.push(`/pedidos/${order.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        router.push(`/pedidos/${order.id}`);
                      }
                    }}
                    tabIndex={0}
                    aria-label={`Abrir pedido ${order.publicReference}`}
                    className="cursor-pointer transition hover:bg-[var(--color-surface-muted)]/60 focus:bg-[var(--color-surface-muted)] focus:outline-none"
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
                    <td className="px-5 py-3 font-medium text-[var(--color-fg)] tabular-nums">
                      {maskValue(formatCents(order.totalCents, order.currency))}
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
      ) : !hasAnyOrders ? (
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
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  KPI card — Apple-tier: icon bubble + label + huge number + thin hint      */
/* -------------------------------------------------------------------------- */

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  tone?: 'brand';
}) {
  const bubbleClass =
    tone === 'brand'
      ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
      : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]';
  return (
    <article className="flex flex-col gap-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-sm)] transition hover:shadow-[var(--shadow-md)]">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${bubbleClass}`}>
          {icon}
        </span>
        <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      </div>
      <p className="font-semibold text-[30px] text-[var(--color-fg)] tabular-nums leading-none tracking-tight">
        {value}
      </p>
      <p className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">{hint}</p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Period switcher — segmented control                                       */
/* -------------------------------------------------------------------------- */

function PeriodSwitcher({
  value,
  onChange,
}: {
  value: Period;
  onChange: (next: Period) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
      {PERIODS.map((p) => {
        const active = p.value === value;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={`rounded-full px-3 py-1 font-medium text-[12px] transition ${
              active
                ? 'bg-[var(--color-fg)] text-[var(--color-fg-inverse)]'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
            }`}
            aria-pressed={active}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Revenue chart — inline SVG area chart, zero deps                          */
/* -------------------------------------------------------------------------- */

function RevenueLegend({
  totalCents,
  maskValue,
}: {
  totalCents: number;
  maskValue: (s: string) => string;
}) {
  return (
    <div className="text-right">
      <p className="font-semibold text-[20px] text-[var(--color-fg)] tabular-nums leading-none">
        {maskValue(formatCents(totalCents, 'BRL'))}
      </p>
      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        Total no período
      </p>
    </div>
  );
}

function RevenueChart({
  data,
  isPending,
  masked,
}: {
  data: { date: string; revenueCents: number; paidOrders: number }[];
  isPending: boolean;
  masked: boolean;
}) {
  if (isPending) {
    return <div className="h-[240px] animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />;
  }
  if (data.length === 0 || data.every((d) => d.revenueCents === 0)) {
    return (
      <div className="grid h-[240px] place-items-center rounded-xl border border-[var(--color-border)] border-dashed">
        <p className="text-[13px] text-[var(--color-fg-subtle)]">
          {masked
            ? 'Valores ocultos.'
            : 'Sem receita no período. Compartilhe seu link de checkout pra começar.'}
        </p>
      </div>
    );
  }

  const width = 1100;
  const height = 240;
  const padX = 16;
  const padTop = 16;
  const padBottom = 32;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const max = Math.max(...data.map((d) => d.revenueCents), 1);
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const points = data.map((d, i) => {
    const x = padX + i * stepX;
    const y = padTop + innerH - (d.revenueCents / max) * innerH;
    return { x, y, d };
  });

  // Smooth path via Catmull-Rom → cubic Bezier conversion. Keeps the
  // line elegant on sparse data without making it sag below baseline.
  const linePath = points
    .map((p, i) =>
      i === 0 ? `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}` : `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
    )
    .join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1]?.x.toFixed(2)} ${padTop + innerH} L ${points[0]?.x.toFixed(2)} ${padTop + innerH} Z`;

  const ticks = pickXAxisTicks(data);
  const formatTickShort = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-[240px] w-full"
      role="img"
      aria-label="Receita por dia"
    >
      <defs>
        <linearGradient id="revenueGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Baseline grid — 4 horizontal hairlines */}
      {[0.25, 0.5, 0.75, 1].map((frac) => (
        <line
          key={frac}
          x1={padX}
          x2={width - padX}
          y1={padTop + innerH * (1 - frac)}
          y2={padTop + innerH * (1 - frac)}
          stroke="var(--color-border-subtle)"
          strokeDasharray="2 4"
        />
      ))}
      <path d={areaPath} fill="url(#revenueGradient)" />
      <path
        d={linePath}
        fill="none"
        stroke="var(--color-brand-500)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p, idx) =>
        p.d.revenueCents > 0 ? (
          <circle
            key={p.d.date}
            cx={p.x}
            cy={p.y}
            r={idx === points.length - 1 ? 4 : 2.5}
            fill="var(--color-surface)"
            stroke="var(--color-brand-500)"
            strokeWidth="1.6"
          />
        ) : null,
      )}
      {ticks.map((idx) => {
        const p = points[idx];
        if (!p) return null;
        return (
          <text
            key={`tick-${p.d.date}`}
            x={p.x}
            y={height - 10}
            textAnchor="middle"
            className="fill-[var(--color-fg-subtle)]"
            fontSize="11"
          >
            {formatTickShort(p.d.date)}
          </text>
        );
      })}
    </svg>
  );
}

/** 4–6 evenly spaced x-axis ticks so labels never collide. */
function pickXAxisTicks(data: { date: string }[]): number[] {
  const n = data.length;
  if (n <= 6) return data.map((_, i) => i);
  const want = 6;
  const step = Math.max(1, Math.round((n - 1) / (want - 1)));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Payment methods breakdown — proportional bars (donut would need more deps)*/
/* -------------------------------------------------------------------------- */

const METHOD_LABEL: Record<'pix' | 'credit_card' | 'boleto', string> = {
  pix: 'Pix',
  credit_card: 'Cartão de crédito',
  boleto: 'Boleto',
};
const METHOD_COLOR: Record<'pix' | 'credit_card' | 'boleto', string> = {
  pix: 'var(--color-brand-500)',
  credit_card: '#0b6bcb',
  boleto: '#b76e00',
};

function PaymentMethodsBreakdown({
  data,
  maskValue,
}: {
  data: { method: 'pix' | 'credit_card' | 'boleto'; paidCount: number; revenueCents: number }[];
  maskValue: (s: string) => string;
}) {
  const total = data.reduce((s, d) => s + d.revenueCents, 0);
  const sorted = [...data].sort((a, b) => b.revenueCents - a.revenueCents);

  return (
    <div className="space-y-4">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
        {sorted.map((d) => {
          const pct = total > 0 ? (d.revenueCents / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <span
              key={d.method}
              style={{ width: `${pct}%`, background: METHOD_COLOR[d.method] }}
              aria-label={`${METHOD_LABEL[d.method]} ${pct.toFixed(0)}%`}
            />
          );
        })}
      </div>
      <ul className="space-y-2">
        {sorted.map((d) => {
          const pct = total > 0 ? (d.revenueCents / total) * 100 : 0;
          return (
            <li key={d.method} className="flex items-center justify-between gap-3 text-[14px]">
              <span className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: METHOD_COLOR[d.method] }}
                />
                <span className="font-medium text-[var(--color-fg)]">{METHOD_LABEL[d.method]}</span>
                <span className="text-[12px] text-[var(--color-fg-subtle)]">
                  · {d.paidCount} {d.paidCount === 1 ? 'pedido' : 'pedidos'}
                </span>
              </span>
              <span className="font-semibold text-[var(--color-fg)] tabular-nums">
                {maskValue(formatCents(d.revenueCents, 'BRL'))}
                <span className="ml-2 font-normal text-[12px] text-[var(--color-fg-subtle)]">
                  {pct.toFixed(0)}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeletons + empty states                                                  */
/* -------------------------------------------------------------------------- */

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: n }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton row, no semantic identity
          key={i}
          className="h-10 animate-pulse rounded-xl bg-[var(--color-surface-muted)]"
        />
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface-muted)] px-4 py-6 text-center text-[13px] text-[var(--color-fg-subtle)]">
      {text}
    </p>
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

/* -------------------------------------------------------------------------- */
/*  Status pill (kept from previous version)                                  */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Icons — heroicons-mini style, 16×16 stroke 1.5                            */
/* -------------------------------------------------------------------------- */

function IconRevenue() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 12l3.5-4 3 2L13 4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 4H13v3.5" />
    </svg>
  );
}
function IconOrders() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path strokeLinecap="round" d="M5.5 6.5h5M5.5 9h5" />
    </svg>
  );
}
function IconTicket() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.5 6V4.5A1 1 0 013.5 3.5h9a1 1 0 011 1V6a1.5 1.5 0 100 3v1.5a1 1 0 01-1 1h-9a1 1 0 01-1-1V9a1.5 1.5 0 100-3z"
      />
    </svg>
  );
}
function IconCheckCircle() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.75 8.25l1.5 1.5 3-3" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
      />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2 2l12 12M6.5 6.5a2 2 0 002.8 2.8M3.5 4.5C2.4 5.5 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.1 0 2.1-.3 2.9-.7M12 10c1.5-1 2.5-2 2.5-2S12 3.5 8 3.5c-.6 0-1.2.1-1.7.3"
      />
    </svg>
  );
}
