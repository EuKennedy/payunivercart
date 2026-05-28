'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../components/ui';
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
          <div className="flex flex-col items-center gap-5 rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-14 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-[var(--color-brand-50)] text-[var(--color-brand-700)]">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Vitrine"
              >
                <path d="M3 9h18" />
                <path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
                <path d="M9 21V12" />
                <path d="M15 21V12" />
                <path d="M5 9 7 4h10l2 5" />
              </svg>
            </div>
            <div className="flex max-w-md flex-col gap-2">
              <Heading level={3}>Você ainda não tem afiliações.</Heading>
              <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
                Explore os produtos abertos pra afiliação e ganhe comissão a cada venda gerada pelo
                seu link.
              </p>
            </div>
            <Link href="/afiliar">
              <Button size="md">Ver produtos disponíveis</Button>
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {memberships.map((m) => (
              <MembershipRow key={m.programId} membership={m} />
            ))}
          </ul>
        )}
      </section>

      {/* Payouts */}
      <PayoutsSection
        memberships={memberships.filter((m) => m.status === 'approved')}
        availableCents={summary.availableCents}
      />

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

/**
 * Single membership row with inline link copy/share. Approved rows
 * surface the tracking URL (`/a/:slug` on the public checkout host) so
 * the affiliate can grab it without leaving the page. Pending /
 * rejected / suspended rows show only the status badge.
 *
 * The checkout host is read from `NEXT_PUBLIC_CHECKOUT_URL` (Coolify
 * env) and falls back to `pay.univercart.com` for local dev.
 */
function MembershipRow({
  membership,
}: {
  membership: {
    workspaceId: string;
    workspaceName: string;
    status: string;
    programId: string;
    programName: string | null;
    linkSlug: string | null;
    productSlug: string | null;
  };
}) {
  const [copied, setCopied] = useState(false);
  const checkoutBase = (
    process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://pay.univercart.com'
  ).replace(/\/$/, '');
  const trackingUrl = membership.linkSlug ? `${checkoutBase}/a/${membership.linkSlug}` : null;
  const showLink = membership.status === 'approved' && trackingUrl;

  const copyUrl = async () => {
    if (!trackingUrl) return;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopied(true);
      toast.success('Link copiado.');
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Não foi possível copiar.');
    }
  };

  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-[14px] text-[var(--color-fg)]">
            {membership.workspaceName}
          </span>
          <span className="text-[11px] text-[var(--color-fg-subtle)]">
            {membership.programName ?? 'Programa padrão'}
          </span>
        </div>
        <MembershipBadge status={membership.status} />
      </div>

      {showLink ? (
        <div className="flex flex-col gap-2 rounded-xl bg-[var(--color-surface-muted)] p-3 sm:flex-row sm:items-center">
          <code className="flex-1 truncate font-mono text-[12px] text-[var(--color-fg)]">
            {trackingUrl}
          </code>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={copyUrl}
              className="cursor-pointer rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]"
            >
              {copied ? 'Copiado ✓' : 'Copiar link'}
            </button>
            <a
              href={trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer rounded-full bg-[var(--color-brand-600)] px-3 py-1.5 font-medium text-[12px] text-white transition hover:bg-[var(--color-brand-700)]"
            >
              Abrir
            </a>
          </div>
        </div>
      ) : membership.status === 'pending' ? (
        <span className="text-[11px] text-[var(--color-fg-subtle)]">
          O link será gerado assim que o produtor aprovar sua afiliação.
        </span>
      ) : null}
    </li>
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

/* -------------------------------------------------------------------------- */
/* PayoutsSection — affiliate-side "Sacar" surface.                            */
/*                                                                            */
/* Shows two pieces: a "Solicitar saque" CTA that opens a modal listing the   */
/* approved memberships (one button per workspace because each producer is a  */
/* separate financial settlement), and a "Meus saques" history table fed by   */
/* `affiliates.myPayouts`.                                                    */
/* -------------------------------------------------------------------------- */

type Membership = {
  workspaceId: string;
  workspaceName: string;
  status: string;
  programId: string;
  programName: string | null;
  linkSlug: string | null;
  productSlug: string | null;
};

function PayoutsSection({
  memberships,
  availableCents,
}: {
  memberships: Membership[];
  availableCents: number;
}) {
  const payouts = trpc.affiliates.myPayouts.useQuery();
  const utils = trpc.useUtils();
  const request = trpc.affiliates.requestMyPayout.useMutation({
    onSuccess: ({ totalCents }) => {
      utils.affiliates.myPayouts.invalidate();
      utils.affiliates.myDashboard.invalidate();
      toast.success(`Saque solicitado · ${formatCents(totalCents, 'BRL')}`);
      setModalOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });
  const [modalOpen, setModalOpen] = useState(false);

  const canRequest = availableCents > 0 && memberships.length > 0;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Meus saques
          </h2>
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            Solicite o saque das suas comissões liberadas. Cada produtor é uma transferência
            separada.
          </p>
        </div>
        <Button
          size="md"
          disabled={!canRequest}
          onClick={() => setModalOpen(true)}
          title={canRequest ? 'Solicitar saque' : 'Sem comissões liberadas para saque no momento.'}
        >
          {canRequest
            ? `Solicitar saque · ${formatCents(availableCents, 'BRL')}`
            : 'Sem saldo disponível'}
        </Button>
      </header>

      {payouts.isPending ? (
        <div className="grid gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
              key={i}
              className="h-14 animate-pulse rounded-xl bg-[var(--color-surface-muted)]"
            />
          ))}
        </div>
      ) : (payouts.data ?? []).length === 0 ? (
        <p className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-10 text-center text-[13px] text-[var(--color-fg-subtle)]">
          Você ainda não solicitou nenhum saque. Os pedidos aparecem aqui com o status atualizado
          pelo produtor.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-muted)]/60">
              <tr className="text-left">
                <Th>Produtor</Th>
                <Th>Valor</Th>
                <Th>Status</Th>
                <Th>Quando</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(payouts.data ?? []).map((p) => (
                <tr key={p.id}>
                  <Td>
                    <span className="font-medium text-[var(--color-fg)]">{p.workspaceName}</span>
                  </Td>
                  <Td>
                    <span className="font-semibold text-[var(--color-fg)] tabular-nums">
                      {formatCents(p.totalAmountCents, p.currency)}
                    </span>
                  </Td>
                  <Td>
                    <PayoutStatusPill status={p.status} />
                    {p.status === 'rejected' && p.failureReason ? (
                      <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                        {p.failureReason}
                      </p>
                    ) : null}
                    {p.status === 'paid' && p.gatewayTransactionId ? (
                      <p className="mt-1 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                        ref {p.gatewayTransactionId}
                      </p>
                    ) : null}
                  </Td>
                  <Td>
                    <time className="text-[12px] text-[var(--color-fg-subtle)]">
                      {p.paidAt
                        ? `pago em ${new Date(p.paidAt).toLocaleDateString('pt-BR')}`
                        : p.reviewedAt
                          ? `revisado em ${new Date(p.reviewedAt).toLocaleDateString('pt-BR')}`
                          : `solicitado em ${new Date(p.requestedAt).toLocaleDateString('pt-BR')}`}
                    </time>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {modalOpen ? (
          <RequestPayoutModal
            memberships={memberships}
            pending={request.isPending}
            onClose={() => setModalOpen(false)}
            onConfirm={(workspaceId) => request.mutate({ workspaceId })}
          />
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function PayoutStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    requested: {
      label: 'Solicitado',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    reviewing: {
      label: 'Em análise',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    approved: {
      label: 'Aprovado',
      cls: 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]',
    },
    processing: {
      label: 'Processando',
      cls: 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]',
    },
    paid: {
      label: '✓ Pago',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    rejected: {
      label: 'Recusado',
      cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    cancelled: {
      label: 'Cancelado',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  };
  const meta = map[status] ?? map.requested;
  if (!meta) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function RequestPayoutModal({
  memberships,
  pending,
  onClose,
  onConfirm,
}: {
  memberships: Membership[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (workspaceId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(memberships[0]?.workspaceId ?? null);

  return (
    <motion.div
      key="backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={pending ? undefined : onClose}
      // biome-ignore lint/a11y/useSemanticElements: framer-motion AnimatePresence on <dialog> is awkward; keeping role+aria-modal manually.
      role="dialog"
      aria-modal="true"
      aria-labelledby="payout-modal-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.97 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)]"
      >
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <h3
              id="payout-modal-title"
              className="font-semibold text-[17px] text-[var(--color-fg)] tracking-[-0.01em]"
            >
              Solicitar saque
            </h3>
            <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
              Escolha o produtor que vai liberar o pagamento. Cada solicitação vira uma
              transferência separada — o produtor revisa e paga via Pix.
            </p>
          </div>
          <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
            {memberships.map((m) => {
              const active = selected === m.workspaceId;
              return (
                <li key={m.workspaceId}>
                  <button
                    type="button"
                    onClick={() => setSelected(m.workspaceId)}
                    className={
                      active
                        ? 'flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-3 text-left ring-2 ring-[var(--color-brand-500)]/15 transition'
                        : 'flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-500)]/50'
                    }
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold text-[14px] text-[var(--color-fg)]">
                        {m.workspaceName}
                      </span>
                      <span className="text-[11px] text-[var(--color-fg-subtle)]">
                        {m.programName ?? 'Programa padrão'}
                      </span>
                    </span>
                    {active ? (
                      <span
                        aria-hidden
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-500)] text-white"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="size-3"
                        >
                          <title>Selecionado</title>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 8.5L7 11.5 12 5.5"
                          />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex items-center justify-end gap-2 border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]/40 px-6 py-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={!selected || pending}
            onClick={() => selected && onConfirm(selected)}
          >
            {pending ? 'Enviando…' : 'Confirmar solicitação'}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
