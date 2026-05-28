'use client';

import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@payunivercart/shared/webhooks/events';
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Webhooks surface (`/integrations/webhooks`).
 *
 * Three tabs:
 *   1. "Entradas"  — inbound monitoring (gateway/WAHA/partner POSTs).
 *      Filter + table + detail modal + re-enqueue (kept from v1).
 *   2. "Endpoints" — producer-registered subscriptions. Create, list,
 *      pause, regenerate secret, remove. Secret only revealed once at
 *      creation/rotation via a "copy-now" modal.
 *   3. "Saídas"    — outbound deliveries with retry + payload preview.
 *
 * Tabs use the same `motion layoutId` pill pattern as `/integrations/pixels`
 * to stay visually consistent across the producer surface.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

type TabId = 'inbound' | 'endpoints' | 'outbound';

const TABS: { id: TabId; label: string; description: string }[] = [
  { id: 'inbound', label: 'Entradas', description: 'Webhooks recebidos pela plataforma' },
  { id: 'endpoints', label: 'Endpoints', description: 'Seus destinos cadastrados' },
  { id: 'outbound', label: 'Saídas', description: 'Eventos enviados para seus endpoints' },
];

export default function WebhooksPage() {
  const [activeTab, setActiveTab] = useState<TabId>('inbound');

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
          Connect — e todo evento que sai pros seus endpoints. Inspecione, replique, rotacione
          secrets sem reabrir issue de suporte.
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="Webhook sections"
        className="inline-flex w-fit rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-sm)]"
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={
                isActive
                  ? 'relative cursor-pointer rounded-xl px-4 py-2 font-semibold text-[13px] text-[var(--color-fg)] transition'
                  : 'relative cursor-pointer rounded-xl px-4 py-2 font-medium text-[13px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]'
              }
            >
              {isActive ? (
                <motion.span
                  layoutId="webhooks-tab-pill"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-br from-[var(--color-brand-50)] to-[var(--color-surface-muted)] ring-1 ring-[var(--color-brand-500)]/30"
                  aria-hidden
                />
              ) : null}
              <span className="relative">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <AnimatePresence mode="wait">
        {activeTab === 'inbound' ? (
          <motion.section
            key="inbound"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <InboundTab />
          </motion.section>
        ) : null}

        {activeTab === 'endpoints' ? (
          <motion.section
            key="endpoints"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <EndpointsTab />
          </motion.section>
        ) : null}

        {activeTab === 'outbound' ? (
          <motion.section
            key="outbound"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: -8 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <DeliveriesTab />
          </motion.section>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* TAB 1 — INBOUND                                                            */
/* -------------------------------------------------------------------------- */

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

function InboundTab() {
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
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
      </div>

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
                    <InboundStatusPill status={r.status} />
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
        {openId ? <InboundDetailModal id={openId} onClose={() => setOpenId(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function InboundDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
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

/* -------------------------------------------------------------------------- */
/* TAB 2 — ENDPOINTS                                                          */
/* -------------------------------------------------------------------------- */

type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  secretPrefix: string;
  isActive: boolean;
  createdAt: Date | string;
  lastDeliveredAt: Date | string | null;
};

const EVENT_GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'order.', label: 'Pedidos' },
  { prefix: 'transaction.', label: 'Transações' },
  { prefix: 'subscription.', label: 'Assinaturas' },
  { prefix: 'affiliate.', label: 'Afiliados' },
  { prefix: 'marketplace.', label: 'Marketplace' },
];

function EndpointsTab() {
  const utils = trpc.useUtils();
  const list = trpc.webhooks.endpointsList.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<EndpointRow | null>(null);
  const [secretReveal, setSecretReveal] = useState<{ secret: string; url: string } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<EndpointRow | null>(null);
  const [pendingRotate, setPendingRotate] = useState<EndpointRow | null>(null);

  const create = trpc.webhooks.endpointsCreate.useMutation({
    onSuccess: (data, variables) => {
      utils.webhooks.endpointsList.invalidate();
      setShowForm(false);
      setSecretReveal({ secret: data.secret, url: variables.url });
      toast.success('Endpoint criado.');
    },
    onError: (err) => toast.error(err.message),
  });
  const update = trpc.webhooks.endpointsUpdate.useMutation({
    onSuccess: () => {
      utils.webhooks.endpointsList.invalidate();
      setEditing(null);
      toast.success('Endpoint atualizado.');
    },
    onError: (err) => toast.error(err.message),
  });
  const regenerate = trpc.webhooks.endpointsRegenerateSecret.useMutation({
    onSuccess: (data) => {
      utils.webhooks.endpointsList.invalidate();
      const rotatedUrl = pendingRotate?.url ?? '';
      setPendingRotate(null);
      setSecretReveal({ secret: data.secret, url: rotatedUrl });
      toast.success('Secret rotacionado. Atualize seu receptor.');
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.webhooks.endpointsRemove.useMutation({
    onSuccess: () => {
      utils.webhooks.endpointsList.invalidate();
      setPendingRemove(null);
      toast.success('Endpoint removido.');
    },
    onError: (err) => toast.error(err.message),
  });
  const test = trpc.webhooks.testFire.useMutation({
    onSuccess: () => toast.success('Evento de teste enfileirado.'),
    onError: (err) => toast.error(err.message),
  });

  if (list.isPending) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
            key={i}
            className="h-24 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
          />
        ))}
      </div>
    );
  }

  const endpoints = (list.data ?? []) as EndpointRow[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          {endpoints.length}{' '}
          {endpoints.length === 1 ? 'endpoint cadastrado' : 'endpoints cadastrados'}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          + Novo endpoint
        </Button>
      </div>

      {endpoints.length === 0 && !showForm ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-16 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[var(--color-brand-50)] to-[var(--color-surface-muted)] ring-1 ring-[var(--color-brand-500)]/20">
            <span className="text-[20px]">↗</span>
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-[16px] text-[var(--color-fg)]">
              Nenhum endpoint cadastrado.
            </p>
            <p className="max-w-md text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">
              Crie seu primeiro webhook pra receber notificações em tempo real de pedidos,
              assinaturas e afiliados.
            </p>
          </div>
          <Button onClick={() => setShowForm(true)}>Criar primeiro endpoint</Button>
        </div>
      ) : null}

      <AnimatePresence>
        {showForm || editing ? (
          <EndpointForm
            initial={editing}
            pending={create.isPending || update.isPending}
            onCancel={() => {
              setShowForm(false);
              setEditing(null);
            }}
            onSubmit={(input) => {
              if (editing) update.mutate({ id: editing.id, ...input });
              else create.mutate(input);
            }}
          />
        ) : null}
      </AnimatePresence>

      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {endpoints.map((ep) => (
            <motion.li
              key={ep.id}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.24, ease: EASE }}
              className={
                ep.isActive
                  ? 'flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition hover:border-[var(--color-border-strong)]'
                  : 'flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-5 transition'
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <TruncatedUrl url={ep.url} />
                    <EndpointStatusPill active={ep.isActive} />
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wider">
                      {ep.eventTypes.includes('*') ? 'todos' : `${ep.eventTypes.length} eventos`}
                    </span>
                  </div>
                  {ep.description ? (
                    <p className="text-[12px] text-[var(--color-fg-muted)]">{ep.description}</p>
                  ) : null}
                  <SecretReveal prefix={ep.secretPrefix} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setEditing(ep);
                  }}
                >
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update.mutate({ id: ep.id, isActive: !ep.isActive })}
                  disabled={update.isPending}
                >
                  {ep.isActive ? 'Pausar' : 'Ativar'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => test.mutate({ endpointId: ep.id, eventType: 'order.paid' })}
                  disabled={test.isPending}
                >
                  Disparar teste
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRotate(ep)}
                  disabled={regenerate.isPending}
                >
                  Regenerar secret
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRemove(ep)}
                  disabled={remove.isPending}
                >
                  Remover
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      <AnimatePresence>
        {secretReveal ? (
          <SecretRevealModal
            secret={secretReveal.secret}
            url={secretReveal.url}
            onClose={() => setSecretReveal(null)}
          />
        ) : null}
        {pendingRotate ? (
          <ConfirmDialog
            title="Regenerar secret?"
            description="O secret atual deixa de validar a partir de agora. Atualize seu receptor antes de prosseguir."
            confirmLabel="Regenerar"
            danger
            pending={regenerate.isPending}
            onCancel={() => setPendingRotate(null)}
            onConfirm={() => regenerate.mutate({ id: pendingRotate.id })}
          />
        ) : null}
        {pendingRemove ? (
          <ConfirmTypedDialog
            title="Remover endpoint"
            description={`Os disparos pra ${pendingRemove.url} param imediatamente. Digite REMOVER pra confirmar.`}
            expected="REMOVER"
            confirmLabel="Remover"
            pending={remove.isPending}
            onCancel={() => setPendingRemove(null)}
            onConfirm={() => remove.mutate({ id: pendingRemove.id })}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function EndpointForm({
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: EndpointRow | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    url: string;
    description?: string;
    eventTypes: (WebhookEventType | '*')[];
  }) => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const initialAll = (initial?.eventTypes ?? []).includes('*');
  const [allEvents, setAllEvents] = useState(initial ? initialAll : false);
  const [events, setEvents] = useState<Set<string>>(
    new Set(initial && !initialAll ? initial.eventTypes : []),
  );
  const [urlError, setUrlError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, WebhookEventType[]>();
    for (const g of EVENT_GROUPS) map.set(g.prefix, []);
    for (const evt of WEBHOOK_EVENT_TYPES) {
      for (const g of EVENT_GROUPS) {
        if (evt.startsWith(g.prefix)) {
          map.get(g.prefix)?.push(evt);
          break;
        }
      }
    }
    return map;
  }, []);

  function validateUrl(v: string): string | null {
    if (!v.trim()) return 'URL obrigatória.';
    try {
      const u = new URL(v.trim());
      if (u.protocol !== 'https:') return 'Use HTTPS — webhooks em produção exigem TLS.';
      return null;
    } catch {
      return 'URL inválida.';
    }
  }

  function toggleEvent(evt: string) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(evt)) next.delete(evt);
      else next.add(evt);
      return next;
    });
  }

  function toggleGroup(prefix: string) {
    const inGroup = grouped.get(prefix) ?? [];
    const allSelected = inGroup.every((e) => events.has(e));
    setEvents((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const e of inGroup) next.delete(e);
      else for (const e of inGroup) next.add(e);
      return next;
    });
  }

  function submit() {
    const err = validateUrl(url);
    setUrlError(err);
    if (err) return;
    if (!allEvents && events.size === 0) {
      toast.error('Selecione pelo menos um evento.');
      return;
    }
    onSubmit({
      url: url.trim(),
      description: description.trim() || undefined,
      eventTypes: allEvents ? (['*'] as const) : (Array.from(events) as WebhookEventType[]),
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: EASE }}
      className="overflow-hidden"
    >
      <div className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-sm)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">
              {initial ? 'Editar endpoint' : 'Novo endpoint'}
            </h3>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              POST com header `Univercart-Signature` HMAC-SHA256 do payload.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="endpoint-url"
            className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]"
          >
            URL · HTTPS obrigatório
          </label>
          <input
            id="endpoint-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (urlError) setUrlError(validateUrl(e.target.value));
            }}
            placeholder="https://seu-app.com/webhooks/univercart"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 font-mono text-[13px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          />
          {urlError ? <p className="text-[11px] text-[var(--color-danger)]">{urlError}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="endpoint-description"
            className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]"
          >
            Descrição · opcional ({description.length}/200)
          </label>
          <textarea
            id="endpoint-description"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 200))}
            maxLength={200}
            rows={2}
            placeholder="Pra que serve esse endpoint — facilita auditoria depois."
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Eventos
            </span>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={allEvents}
                onChange={(e) => setAllEvents(e.target.checked)}
                className="size-4 accent-[var(--color-brand-600)]"
              />
              Todos os eventos (envia `*`)
            </label>
          </div>

          <div
            className={
              allEvents
                ? 'pointer-events-none flex flex-col gap-4 opacity-40'
                : 'flex flex-col gap-4'
            }
          >
            {EVENT_GROUPS.map((g) => {
              const inGroup = grouped.get(g.prefix) ?? [];
              if (inGroup.length === 0) return null;
              const allSelected = inGroup.every((e) => events.has(e));
              return (
                <div key={g.prefix} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[11px] text-[var(--color-fg)] uppercase tracking-[0.12em]">
                      {g.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.prefix)}
                      className="text-[11px] text-[var(--color-brand-600)] hover:underline"
                    >
                      {allSelected ? 'Limpar grupo' : 'Selecionar grupo'}
                    </button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {inGroup.map((evt) => {
                      const checked = events.has(evt);
                      return (
                        <label
                          key={evt}
                          className={
                            checked
                              ? 'flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-brand-500)]/40 bg-[var(--color-brand-50)]/30 px-3 py-2 transition'
                              : 'flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 transition hover:border-[var(--color-border-strong)]'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleEvent(evt)}
                            className="size-4 accent-[var(--color-brand-600)]"
                          />
                          <span className="font-mono text-[11px] text-[var(--color-fg)]">
                            {evt}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-[var(--color-border)] border-t pt-4">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? 'Salvando…' : initial ? 'Atualizar' : 'Salvar endpoint'}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function TruncatedUrl({ url }: { url: string }) {
  const display = useMemo(() => {
    if (url.length <= 56) return url;
    return `${url.slice(0, 28)}…${url.slice(-22)}`;
  }, [url]);
  return (
    <span className="truncate font-mono text-[13px] text-[var(--color-fg)]" title={url}>
      {display}
    </span>
  );
}

function EndpointStatusPill({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-success)] uppercase tracking-wider">
      ✓ Ativo
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-warning)] uppercase tracking-wider">
      ⏸ Pausado
    </span>
  );
}

function SecretReveal({ prefix }: { prefix: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
        {open ? `${prefix}••••••••` : `${prefix.slice(0, 12)}••••••••`}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        aria-label={open ? 'Ocultar preview' : 'Mostrar preview'}
      >
        {open ? '🙈' : '👁'}
      </button>
    </div>
  );
}

function SecretRevealModal({
  secret,
  url,
  onClose,
}: {
  secret: string;
  url: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success('Secret copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione manualmente.');
    }
  }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={onClose}
      // biome-ignore lint/a11y/useSemanticElements: framer-motion overlay.
      role="dialog"
      aria-modal="true"
      aria-labelledby="secret-reveal-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.97 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full max-w-xl flex-col gap-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)]"
      >
        <div className="flex flex-col gap-1">
          <h3 id="secret-reveal-title" className="font-semibold text-[18px] text-[var(--color-fg)]">
            Anote agora — não exibimos mais.
          </h3>
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            Esse secret valida cada POST que enviamos pra{' '}
            <span className="font-mono text-[12px] text-[var(--color-fg)]">{url}</span>. Depois que
            essa janela fechar, só conseguimos rotacionar — nunca recuperar.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)] p-4">
          <span className="font-semibold text-[10px] text-[var(--color-warning)] uppercase tracking-[0.14em]">
            Secret · copie e guarde num cofre
          </span>
          <code className="block break-all rounded-lg bg-[var(--color-surface)] px-3 py-2 font-mono text-[13px] text-[var(--color-fg)]">
            {secret}
          </code>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={copy}>
            {copied ? '✓ Copiado' : 'Copiar secret'}
          </Button>
          <Button onClick={onClose}>Já anotei</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={onCancel}
      // biome-ignore lint/a11y/useSemanticElements: overlay.
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.97 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)]"
      >
        <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">{title}</h3>
        <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">{description}</p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={pending}>
            {pending ? '…' : confirmLabel}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ConfirmTypedDialog({
  title,
  description,
  expected,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  expected: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const valid = typed === expected;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={onCancel}
      // biome-ignore lint/a11y/useSemanticElements: overlay.
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.97 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-[var(--color-danger)]/30 bg-[var(--color-surface)] p-6 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)]"
      >
        <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">{title}</h3>
        <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">{description}</p>
        <input
          // biome-ignore lint/a11y/noAutofocus: destructive confirm — keyboard immediate.
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expected}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-danger)] focus:ring-4 focus:ring-[var(--color-danger)]/15"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!valid || pending}>
            {pending ? '…' : confirmLabel}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* TAB 3 — DELIVERIES                                                         */
/* -------------------------------------------------------------------------- */

type DeliveryStatus = 'all' | 'delivered' | 'pending' | 'failed' | 'dead_letter';

const DELIVERY_FILTERS: { value: DeliveryStatus; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'delivered', label: 'Enviados' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'failed', label: 'Falharam' },
  { value: 'dead_letter', label: 'Dead letter' },
];

function DeliveriesTab() {
  const endpointsQ = trpc.webhooks.endpointsList.useQuery();
  const [endpointId, setEndpointId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<DeliveryStatus>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const list = trpc.webhooks.deliveriesList.useQuery({
    endpointId,
    status: status === 'all' ? undefined : status,
    limit: 100,
  });

  const retry = trpc.webhooks.deliveryRetry.useMutation({
    onSuccess: () => {
      utils.webhooks.deliveriesList.invalidate();
      toast.success('Delivery re-enfileirada.');
    },
    onError: (err) => toast.error(err.message),
  });

  const endpoints = endpointsQ.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={endpointId ?? ''}
          onChange={(e) => setEndpointId(e.target.value || undefined)}
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 font-medium text-[11px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)]"
        >
          <option value="">Todos endpoints</option>
          {endpoints.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.url}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-[var(--color-fg-subtle)]">·</span>
        <div className="flex flex-wrap gap-1.5">
          {DELIVERY_FILTERS.map((f) => (
            <FilterChip
              key={f.value}
              active={status === f.value}
              onClick={() => setStatus(f.value)}
              label={f.label}
            />
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => list.refetch()}>
          Atualizar
        </Button>
        <span className="ml-auto text-[11px] text-[var(--color-fg-subtle)]">
          {(list.data ?? []).length} mostrados · limite 100
        </span>
      </div>

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
          Nenhuma entrega com esses filtros.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-muted)]/60">
              <tr className="text-left">
                <Th>Status</Th>
                <Th>Endpoint</Th>
                <Th>Evento</Th>
                <Th>Tentativas</Th>
                <Th>Última tentativa</Th>
                <Th>Quando</Th>
                <Th className="text-right">Ações</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(list.data ?? []).map((d) => (
                <tr key={d.id} className="transition hover:bg-[var(--color-surface-muted)]/40">
                  <Td>
                    <DeliveryStatusPill status={d.status} httpStatus={d.lastResponseStatus} />
                  </Td>
                  <Td>
                    <TruncatedUrl url={d.endpoint} />
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                      {d.eventType}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--color-fg-muted)] tabular-nums">
                      {d.attempts}
                    </span>
                  </Td>
                  <Td>
                    <time className="text-[12px] text-[var(--color-fg-subtle)]">
                      {d.lastAttemptAt ? formatRelative(d.lastAttemptAt) : '—'}
                    </time>
                  </Td>
                  <Td>
                    <time className="text-[12px] text-[var(--color-fg-subtle)]">
                      {formatRelative(d.createdAt)}
                    </time>
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(d.id)}>
                        Ver
                      </Button>
                      {d.status !== 'delivered' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => retry.mutate({ id: d.id })}
                          disabled={retry.isPending}
                        >
                          Reenviar
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
        {openId ? <DeliveryDetailModal id={openId} onClose={() => setOpenId(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function DeliveryDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = trpc.webhooks.deliveryDetail.useQuery({ id });
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-4 backdrop-blur-md"
      onClick={onClose}
      // biome-ignore lint/a11y/useSemanticElements: framer-motion overlay.
      role="dialog"
      aria-modal="true"
      aria-labelledby="delivery-detail-title"
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
              id="delivery-detail-title"
              className="font-semibold text-[16px] text-[var(--color-fg)]"
            >
              Delivery detail
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
                <Meta label="Evento" value={detail.data.eventType} />
                <Meta label="Tentativas" value={String(detail.data.attempts)} />
                <Meta
                  label="HTTP"
                  value={
                    detail.data.lastResponseStatus ? String(detail.data.lastResponseStatus) : '—'
                  }
                />
                <Meta label="Status" value={detail.data.status} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Signature
                </span>
                <code className="break-all rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 font-mono text-[11px] text-[var(--color-fg)]">
                  {detail.data.signature}
                </code>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Payload
                </span>
                <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 font-mono text-[11px] text-[var(--color-fg)]">
                  {typeof detail.data.payload === 'string'
                    ? detail.data.payload
                    : JSON.stringify(detail.data.payload, null, 2)}
                </pre>
              </div>
              {detail.data.lastResponseBody ? (
                <div className="flex flex-col gap-1.5">
                  <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                    Resposta do receptor
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 font-mono text-[11px] text-[var(--color-fg)]">
                    {detail.data.lastResponseBody}
                  </pre>
                </div>
              ) : null}
              {detail.data.status === 'failed' || detail.data.status === 'dead_letter' ? (
                <div className="flex flex-col gap-1.5">
                  <span className="font-semibold text-[10px] text-[var(--color-danger)] uppercase tracking-[0.14em]">
                    Erro
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3 font-mono text-[11px] text-[var(--color-danger)]">
                    {detail.data.lastResponseStatus
                      ? `HTTP ${detail.data.lastResponseStatus}`
                      : 'Receptor inalcançável (sem resposta).'}
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

/* -------------------------------------------------------------------------- */
/* SHARED ATOMS                                                               */
/* -------------------------------------------------------------------------- */

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

function InboundStatusPill({ status }: { status: 'processed' | 'pending' | 'error' }) {
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

function DeliveryStatusPill({
  status,
  httpStatus,
}: {
  status: 'delivered' | 'pending' | 'processing' | 'failed' | 'dead_letter';
  httpStatus: number | null;
}) {
  const map = {
    delivered: {
      label: '✓ Enviado',
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    processing: {
      label: '… Processando',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    pending: {
      label: '… Pendente',
      cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    failed: {
      label: '↻ Falhou',
      cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    dead_letter: {
      label: '× Dead letter',
      cls: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
  } as const;
  const meta = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.cls}`}
    >
      {meta.label}
      {httpStatus ? <span className="font-mono opacity-60">· {httpStatus}</span> : null}
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
