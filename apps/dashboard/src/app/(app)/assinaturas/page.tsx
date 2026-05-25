'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Heading, Kicker } from '../../../components/ui';
import { useSession } from '../../../lib/auth';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Assinaturas — list view + cancel action. Shows every subscription
 * the workspace ever opened, latest first. Status badges follow the
 * canonical enum (pending/active/paused/cancelled/expired). Cancel
 * round-trips MP `/preapproval PUT status=cancelled` then flips the
 * local row.
 */

type SubStatus = 'pending' | 'active' | 'paused' | 'cancelled' | 'expired';

const STATUS_LABEL: Record<SubStatus, string> = {
  pending: 'Aguardando',
  active: 'Ativa',
  paused: 'Pausada',
  cancelled: 'Cancelada',
  expired: 'Expirada',
};
const STATUS_TONE: Record<SubStatus, string> = {
  pending: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  active: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
  paused: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  cancelled: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  expired: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
};
const FILTERS: { value: SubStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'active', label: 'Ativas' },
  { value: 'pending', label: 'Aguardando' },
  { value: 'paused', label: 'Pausadas' },
  { value: 'cancelled', label: 'Canceladas' },
];

export default function AssinaturasPage() {
  const session = useSession();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<SubStatus | 'all'>('all');

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  const list = trpc.subscriptions.listSubscriptions.useQuery(
    { limit: 100, ...(filter !== 'all' ? { status: filter } : {}) },
    { staleTime: 10_000, refetchInterval: 15_000, refetchIntervalInBackground: false },
  );
  const cancel = trpc.subscriptions.cancelSubscription.useMutation({
    onSuccess: () => {
      utils.subscriptions.listSubscriptions.invalidate();
      setCancelTarget(null);
      setCancelReason('');
    },
  });

  // Confirm-modal state for the cancel flow. Holds the row being
  // cancelled + the producer-supplied reason. Cleared on success.
  const [cancelTarget, setCancelTarget] = useState<{
    id: string;
    customerName: string;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  if (session.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>vendas · assinaturas</Kicker>
        <Heading level={1}>Assinaturas ativas.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Acompanhe quem está pagando recorrente e a próxima cobrança de cada cliente. Atualiza a
          cada 15s.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = f.value === filter;
          return (
            <motion.button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              whileTap={{ scale: 0.94 }}
              className={`cursor-pointer rounded-full border px-4 py-1.5 font-medium text-[12px] transition ${
                active
                  ? 'border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-fg-inverse)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
              }`}
              aria-pressed={active}
            >
              {f.label}
            </motion.button>
          );
        })}
      </div>

      {list.isPending ? (
        <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando assinaturas…</p>
      ) : !list.data || list.data.length === 0 ? (
        <div className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-8 py-12 text-center">
          <p className="font-semibold text-[16px] text-[var(--color-fg)]">
            Nenhuma assinatura ainda.
          </p>
          <p className="mt-2 text-[14px] text-[var(--color-fg-muted)]">
            Cadastre um produto como "Assinatura" em /produtos → criar planos → compartilhe o link.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
          <table className="w-full text-[14px]">
            <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              <tr>
                <th className="px-5 py-3 font-semibold">Cliente</th>
                <th className="px-5 py-3 font-semibold">Produto / Plano</th>
                <th className="px-5 py-3 font-semibold">Valor</th>
                <th className="px-5 py-3 font-semibold">Próxima</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 text-right font-semibold">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {list.data.map((sub) => (
                <tr key={sub.id} className="transition hover:bg-[var(--color-surface-muted)]/60">
                  <td className="px-5 py-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-[var(--color-fg)]">{sub.customerName}</span>
                      <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {sub.customerEmail}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-[var(--color-fg)]">{sub.productName}</span>
                      <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {sub.planName} · {sub.billingPeriod === 'yearly' ? 'anual' : 'mensal'}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-semibold text-[var(--color-fg)] tabular-nums">
                    {formatCents(sub.amountCents, sub.currency)}
                    <span className="font-normal text-[11px] text-[var(--color-fg-subtle)]">
                      /{sub.billingPeriod === 'yearly' ? 'ano' : 'mês'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[var(--color-fg-muted)]">
                    {sub.nextChargeAt
                      ? new Date(sub.nextChargeAt).toLocaleDateString('pt-BR', {
                          day: '2-digit',
                          month: '2-digit',
                          year: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 font-medium text-[11px] uppercase tracking-wider ${
                        STATUS_TONE[sub.status]
                      }`}
                    >
                      {STATUS_LABEL[sub.status]}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    {sub.status === 'active' || sub.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCancelTarget({ id: sub.id, customerName: sub.customerName })
                        }
                        disabled={cancel.isPending}
                        className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cancel.error ? (
        <p className="text-[13px] text-[var(--color-danger)]">{cancel.error.message}</p>
      ) : null}

      <AnimatePresence>
        {cancelTarget ? (
          <CancelConfirmModal
            customerName={cancelTarget.customerName}
            reason={cancelReason}
            onReasonChange={setCancelReason}
            loading={cancel.isPending}
            onConfirm={() => {
              cancel.mutate({
                id: cancelTarget.id,
                reason: cancelReason.trim() || undefined,
              });
            }}
            onCancel={() => {
              setCancelTarget(null);
              setCancelReason('');
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CancelConfirmModal({
  customerName,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  loading,
}: {
  customerName: string;
  reason: string;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onCancel}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div
        className="mx-4 w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.92, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, y: 12, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      >
        <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">Cancelar assinatura?</h3>
        <p className="mt-2 text-[14px] text-[var(--color-fg-muted)] leading-[1.5]">
          A assinatura de{' '}
          <span className="font-semibold text-[var(--color-fg)]">{customerName}</span> será
          cancelada no Mercado Pago e no banco. As cobranças futuras param imediatamente.
        </p>
        <label className="mt-5 flex flex-col gap-2">
          <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">
            Motivo (opcional)
          </span>
          <textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Ex.: cliente pediu pelo WhatsApp, falha de pagamento recorrente, etc."
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          />
          <span className="text-[11px] text-[var(--color-fg-subtle)]">
            Aparece no histórico interno + opcionalmente no email de despedida.
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="cursor-pointer rounded-lg border border-[var(--color-border)] px-4 py-2 font-medium text-[13px] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            Voltar
          </button>
          <motion.button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            whileTap={{ scale: 0.97 }}
            className="cursor-pointer rounded-lg bg-[var(--color-danger)] px-4 py-2 font-semibold text-[13px] text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {loading ? 'Cancelando…' : 'Cancelar assinatura'}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
