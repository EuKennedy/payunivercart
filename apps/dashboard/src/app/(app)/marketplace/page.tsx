'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Producer marketplace page — Pilar 4 producer surface.
 *
 * Three halves now (was two):
 *   - "Meus listings" — listings already created, with status + quick
 *     publish/pause/remove + clicks/purchase counters.
 *   - "Solicitações de afiliação" — pending memberships across every
 *     program in the workspace; producer approves/rejects inline.
 *   - "Publicar produto" — form to opt an existing product into the
 *     public catalog, with full commission + policy + sales-page URL
 *     fields so the affiliate sees the right terms at /afiliar.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

const CATEGORIES = [
  { value: 'cursos' as const, label: 'Cursos' },
  { value: 'mentorias' as const, label: 'Mentorias' },
  { value: 'comunidades' as const, label: 'Comunidades' },
  { value: 'software' as const, label: 'Software / SaaS' },
  { value: 'ebooks' as const, label: 'E-books' },
  { value: 'consultorias' as const, label: 'Consultorias' },
  { value: 'eventos' as const, label: 'Eventos' },
  { value: 'servicos' as const, label: 'Serviços' },
  { value: 'outros' as const, label: 'Outros' },
];

const COMMISSION_TYPES = [
  { value: 'percent' as const, label: 'Pagamento único (%)' },
  { value: 'flat' as const, label: 'Valor fixo (R$)' },
  { value: 'recurring' as const, label: 'Recorrente (%)' },
  { value: 'lifetime' as const, label: 'Vitalício (%)' },
];

const APPROVAL_POLICIES = [
  { value: 'automatic' as const, label: 'Aprovação automática' },
  { value: 'manual' as const, label: 'Análise manual' },
  { value: 'invite_only' as const, label: 'Somente convidados' },
];

type CommissionType = (typeof COMMISSION_TYPES)[number]['value'];
type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]['value'];

export default function MarketplacePage() {
  const utils = trpc.useUtils();
  const myListings = trpc.marketplace.listMine.useQuery();
  const products = trpc.products.list.useQuery();
  const pendingMembers = trpc.affiliates.listMembers.useQuery({ status: 'pending' });

  const upsert = trpc.marketplace.upsert.useMutation({
    onSuccess: () => {
      utils.marketplace.listMine.invalidate();
      setShowForm(false);
      resetForm();
      toast.success('Listing salvo.');
    },
    onError: (err) => toast.error(err.message),
  });
  const publish = trpc.marketplace.publish.useMutation({
    onSuccess: () => {
      utils.marketplace.listMine.invalidate();
      toast.success('Publicado no marketplace.');
    },
  });
  const pause = trpc.marketplace.pause.useMutation({
    onSuccess: () => {
      utils.marketplace.listMine.invalidate();
      toast.success('Pausado.');
    },
  });
  const remove = trpc.marketplace.remove.useMutation({
    onSuccess: () => {
      utils.marketplace.listMine.invalidate();
      toast.success('Removido.');
    },
  });

  const approveMember = trpc.affiliates.approveMember.useMutation({
    onSuccess: () => {
      utils.affiliates.listMembers.invalidate();
      toast.success('Afiliado aprovado.');
    },
    onError: (err) => toast.error(err.message),
  });
  const rejectMember = trpc.affiliates.rejectMember.useMutation({
    onSuccess: () => {
      utils.affiliates.listMembers.invalidate();
      toast.success('Solicitação rejeitada.');
    },
    onError: (err) => toast.error(err.message),
  });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('cursos');
  const [headline, setHeadline] = useState('');
  const [pitch, setPitch] = useState('');
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [keywordsInput, setKeywordsInput] = useState('');
  const [salesPageUrl, setSalesPageUrl] = useState('');
  const [commissionType, setCommissionType] = useState<CommissionType>('percent');
  const [commissionPercent, setCommissionPercent] = useState<string>('30');
  const [commissionFlatBrl, setCommissionFlatBrl] = useState<string>('');
  const [recurringCycleLimit, setRecurringCycleLimit] = useState<string>('');
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('manual');
  const [refundWindowDays, setRefundWindowDays] = useState<string>('30');
  const [attributionWindowDays, setAttributionWindowDays] = useState<string>('60');

  const openEdit = (listingId: string) => {
    const listing = myListings.data?.find((l) => l.id === listingId);
    if (!listing) return;
    setEditingId(listing.id);
    setProductId(listing.productId);
    setCategory(listing.category as (typeof CATEGORIES)[number]['value']);
    setHeadline(listing.headline);
    setPitch(listing.pitch);
    setCoverImageUrl(listing.coverImageUrl ?? '');
    setKeywordsInput(listing.searchKeywords.join(', '));
    setSalesPageUrl(listing.salesPageUrl ?? '');
    if (listing.commission) {
      setCommissionType(listing.commission.commissionType);
      setCommissionPercent(
        listing.commission.commissionPercent != null
          ? String(listing.commission.commissionPercent)
          : '',
      );
      setCommissionFlatBrl(
        listing.commission.commissionFlatCents != null
          ? (listing.commission.commissionFlatCents / 100).toFixed(2).replace('.', ',')
          : '',
      );
      setRecurringCycleLimit(
        listing.commission.recurringCycleLimit != null
          ? String(listing.commission.recurringCycleLimit)
          : '',
      );
      setApprovalPolicy(listing.commission.approvalPolicy);
      setRefundWindowDays(String(listing.commission.refundWindowDays));
      setAttributionWindowDays(String(listing.commission.attributionWindowDays));
    } else {
      setCommissionType('percent');
      setCommissionPercent('30');
      setCommissionFlatBrl('');
      setRecurringCycleLimit('');
      setApprovalPolicy('manual');
      setRefundWindowDays('30');
      setAttributionWindowDays('60');
    }
    setShowForm(true);
    setTimeout(() => {
      document
        .getElementById('marketplace-form-anchor')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  function resetForm() {
    setEditingId(null);
    setProductId('');
    setCategory('cursos');
    setHeadline('');
    setPitch('');
    setCoverImageUrl('');
    setKeywordsInput('');
    setSalesPageUrl('');
    setCommissionType('percent');
    setCommissionPercent('30');
    setCommissionFlatBrl('');
    setRecurringCycleLimit('');
    setApprovalPolicy('manual');
    setRefundWindowDays('30');
    setAttributionWindowDays('60');
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!productId) {
      toast.error('Escolha um produto.');
      return;
    }
    const searchKeywords = keywordsInput
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 20);
    const commissionPercentNum =
      commissionType !== 'flat' ? Number.parseInt(commissionPercent, 10) : null;
    const commissionFlatCents =
      commissionType === 'flat'
        ? Math.round(Number.parseFloat(commissionFlatBrl.replace(',', '.')) * 100)
        : null;
    const recurringCycleLimitNum =
      commissionType === 'recurring' && recurringCycleLimit.trim()
        ? Number.parseInt(recurringCycleLimit, 10)
        : null;

    if (commissionType !== 'flat' && (!commissionPercentNum || commissionPercentNum < 1)) {
      toast.error('Informe um percentual de comissão entre 1 e 90.');
      return;
    }
    if (commissionType === 'flat' && (!commissionFlatCents || commissionFlatCents <= 0)) {
      toast.error('Informe o valor fixo da comissão em reais.');
      return;
    }

    upsert.mutate({
      id: editingId ?? undefined,
      productId,
      category,
      headline: headline.trim(),
      pitch: pitch.trim(),
      coverImageUrl: coverImageUrl.trim() || null,
      searchKeywords,
      salesPageUrl: salesPageUrl.trim() || null,
      commission: {
        approvalPolicy,
        commissionType,
        commissionPercent: commissionPercentNum,
        commissionFlatCents,
        recurringCycleLimit: recurringCycleLimitNum,
        refundWindowDays: Number.parseInt(refundWindowDays, 10) || 30,
        attributionWindowDays: Number.parseInt(attributionWindowDays, 10) || 60,
      },
    });
  };

  const existingProductIds = new Set(myListings.data?.map((l) => l.productId) ?? []);
  const eligibleProducts =
    products.data?.filter(
      (p) => (editingId ? p.id === productId : !existingProductIds.has(p.id)) && p.isActive,
    ) ?? [];

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>distribuição · marketplace</Kicker>
        <Heading level={1}>Publique no marketplace.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Coloque seus produtos na vitrine pública pra captar tráfego além do seu funil próprio. O
          checkout continua sendo o seu — o dinheiro vai direto pro seu MP.
        </p>
      </header>

      {/* Pending affiliate requests */}
      <PendingAffiliateRequests
        rows={pendingMembers.data ?? []}
        isLoading={pendingMembers.isPending}
        onApprove={(id) => approveMember.mutate({ membershipId: id })}
        onReject={(id) => rejectMember.mutate({ membershipId: id })}
        busy={approveMember.isPending || rejectMember.isPending}
      />

      {/* Listings */}
      {myListings.data && myListings.data.length > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Meus listings ({myListings.data.length})
            </h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowForm(true);
                resetForm();
              }}
            >
              + Novo listing
            </Button>
          </div>
          <ul className="flex flex-col gap-3">
            <AnimatePresence initial={false}>
              {myListings.data.map((listing) => (
                <motion.li
                  key={listing.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.24, ease: EASE }}
                  className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[15px] text-[var(--color-fg)]">
                          {listing.headline}
                        </span>
                        <StatusBadge status={listing.status} />
                        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wider">
                          {CATEGORIES.find((c) => c.value === listing.category)?.label ??
                            listing.category}
                        </span>
                        {listing.commission ? (
                          <span className="rounded-full bg-[var(--color-brand-50)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-wider">
                            {formatCommissionShort(listing.commission)}
                          </span>
                        ) : (
                          <span className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-warning)] uppercase tracking-wider">
                            Comissão padrão da workspace
                          </span>
                        )}
                      </div>
                      <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {listing.cachedClicks} cliques · {listing.cachedPurchases} compras
                        {listing.publishedAt
                          ? ` · publicado em ${new Date(listing.publishedAt).toLocaleDateString('pt-BR')}`
                          : ''}
                      </span>
                      {listing.salesPageUrl ? (
                        <span className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                          Página de venda: <code>{listing.salesPageUrl}</code>
                        </span>
                      ) : null}
                      {listing.moderationNote ? (
                        <span className="text-[12px] text-[var(--color-danger)]">
                          Nota: {listing.moderationNote}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(listing.id)}>
                        Editar
                      </Button>
                      {listing.status !== 'live' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => publish.mutate({ id: listing.id })}
                          disabled={publish.isPending}
                        >
                          Publicar
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => pause.mutate({ id: listing.id })}
                          disabled={pause.isPending}
                        >
                          Pausar
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!confirm(`Remover listing "${listing.headline}"?`)) return;
                          remove.mutate({ id: listing.id });
                        }}
                        disabled={remove.isPending}
                      >
                        Remover
                      </Button>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      ) : (
        <EmptyState
          title="Você ainda não tem listings."
          description="Crie um listing pra deixar seu produto visível na vitrine pública."
          action={
            <Button
              onClick={() => {
                setShowForm(true);
                resetForm();
              }}
            >
              Criar primeiro listing
            </Button>
          }
        />
      )}

      {/* Form */}
      <AnimatePresence>
        {showForm ? (
          <motion.section
            id="marketplace-form-anchor"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <header className="mb-5 flex items-center justify-between">
              <Heading level={3}>{editingId ? 'Editar listing' : 'Novo listing'}</Heading>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
              >
                Cancelar
              </Button>
            </header>
            <form onSubmit={onSubmit} className="flex flex-col gap-6">
              {/* Section 1: vitrine */}
              <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <legend className="-mt-2 col-span-full pb-2 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Vitrine
                </legend>
                <Field label="Produto" className="sm:col-span-2">
                  <select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    className={`${inputClass} appearance-none`}
                    required
                  >
                    <option value="">Selecione…</option>
                    {eligibleProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {eligibleProducts.length === 0 ? (
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      Todos os produtos ativos já estão listados.
                    </span>
                  ) : null}
                </Field>
                <Field label="Categoria">
                  <select
                    value={category}
                    onChange={(e) =>
                      setCategory(e.target.value as (typeof CATEGORIES)[number]['value'])
                    }
                    className={`${inputClass} appearance-none`}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Capa (URL)" hint="Opcional — usa a capa do produto se vazio.">
                  <input
                    type="url"
                    value={coverImageUrl}
                    onChange={(e) => setCoverImageUrl(e.target.value)}
                    className={inputClass}
                    placeholder="https://"
                  />
                </Field>
                <Field
                  label="Headline"
                  hint="Frase de vitrine. Máx 160 chars."
                  className="sm:col-span-2"
                >
                  <input
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    maxLength={160}
                    className={inputClass}
                    required
                  />
                </Field>
                <Field
                  label="Pitch"
                  hint="Texto longo de venda. Máx 4000 chars."
                  className="sm:col-span-2"
                >
                  <textarea
                    value={pitch}
                    onChange={(e) => setPitch(e.target.value)}
                    rows={6}
                    maxLength={4000}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
                <Field
                  label="Palavras-chave de busca"
                  hint="Separadas por vírgula. Máx 20 termos."
                  className="sm:col-span-2"
                >
                  <input
                    value={keywordsInput}
                    onChange={(e) => setKeywordsInput(e.target.value)}
                    className={inputClass}
                    placeholder="tráfego, vendas, copywriting"
                  />
                </Field>
              </fieldset>

              {/* Section 2: afiliação */}
              <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <legend className="-mt-2 col-span-full border-[var(--color-border)] border-t pt-5 pb-2 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  Programa de afiliação
                </legend>
                <Field
                  label="Página de venda"
                  hint="URL pra onde o link do afiliado leva o comprador. Vazio = checkout padrão /c/<slug>."
                  className="sm:col-span-2"
                >
                  <input
                    type="url"
                    value={salesPageUrl}
                    onChange={(e) => setSalesPageUrl(e.target.value)}
                    className={inputClass}
                    placeholder="https://meucurso.com/oferta-vsl"
                  />
                </Field>
                <Field label="Modelo de comissão">
                  <select
                    value={commissionType}
                    onChange={(e) => setCommissionType(e.target.value as CommissionType)}
                    className={`${inputClass} appearance-none`}
                  >
                    {COMMISSION_TYPES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {commissionType === 'flat' ? (
                  <Field label="Valor fixo (R$)" hint="Quanto o afiliado ganha por venda.">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={commissionFlatBrl}
                      onChange={(e) => setCommissionFlatBrl(e.target.value)}
                      className={inputClass}
                      placeholder="100,00"
                    />
                  </Field>
                ) : (
                  <Field label="Percentual (%)" hint="Entre 1 e 90.">
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={commissionPercent}
                      onChange={(e) => setCommissionPercent(e.target.value)}
                      className={inputClass}
                      placeholder="30"
                    />
                  </Field>
                )}
                {commissionType === 'recurring' ? (
                  <Field
                    label="Ciclos limites"
                    hint="Quantas renovações o afiliado ganha. Vazio = sem limite."
                  >
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={recurringCycleLimit}
                      onChange={(e) => setRecurringCycleLimit(e.target.value)}
                      className={inputClass}
                      placeholder="12"
                    />
                  </Field>
                ) : null}
                <Field label="Política de aprovação">
                  <select
                    value={approvalPolicy}
                    onChange={(e) => setApprovalPolicy(e.target.value as ApprovalPolicy)}
                    className={`${inputClass} appearance-none`}
                  >
                    {APPROVAL_POLICIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Janela de reembolso (dias)"
                  hint="Tempo que a comissão fica pendente antes de liberar."
                >
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={refundWindowDays}
                    onChange={(e) => setRefundWindowDays(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Janela de atribuição (dias)"
                  hint="Tempo máx entre clique e venda pra contar a comissão."
                >
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={attributionWindowDays}
                    onChange={(e) => setAttributionWindowDays(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </fieldset>

              <div className="flex items-center gap-3 pt-2">
                <Button type="submit" disabled={upsert.isPending}>
                  {upsert.isPending
                    ? 'Salvando…'
                    : editingId
                      ? 'Salvar alterações'
                      : 'Criar listing'}
                </Button>
                <p className="text-[12px] text-[var(--color-fg-subtle)]">
                  O listing entra como rascunho — você publica em um clique depois.
                </p>
              </div>
            </form>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ─── Pending affiliate requests ─────────────────────────────────────────────

interface PendingMemberRow {
  membershipId: string;
  displayName: string;
  publicCode: string;
  email: string;
  programName: string;
  appliedAt: Date | string | null;
}

function PendingAffiliateRequests({
  rows,
  isLoading,
  onApprove,
  onReject,
  busy,
}: {
  rows: PendingMemberRow[];
  isLoading: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}) {
  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Solicitações de afiliação
        </h2>
        <div className="h-16 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]" />
      </section>
    );
  }
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        Solicitações de afiliação ({rows.length})
      </h2>
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {rows.map((m) => (
            <motion.li
              key={m.membershipId}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-bg)]/30 p-4"
            >
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-[14px] text-[var(--color-fg)]">
                  {m.displayName}{' '}
                  <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                    · {m.publicCode}
                  </span>
                </span>
                <span className="text-[12px] text-[var(--color-fg-muted)]">
                  {m.email} · solicitou {m.programName}
                  {m.appliedAt ? ` em ${new Date(m.appliedAt).toLocaleDateString('pt-BR')}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!confirm(`Rejeitar afiliação de ${m.displayName}?`)) return;
                    onReject(m.membershipId);
                  }}
                  disabled={busy}
                >
                  Rejeitar
                </Button>
                <Button size="sm" onClick={() => onApprove(m.membershipId)} disabled={busy}>
                  Aprovar
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCommissionShort(c: {
  commissionType: CommissionType;
  commissionPercent: number | null;
  commissionFlatCents: number | null;
}): string {
  switch (c.commissionType) {
    case 'percent':
      return `${c.commissionPercent ?? 0}% por venda`;
    case 'flat':
      return `${formatCents(c.commissionFlatCents ?? 0, 'BRL')} por venda`;
    case 'recurring':
      return `${c.commissionPercent ?? 0}% recorrente`;
    case 'lifetime':
      return `${c.commissionPercent ?? 0}% vitalício`;
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; classes: string }> = {
    draft: {
      label: 'Rascunho',
      classes: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
    },
    pending_review: {
      label: 'Em análise',
      classes: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    live: {
      label: 'Publicado',
      classes: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    paused: {
      label: 'Pausado',
      classes: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
    },
    rejected: {
      label: 'Rejeitado',
      classes: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
  };
  const meta = map[status] ?? map.draft;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta?.classes ?? ''}`}
    >
      {meta?.label ?? status}
    </span>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via children.
    <label className={`flex flex-col gap-2 ${className ?? ''}`}>
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
