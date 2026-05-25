'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import { Heading, Kicker } from '../../../components/ui';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Affiliate-facing dashboard. Distinct from the producer-side
 * /produtos / /pedidos / etc. views — the SAME logged-in user
 * shows up here in a different role: the person promoting other
 * producers' products.
 *
 * Cross-workspace by design: every membership the user holds across
 * different producer workspaces aggregates into one view. The endpoint
 * `affiliates.myDashboard` is an authedProcedure (not workspaceProcedure)
 * for exactly this reason.
 *
 * Layout:
 *   - Hero — publicCode chip (the producer's affiliate link suffix)
 *     + lifetime earned + copy-link button.
 *   - 3 commission StatCards (pending / available / paid)
 *   - Memberships table — every producer the affiliate joined.
 *   - Recent commissions — last 20 with workspace + cycle + status.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export default function AffiliateDashboardPage() {
  const data = trpc.affiliates.myDashboard.useQuery();

  if (data.isPending) {
    return (
      <div className="flex flex-col gap-8">
        <div className="h-40 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]" />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
              key={i}
              className="h-28 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!data.data) {
    return (
      <p className="text-[14px] text-[var(--color-danger)]">
        Não foi possível carregar seu painel de afiliado.
      </p>
    );
  }

  const { affiliate, memberships, summary, recentCommissions } = data.data;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-10"
    >
      <header className="flex flex-col gap-3">
        <Kicker>conta · afiliado</Kicker>
        <Heading level={1}>Painel de afiliado.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Seus links, comissões e produtos que você está divulgando ao redor de todos os produtores
          que te aceitaram.
        </p>
      </header>

      {/* Identity hero */}
      <IdentityHero
        publicCode={affiliate.publicCode}
        displayName={affiliate.displayName}
        lifetimeEarnedCents={affiliate.lifetimeEarnedCents}
      />

      {/* Commission summary */}
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="A receber"
          subtitle="Liberadas após janela de reembolso"
          value={formatCents(summary.availableCents, 'BRL')}
          tone="success"
        />
        <StatCard
          label="Pendentes"
          subtitle="Aguardando janela de reembolso passar"
          value={formatCents(summary.pendingCents, 'BRL')}
          tone="warning"
        />
        <StatCard
          label="Já pagas"
          subtitle="Histórico de saques"
          value={formatCents(summary.paidCents, 'BRL')}
          tone="muted"
        />
      </section>

      {/* Memberships */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Produtores ({memberships.length})
        </h2>
        {memberships.length === 0 ? (
          <p className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-12 text-center text-[13px] text-[var(--color-fg-subtle)]">
            Você ainda não é afiliado de nenhum produtor. Peça um convite ou aceite um link de
            inscrição.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {memberships.map((m) => (
              <li
                key={m.workspaceId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-semibold text-[14px] text-[var(--color-fg)]">
                    {m.workspaceName}
                  </span>
                  <span className="text-[11px] text-[var(--color-fg-subtle)]">
                    {m.programName ?? 'Programa padrão'}
                  </span>
                </div>
                <MembershipBadge status={m.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent commissions */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Comissões recentes ({recentCommissions.length})
        </h2>
        {recentCommissions.length === 0 ? (
          <p className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-12 text-center text-[13px] text-[var(--color-fg-subtle)]">
            Suas comissões aparecem aqui assim que a primeira indicação fechar venda.
          </p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--color-surface-muted)]/60">
                <tr className="text-left">
                  <Th>Produtor</Th>
                  <Th>Bruto</Th>
                  <Th>Sua comissão</Th>
                  <Th>Status</Th>
                  <Th>Quando</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                <AnimatePresence initial={false}>
                  {recentCommissions.map((c) => (
                    <motion.tr
                      key={c.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="transition hover:bg-[var(--color-surface-muted)]/40"
                    >
                      <Td>
                        <span className="font-medium text-[var(--color-fg)]">
                          {c.workspaceName}
                        </span>
                        {c.cycleNumber ? (
                          <span className="ml-2 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                            ciclo {c.cycleNumber}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <span className="text-[var(--color-fg-muted)] tabular-nums">
                          {formatCents(c.grossAmountCents, 'BRL')}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-semibold text-[var(--color-fg)] tabular-nums">
                          {formatCents(c.commissionAmountCents, 'BRL')}
                        </span>
                      </Td>
                      <Td>
                        <CommissionStatus status={c.status} />
                      </Td>
                      <Td>
                        <time
                          className="text-[11px] text-[var(--color-fg-subtle)]"
                          dateTime={new Date(c.createdAt).toISOString()}
                        >
                          {new Date(c.createdAt).toLocaleDateString('pt-BR')}
                        </time>
                      </Td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </motion.div>
  );
}

function IdentityHero({
  publicCode,
  displayName,
  lifetimeEarnedCents,
}: {
  publicCode: string;
  displayName: string;
  lifetimeEarnedCents: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Não foi possível copiar');
    }
  };
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE, delay: 0.05 }}
      className="relative overflow-hidden rounded-3xl border border-[var(--color-brand-500)]/30 bg-gradient-to-br from-[var(--color-brand-50)]/50 via-[var(--color-surface)] to-[var(--color-surface)] p-7 shadow-[0_24px_56px_-24px_rgba(22,163,74,0.22)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <span className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.16em]">
            Seu código de afiliado
          </span>
          <div className="flex items-center gap-3">
            <span className="font-bold font-mono text-[28px] text-[var(--color-fg)] tracking-tight">
              {publicCode}
            </span>
            <motion.button
              type="button"
              onClick={copy}
              whileTap={{ scale: 0.92 }}
              className="grid size-8 cursor-pointer place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-brand-50)] hover:text-[var(--color-brand-700)]"
              aria-label={copied ? 'Copiado' : 'Copiar código'}
            >
              <AnimatePresence mode="wait">
                {copied ? (
                  <motion.svg
                    key="check"
                    viewBox="0 0 16 16"
                    fill="none"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.4, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                    className="size-4 text-[var(--color-brand-700)]"
                  >
                    <title>Copiado</title>
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </motion.svg>
                ) : (
                  <motion.svg
                    key="copy"
                    viewBox="0 0 16 16"
                    fill="none"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="size-4"
                  >
                    <title>Copiar</title>
                    <rect
                      x="4"
                      y="4"
                      width="9"
                      height="9"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <path
                      d="M11 4V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  </motion.svg>
                )}
              </AnimatePresence>
            </motion.button>
          </div>
          <p className="max-w-md text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">
            Aparece como <span className="font-semibold text-[var(--color-fg)]">{displayName}</span>{' '}
            para os produtores. Use o sufixo em links de divulgação, ex:{' '}
            <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">
              ?aff={publicCode}
            </code>
            .
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
            Faturamento total
          </span>
          <span className="font-bold text-[32px] text-[var(--color-fg)] tabular-nums tracking-tight">
            {formatCents(lifetimeEarnedCents, 'BRL')}
          </span>
          <span className="text-[11px] text-[var(--color-fg-subtle)]">
            Soma das comissões liberadas + pagas
          </span>
        </div>
      </div>
    </motion.section>
  );
}

function StatCard({
  label,
  subtitle,
  value,
  tone,
}: {
  label: string;
  subtitle: string;
  value: string;
  tone: 'success' | 'warning' | 'muted';
}) {
  const cls = {
    success:
      'border-[var(--color-success)]/30 bg-gradient-to-br from-[var(--color-success-bg)]/30 to-[var(--color-surface)]',
    warning:
      'border-[var(--color-warning)]/30 bg-gradient-to-br from-[var(--color-warning-bg)]/30 to-[var(--color-surface)]',
    muted: 'border-[var(--color-border)] bg-[var(--color-surface)]',
  }[tone];
  return (
    <div className={`flex flex-col gap-2 rounded-2xl border p-5 ${cls}`}>
      <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className="font-bold text-[26px] text-[var(--color-fg)] tabular-nums tracking-tight">
        {value}
      </span>
      <span className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.4]">{subtitle}</span>
    </div>
  );
}

function MembershipBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: {
      label: 'Pendente',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    approved: {
      label: 'Aprovado',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    active: {
      label: 'Ativo',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    suspended: {
      label: 'Suspenso',
      cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    rejected: {
      label: 'Rejeitado',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  };
  const meta = map[status] ?? map.pending;
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta?.cls ?? ''}`}
    >
      {meta?.label ?? status}
    </span>
  );
}

function CommissionStatus({
  status,
}: {
  status: 'pending' | 'available' | 'paid' | 'reversed' | 'cancelled';
}) {
  const map: Record<typeof status, { label: string; cls: string }> = {
    pending: {
      label: '… Janela',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    available: {
      label: '✓ Liberada',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    paid: {
      label: '$ Paga',
      cls: 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]',
    },
    reversed: {
      label: '↩ Revertida',
      cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    cancelled: {
      label: '× Cancelada',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  };
  const meta = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.cls}`}
    >
      {meta.label}
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
