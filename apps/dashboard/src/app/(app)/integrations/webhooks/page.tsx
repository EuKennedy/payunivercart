'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Webhook monitoring page (`/integrations/webhooks`).
 *
 * Surface the `webhooks_inbound` ledger so the operator can:
 *   - See what gateway/WAHA/partner events landed and when.
 *   - Filter by status (processed / pending / error) + signature
 *     validity (valid / invalid / unknown).
 *   - Drill into a row for the raw headers + body (LGPD-sensitive,
 *     opens only on click).
 *   - Re-queue an errored event so the next gateway delivery with the
 *     same `(source, event_id)` re-runs the handler (case-c branch).
 *
 * Design priorities: dense table for triage, status pills, no autorefresh
 * (operator chooses when to refetch — avoids flickering during inspection).
 */

const EASE = [0.16, 1, 0.3, 1] as const;

type StatusFilter = 'all' | 'processed' | 'pending' | 'error';
type SignatureFilter = 'all' | 'valid' | 'invalid' | 'unknown';

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'Todos',
  processed: 'Processados',
  pending: 'Pendentes',
  error: 'Com erro',
};

const SIGNATURE_LABEL: Record<SignatureFilter, string> = {
  all: 'Qualquer assinatura',
  valid: 'Assinatura válida',
  invalid: 'Assinatura inválida',
  unknown: 'Sem assinatura',
};

export default function WebhooksPage() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [signature, setSignature] = useState<SignatureFilter>('all');
  const [source, setSource] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const list = trpc.webhooks.listInbound.useQuery({
    status,
    signature,
    source: source.trim() || undefined,
    limit: 100,
  });
  const requeue = trpc.webhooks.requeue.useMutation({
    onSuccess: () => {
      utils.webhooks.listInbound.invalidate();
      toast.success('Webhook re-enfileirado — próxima entrega do gateway re-processa.');
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-10"
    >
      <header className="flex flex-col gap-3">
        <Kicker>integrações · webhooks</Kicker>
        <Heading level={1}>Webhooks.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Toda chamada que cai aqui — Mercado Pago, Pagar.me, PagSeguro, Stripe, WAHA, parceiros
          Connect. Use o filtro de erro pra encontrar entregas que travaram antes de processar e
          re-enfileire pra próxima tentativa do gateway.
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((s) => (
            <FilterChip
              key={s}
              active={status === s}
              onClick={() => setStatus(s)}
              label={STATUS_LABEL[s]}
            />
          ))}
        </div>
        <span className="text-[12px] text-[var(--color-fg-subtle)]">·</span>
        <select
          value={signature}
          onChange={(e) => setSignature(e.target.value as SignatureFilter)}
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 font-medium text-[11px] text-[var(--color-fg-muted)] uppercase tracking-wider transition hover:border-[var(--color-border-strong)]"
        >
          {(Object.keys(SIGNATURE_LABEL) as SignatureFilter[]).map((s) => (
            <option key={s} value={s}>
              {SIGNATURE_LABEL[s]}
            </option>
          ))}
        </select>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source (mercadopago, waha, ...)"
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 font-medium text-[11px] text-[var(--color-fg-muted)] transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)]"
        />
        <Button variant="ghost" size="sm" onClick={() => list.refetch()}>
          Atualizar
        </Button>
      </section>

      {list.isPending ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
              key={i}
              className="h-14 animate-pulse rounded-xl bg-[var(--color-surface-muted)]"
            />
          ))}
        </div>
      ) : (list.data ?? []).length === 0 ? (
        <p className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-12 text-center text-[13px] text-[var(--color-fg-subtle)]">
          Nenhum webhook encontrado com esses filtros.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-muted)]/60">
              <tr className="text-left">
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Tipo</Th>
                <Th>Quando</Th>
                <Th>Assinatura</Th>
                <Th className="text-right">Ações</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="transition hover:bg-[var(--color-surface-muted)]/40">
                  <Td>
                    <StatusPill status={r.status} />
                    {r.status === 'error' && r.error ? (
                      <p className="mt-1 line-clamp-1 text-[11px] text-[var(--color-danger)]">
                        {r.error}
                      </p>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--color-fg-muted)]">
                      {r.source}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--color-fg-muted)]">
                      {r.eventType}
                    </span>
                  </Td>
                  <Td>
                    <time className="text-[12px] text-[var(--color-fg-subtle)]">
                      {formatRelative(r.processedAt ?? r.createdAt)}
                    </time>
                  </Td>
                  <Td>
                    <SignaturePill sig={r.signatureValid} />
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(r.id)}>
                        Ver
                      </Button>
                      {r.status === 'error' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => requeue.mutate({ id: r.id })}
                          disabled={requeue.isPending}
                        >
                          Re-enfileirar
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {openId ? <DetailModal id={openId} onClose={() => setOpenId(null)} /> : null}
      </AnimatePresence>
    </motion.div>
  );
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = trpc.webhooks.inboundDetail.useQuery({ id });
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={onClose}
      // biome-ignore lint/a11y/useSemanticElements: framer-motion AnimatePresence wrapping; role+aria-modal kept manually.
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-detail-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.97 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-start justify-between gap-3 border-[var(--color-border)] border-b px-6 py-4">
          <div className="flex flex-col gap-1">
            <h3
              id="webhook-detail-title"
              className="font-semibold text-[16px] text-[var(--color-fg)]"
            >
              Webhook detail
            </h3>
            <p className="font-mono text-[11px] text-[var(--color-fg-subtle)]">{id}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {detail.isPending ? (
            <p className="text-[13px] text-[var(--color-fg-muted)]">Carregando…</p>
          ) : detail.data ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                <Meta label="Source" value={detail.data.source} />
                <Meta label="Event id" value={detail.data.eventId} />
                <Meta label="Event type" value={detail.data.eventType} />
                <Meta label="Signature" value={detail.data.signatureValid} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Headers
                </span>
                <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 font-mono text-[11px] text-[var(--color-fg)]">
                  {JSON.stringify(detail.data.rawHeaders, null, 2)}
                </pre>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Body
                </span>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 font-mono text-[11px] text-[var(--color-fg)]">
                  {detail.data.rawBody}
                </pre>
              </div>
              {detail.data.error ? (
                <div className="flex flex-col gap-1.5">
                  <span className="font-semibold text-[10px] text-[var(--color-danger)] uppercase tracking-[0.14em]">
                    Erro
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3 font-mono text-[11px] text-[var(--color-danger)]">
                    {detail.data.error}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-[var(--color-danger)]">
              Não foi possível carregar o detalhe.
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className="font-mono text-[12px] text-[var(--color-fg)]">{value}</span>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'cursor-pointer rounded-full border border-[var(--color-fg)] bg-[var(--color-fg)] px-3 py-1 font-semibold text-[11px] text-[var(--color-fg-inverse)] uppercase tracking-wider'
          : 'cursor-pointer rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 font-medium text-[11px] text-[var(--color-fg-muted)] uppercase tracking-wider transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
      }
    >
      {label}
    </button>
  );
}

function StatusPill({ status }: { status: 'processed' | 'pending' | 'error' }) {
  const map = {
    processed: {
      label: '✓ Processado',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    pending: {
      label: '… Pendente',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    error: { label: '↻ Erro', cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]' },
  } as const;
  const meta = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function SignaturePill({ sig }: { sig: 'valid' | 'invalid' | 'unknown' }) {
  const map = {
    valid: { label: 'Válida', cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]' },
    invalid: { label: 'Inválida', cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]' },
    unknown: {
      label: 'Sem',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  } as const;
  const meta = map[sig];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-3 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.12em] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>;
}

function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'agora mesmo';
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  return d.toLocaleString('pt-BR');
}
