'use client';

import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { API_URL, CHECKOUT_URL } from '../../../../lib/env';
import { formatCents, parseCentsBRL } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Editar produto — `/produtos/[id]`.
 *
 * Same flat layout as `/produtos/novo`. We pre-load the product via
 * `products.byId` and seed the form state once on first render so
 * controlled inputs work the same way users expect on a fresh form.
 *
 * Cover image: the field's `initialPreviewUrl` points at the public
 * api endpoint so the producer sees the current cover before deciding
 * whether to replace it. Picking a new file replaces the bytes on
 * submit; leaving it untouched leaves the column alone (the API patch
 * omits `cover` when `undefined`).
 */
export default function EditarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const product = trpc.products.byId.useQuery({ id });
  const update = trpc.products.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.products.list.invalidate(), utils.products.byId.invalidate({ id })]);
      toast.success('Produto salvo');
      router.push('/produtos');
    },
    onError: (err) => toast.error(err.message),
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [maxInstallments, setMaxInstallments] = useState(12);
  const [isActive, setIsActive] = useState(true);
  const [cover, setCover] = useState<ImageUpload | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [isSubscription, setIsSubscription] = useState(false);

  // Hydrate state once the query resolves. We only seed on the leading
  // edge so subsequent refetches from `invalidate()` don't clobber
  // in-flight edits.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !product.data) return;
    setName(product.data.name);
    setDescription(product.data.description ?? '');
    setPriceInput((product.data.priceCents / 100).toFixed(2).replace('.', ','));
    setMaxInstallments(product.data.maxInstallments);
    setIsActive(product.data.isActive);
    setDeliveryUrl(product.data.deliveryUrl ?? '');
    setDeliveryInstructions(product.data.deliveryInstructions ?? '');
    setIsSubscription(product.data.isSubscription);
    setSeeded(true);
  }, [product.data, seeded]);

  const priceCents = useMemo(() => parseCentsBRL(priceInput), [priceInput]);
  const previewFormatted =
    Number.isFinite(priceCents) && priceCents > 0 ? formatCents(priceCents, 'BRL') : null;

  if (product.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (product.error || !product.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[15px] text-[var(--color-danger)]">Produto não encontrado.</p>
        <Button variant="ghost" onClick={() => router.push('/produtos')}>
          Voltar
        </Button>
      </div>
    );
  }

  const trimmedName = name.trim();
  const validationError = (() => {
    if (trimmedName.length === 0) return 'Informe o nome do produto.';
    if (trimmedName.length > 120) return 'Nome muito longo (máx 120 caracteres).';
    if (description.trim().length > 2000) return 'Descrição muito longa (máx 2000 caracteres).';
    // One-time products precisam de preço base. Subscriptions usam plans.
    if (!isSubscription) {
      if (!Number.isFinite(priceCents) || priceCents <= 0) return 'Informe um preço válido.';
      if (priceCents > 10_000_000) return 'Preço acima do limite (R$ 100.000,00).';
    }
    return null;
  })();
  const apiError = update.error?.message ?? null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError) return;
    update.mutate({
      id,
      name: trimmedName,
      description: description.trim() || null,
      // Don't push priceCents on subscription products — plans own
      // pricing; mutating the offer here would shadow them.
      ...(isSubscription ? {} : { priceCents }),
      maxInstallments,
      isActive,
      isSubscription,
      deliveryUrl: deliveryUrl.trim() || null,
      deliveryInstructions: deliveryInstructions.trim() || null,
      ...(cover ? { cover } : {}),
    });
  };

  const publicUrl = `${CHECKOUT_URL}/c/${product.data.slug}`;
  // Cache-bust the cover preview so a fresh upload doesn't get masked
  // by the 5-min Cache-Control on the api endpoint.
  const coverPreviewUrl = product.data.hasCover
    ? `${API_URL}/img/product/${product.data.id}/cover?v=${new Date(product.data.updatedAt).getTime()}`
    : null;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>catálogo · editar produto</Kicker>
        <Heading level={1}>Editar produto.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Link público:{' '}
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[13px] underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-brand-600)]"
          >
            {publicUrl.replace(/^https?:\/\//, '')}
          </a>
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-7">
        <Field label="Nome do produto">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldInputClass}
            maxLength={120}
          />
        </Field>

        <Field label="Descrição" hint="Opcional.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className={`${fieldInputClass} resize-none`}
            maxLength={2000}
          />
        </Field>

        <ImageUploadField
          label="Capa do produto"
          hint="1:1, PNG/JPEG/WEBP, até 2 MB. Deixe como está para manter a capa atual."
          initialPreviewUrl={coverPreviewUrl}
          enforceSquare
          onChange={setCover}
        />

        <ProductTypeSegment value={isSubscription} onChange={setIsSubscription} />

        {!isSubscription ? (
          <div className="grid grid-cols-1 gap-7 md:grid-cols-2">
            <Field
              label="Preço"
              hint={
                previewFormatted
                  ? `Cliente paga ${previewFormatted}.`
                  : 'Use vírgula como separador decimal.'
              }
            >
              <div className="relative">
                <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 font-medium text-[14px] text-[var(--color-fg-subtle)]">
                  R$
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  className={`${fieldInputClass} pl-10`}
                />
              </div>
            </Field>

            <Field label="Parcelamento máximo">
              <select
                value={maxInstallments}
                onChange={(e) => setMaxInstallments(Number.parseInt(e.target.value, 10))}
                className={`${fieldInputClass} appearance-none`}
              >
                {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}×{n === 1 ? ' (à vista)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <SubscriptionPlansSection productId={id} productSlug={product.data.slug} />
        )}

        <label className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="size-4"
          />
          <span className="flex flex-col">
            <span className="font-medium text-[14px] text-[var(--color-fg)]">Produto ativo</span>
            <span className="text-[12px] text-[var(--color-fg-subtle)]">
              Quando desativado, o checkout público mostra "produto indisponível".
            </span>
          </span>
        </label>

        <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
          <header className="flex flex-col gap-1">
            <span className="font-medium text-[13px] text-[var(--color-fg)]">
              Entrega pós-compra
            </span>
            <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
              Quando o pagamento for confirmado, mandamos esses dados pro comprador por email e
              WhatsApp. Use o link da área de membros, do grupo, do Drive — o que servir como
              entrega.
            </span>
          </header>
          <Field label="Link de entrega" hint="Opcional. Pode ser área de membros, Drive, Discord…">
            <input
              type="url"
              value={deliveryUrl}
              onChange={(e) => setDeliveryUrl(e.target.value)}
              className={fieldInputClass}
              placeholder="https://"
              maxLength={500}
              inputMode="url"
            />
          </Field>
          <Field
            label="Instruções"
            hint="Opcional. Texto curto que aparece junto ao link no email + WhatsApp."
          >
            <textarea
              value={deliveryInstructions}
              onChange={(e) => setDeliveryInstructions(e.target.value)}
              rows={3}
              className={`${fieldInputClass} resize-none`}
              placeholder="Ex.: acesse com o mesmo email que você usou na compra…"
              maxLength={1000}
            />
          </Field>
        </section>

        {validationError ? (
          <p className="text-[13px] text-[var(--color-danger)]">{validationError}</p>
        ) : null}
        {apiError ? <p className="text-[13px] text-[var(--color-danger)]">{apiError}</p> : null}

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!!validationError || update.isPending}>
            {update.isPending ? 'Salvando…' : 'Salvar alterações'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push('/produtos')}>
            Cancelar
          </Button>
        </div>
      </form>
    </div>
  );
}

const fieldInputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; biome can't trace into children, but HTML label semantics still focus the first descendant control on click.
    <label className="flex flex-col gap-2">
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}

/**
 * Type segment — toggles between "compra única" and "assinatura
 * recorrente". Renders as a two-card pick so the producer sees the
 * trade-offs side-by-side instead of a binary switch hidden in a row.
 */
function ProductTypeSegment({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <p className="mb-3 font-medium text-[13px] text-[var(--color-fg-muted)]">Tipo de produto</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TypeCard
          selected={!value}
          onClick={() => onChange(false)}
          title="Compra única"
          subtitle="Cobrança avulsa"
          description="Pix, cartão ou boleto. Buyer paga uma vez e recebe o acesso."
        />
        <TypeCard
          selected={value}
          onClick={() => onChange(true)}
          title="Assinatura"
          subtitle="Cobrança recorrente"
          description="Cartão de crédito mensal ou anual. Mercado Pago renova automaticamente."
        />
      </div>
    </div>
  );
}

function TypeCard({
  selected,
  onClick,
  title,
  subtitle,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        selected
          ? 'group flex flex-col items-start gap-2 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
          : 'group flex flex-col items-start gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]'
      }
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</span>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">{subtitle}</span>
        </div>
        {selected ? (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-brand-500)] text-white">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              aria-hidden="true"
              className="size-3.5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
            </svg>
          </span>
        ) : null}
      </div>
      <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">{description}</p>
    </button>
  );
}

/**
 * Plans CRUD inline. Lists plans for this product + inline form to
 * add a new one. Edit happens via a small popover, delete via the
 * deleteRow action with the FK restriction handled server-side.
 */
function SubscriptionPlansSection({
  productId,
  productSlug,
}: {
  productId: string;
  productSlug: string;
}) {
  const utils = trpc.useUtils();
  const [copiedPlanId, setCopiedPlanId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const copyPlanLink = async (planId: string) => {
    const url = `${CHECKOUT_URL}/c/${productSlug}?plan=${planId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPlanId(planId);
      window.setTimeout(() => setCopiedPlanId((prev) => (prev === planId ? null : prev)), 1800);
    } catch {
      window.prompt('Copie o link manualmente:', url);
    }
  };
  const plans = trpc.subscriptions.listPlans.useQuery({ productId }, { staleTime: 15_000 });
  const create = trpc.subscriptions.createPlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
  });
  const update = trpc.subscriptions.updatePlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
  });
  const remove = trpc.subscriptions.deletePlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('monthly');
  const [price, setPrice] = useState('');
  const [trial, setTrial] = useState(0);
  /**
   * Univercart Connect — partner + role this plan provisions access to.
   * Both fields are nullable and travel together (validated server-side).
   * When the producer picks a partner, we fetch its role catalogue and
   * surface a second dropdown.
   */
  const [partnerAccountId, setPartnerAccountId] = useState<string | null>(null);
  const [partnerRoleSlug, setPartnerRoleSlug] = useState<string | null>(null);
  const partnersQuery = trpc.partners.list.useQuery(undefined, { staleTime: 60_000 });
  const partnerRolesQuery = trpc.partners.listRoles.useQuery(
    { partnerId: partnerAccountId ?? '' },
    { enabled: !!partnerAccountId, staleTime: 60_000 },
  );

  const submit = () => {
    const cents = parseCentsBRL(price);
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) return;
    create.mutate(
      {
        productId,
        name: name.trim(),
        billingPeriod: period,
        amountCents: cents,
        trialDays: trial,
        partnerAccountId,
        partnerRoleSlug,
      },
      {
        onSuccess: () => {
          setAdding(false);
          setName('');
          setPrice('');
          setTrial(0);
          setPeriod('monthly');
          setPartnerAccountId(null);
          setPartnerRoleSlug(null);
        },
      },
    );
  };

  return (
    <>
    {deleteTarget && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
        onClick={() => setDeleteTarget(null)}
      >
        <div
          className="mx-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">Excluir plano?</h3>
          <p className="mt-2 text-[14px] text-[var(--color-fg-muted)] leading-[1.5]">
            <span className="font-medium text-[var(--color-fg)]">"{deleteTarget.name}"</span> será
            removido permanentemente.
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                remove.mutate({ id: deleteTarget.id });
                setDeleteTarget(null);
              }}
              disabled={remove.isPending}
            >
              Excluir
            </Button>
          </div>
        </div>
      </div>
    )}
    <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-[13px] text-[var(--color-fg)]">
            Planos da assinatura
          </span>
          <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
            Crie 1 ou mais planos (ex: Mensal R$ 49,90 · Anual R$ 499). Buyer escolhe no checkout.
            Marque um como "Mais escolhido" pra destacar.
          </span>
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--color-brand-500)] px-3 py-2 font-semibold text-[13px] text-white transition hover:bg-[var(--color-brand-600)]"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
              className="size-3.5"
            >
              <path strokeLinecap="round" d="M8 3v10M3 8h10" />
            </svg>
            Novo plano
          </button>
        ) : null}
      </header>

      {plans.isPending ? (
        <p className="text-[13px] text-[var(--color-fg-subtle)]">Carregando planos…</p>
      ) : plans.data && plans.data.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {plans.data.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${
                  p.billingPeriod === 'yearly'
                    ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                    : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
                }`}
              >
                {p.billingPeriod === 'yearly' ? 'Anual' : 'Mensal'}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold text-[14px] text-[var(--color-fg)]">{p.name}</span>
                <span className="text-[12px] text-[var(--color-fg-subtle)]">
                  {p.trialDays > 0 ? `${p.trialDays} dias de trial · ` : ''}
                  {p.isActive ? 'Ativo' : 'Desativado'}
                  {p.partnerAccountId && p.partnerRoleSlug ? (
                    <>
                      {' · '}
                      <span className="font-mono text-[11px] text-[var(--color-brand-700)]">
                        Connect → {p.partnerRoleSlug}
                      </span>
                    </>
                  ) : null}
                </span>
              </div>
              <span className="font-semibold text-[16px] text-[var(--color-fg)] tabular-nums">
                {formatCents(p.amountCents, 'BRL')}
                <span className="text-[11px] text-[var(--color-fg-subtle)]">
                  /{p.billingPeriod === 'yearly' ? 'ano' : 'mês'}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyPlanLink(p.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium text-[12px] transition ${
                    copiedPlanId === p.id
                      ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                      : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                  }`}
                  title="Link de checkout pré-selecionando este plano"
                >
                  {copiedPlanId === p.id ? (
                    <>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        aria-hidden="true"
                        className="size-3"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
                      </svg>
                      Link copiado
                    </>
                  ) : (
                    <>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        aria-hidden="true"
                        className="size-3.5"
                      >
                        <rect x="4" y="4" width="9" height="9" rx="1.5" />
                        <path d="M11 4V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
                      </svg>
                      Copiar link
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => update.mutate({ id: p.id, isHighlighted: !p.isHighlighted })}
                  className={`rounded-lg px-3 py-1.5 font-medium text-[12px] transition ${
                    p.isHighlighted
                      ? 'bg-[var(--color-brand-500)] text-white hover:bg-[var(--color-brand-600)]'
                      : 'border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]'
                  }`}
                  title="Destaca esse plano no checkout"
                >
                  {p.isHighlighted ? '★ Destaque' : '☆ Destacar'}
                </button>
                <button
                  type="button"
                  onClick={() => update.mutate({ id: p.id, isActive: !p.isActive })}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)]"
                >
                  {p.isActive ? 'Desativar' : 'Ativar'}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-danger)] transition hover:border-[var(--color-danger)]"
                >
                  Excluir
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-fg-subtle)]">
          Sem planos cadastrados ainda. Adicione pelo menos um pra abrir o checkout pra compradores.
        </p>
      )}

      {adding ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-brand-500)]/40 bg-[var(--color-surface)] p-5 ring-4 ring-[var(--color-brand-500)]/10">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px_140px_100px]">
            <Field label="Nome do plano">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={fieldInputClass}
                placeholder="Ex.: Mensal Premium"
                maxLength={80}
              />
            </Field>
            <Field label="Período">
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as 'monthly' | 'yearly')}
                className={`${fieldInputClass} appearance-none`}
              >
                <option value="monthly">Mensal</option>
                <option value="yearly">Anual</option>
              </select>
            </Field>
            <Field label="Preço">
              <div className="relative">
                <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 font-medium text-[14px] text-[var(--color-fg-subtle)]">
                  R$
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className={`${fieldInputClass} pl-10`}
                  placeholder="49,90"
                />
              </div>
            </Field>
            <Field label="Trial (dias)">
              <input
                type="number"
                min={0}
                max={365}
                value={trial}
                onChange={(e) => setTrial(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                className={fieldInputClass}
              />
            </Field>
          </div>

          {/* Univercart Connect: optional SaaS partner mapping. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Univercart Connect (opcional)"
              hint="SaaS parceiro liberado quando o pagamento for confirmado."
            >
              <select
                value={partnerAccountId ?? ''}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setPartnerAccountId(next);
                  setPartnerRoleSlug(null);
                }}
                className={`${fieldInputClass} appearance-none`}
              >
                <option value="">Nenhum (entrega manual)</option>
                {(partnersQuery.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Papel no SaaS"
              hint="Slug que o SaaS espera receber (entry / medium / ultra...)."
            >
              <select
                value={partnerRoleSlug ?? ''}
                onChange={(e) => setPartnerRoleSlug(e.target.value || null)}
                disabled={!partnerAccountId}
                className={`${fieldInputClass} appearance-none disabled:opacity-50`}
              >
                <option value="">{partnerAccountId ? 'Escolher papel…' : '—'}</option>
                {(partnerRolesQuery.data ?? []).map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {r.displayName} ({r.slug})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {create.error ? (
            <p className="text-[13px] text-[var(--color-danger)]">{create.error.message}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button type="button" onClick={submit} disabled={create.isPending}>
              {create.isPending ? 'Criando…' : 'Adicionar plano'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </section>
    </>
  );
}
