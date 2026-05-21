'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { formatCents, parseCentsBRL } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Cadastrar produto — single-screen form. Producer picks
 * compra-única OR assinatura right here; for subscriptions, plans
 * (Mensal/Anual + price) live inline and ship in the SAME mutation
 * so the producer never has to "create then edit to finish setup".
 *
 * Fields:
 *   - Nome (required, 1-120)
 *   - Descrição (optional)
 *   - Capa (required, 1:1 ≤2 MB)
 *   - Tipo: compra única OU assinatura recorrente
 *   - Preço + parcelas (compra única) OU planos array (assinatura)
 *   - Link de entrega + instruções (optional, ambos tipos)
 */

type PlanDraft = {
  id: string;
  name: string;
  billingPeriod: 'monthly' | 'yearly';
  priceInput: string;
  trialDays: number;
  isHighlighted: boolean;
};

function emptyPlan(billingPeriod: 'monthly' | 'yearly' = 'monthly'): PlanDraft {
  return {
    id: globalThis.crypto.randomUUID(),
    name: billingPeriod === 'yearly' ? 'Anual' : 'Mensal',
    billingPeriod,
    priceInput: '',
    trialDays: 0,
    isHighlighted: false,
  };
}

export default function NovoProdutoPage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const create = trpc.products.create.useMutation({
    onSuccess: async () => {
      await utils.products.list.invalidate();
      router.push('/produtos');
    },
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubscription, setIsSubscription] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [maxInstallments, setMaxInstallments] = useState(12);
  const [cover, setCover] = useState<ImageUpload | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [plans, setPlans] = useState<PlanDraft[]>([emptyPlan('monthly')]);

  const priceCents = useMemo(() => parseCentsBRL(priceInput), [priceInput]);
  const previewFormatted =
    Number.isFinite(priceCents) && priceCents > 0 ? formatCents(priceCents, 'BRL') : null;

  const parsedPlans = useMemo(
    () =>
      plans.map((p) => {
        const cents = parseCentsBRL(p.priceInput);
        return { ...p, amountCents: Number.isFinite(cents) ? cents : Number.NaN };
      }),
    [plans],
  );

  const trimmedName = name.trim();
  const validationError = (() => {
    if (trimmedName.length === 0) return 'Informe o nome do produto.';
    if (trimmedName.length > 120) return 'Nome muito longo (máx 120 caracteres).';
    if (description.trim().length > 2000) return 'Descrição muito longa (máx 2000 caracteres).';
    if (!cover) return 'Selecione uma capa para o produto.';
    if (!isSubscription) {
      if (!Number.isFinite(priceCents) || priceCents <= 0) return 'Informe um preço válido.';
      if (priceCents > 10_000_000) return 'Preço acima do limite (R$ 100.000,00).';
    } else {
      if (parsedPlans.length === 0) return 'Adicione pelo menos um plano.';
      for (const p of parsedPlans) {
        if (!p.name.trim()) return 'Cada plano precisa de um nome.';
        if (!Number.isFinite(p.amountCents) || p.amountCents <= 0)
          return `Plano "${p.name}" sem preço válido.`;
        if (p.amountCents < 100) return `Plano "${p.name}" abaixo do mínimo (R$ 1,00).`;
      }
    }
    return null;
  })();
  const apiError = create.error?.message ?? null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError || !cover) return;
    create.mutate({
      name: trimmedName,
      description: description.trim() || undefined,
      type: isSubscription ? 'subscription' : 'one_time',
      // Server ignores priceCents when isSubscription=true, but the
      // input schema still requires it as a number — pass 0 then.
      priceCents: isSubscription ? 0 : priceCents,
      currency: 'BRL',
      maxInstallments,
      cover,
      deliveryUrl: deliveryUrl.trim() || undefined,
      deliveryInstructions: deliveryInstructions.trim() || undefined,
      isSubscription,
      plans: isSubscription
        ? parsedPlans.map((p, idx) => ({
            name: p.name.trim(),
            billingPeriod: p.billingPeriod,
            amountCents: p.amountCents,
            trialDays: p.trialDays,
            isHighlighted: p.isHighlighted,
            sortOrder: idx,
          }))
        : undefined,
    });
  };

  const addPlan = () => {
    // Default the second plan to yearly so the producer ends up with
    // the typical "Mensal + Anual" combo without thinking.
    const next = plans.some((p) => p.billingPeriod === 'yearly') ? 'monthly' : 'yearly';
    setPlans((curr) => [...curr, emptyPlan(next)]);
  };
  const updatePlan = (id: string, patch: Partial<PlanDraft>) =>
    setPlans((curr) => curr.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const removePlan = (id: string) =>
    setPlans((curr) => (curr.length <= 1 ? curr : curr.filter((p) => p.id !== id)));
  const setHighlighted = (id: string) =>
    setPlans((curr) => curr.map((p) => ({ ...p, isHighlighted: p.id === id })));

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>catálogo · novo produto</Kicker>
        <Heading level={1}>Cadastre um produto.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Você define nome, preço e descrição. O link do checkout é gerado automaticamente — pronto
          pra colar no seu funil.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-7">
        <Field label="Nome do produto" hint="Aparece no checkout e no link público.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Curso de Tráfego — Edição 2026"
            className={fieldInputClass}
            maxLength={120}
          />
        </Field>

        <Field label="Descrição" hint="Opcional. Texto mostrado abaixo do nome no checkout.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Descreva o que o cliente recebe ao comprar."
            rows={4}
            className={`${fieldInputClass} resize-none`}
            maxLength={2000}
          />
        </Field>

        <ImageUploadField
          label="Capa do produto"
          hint="Obrigatória. Formato 1:1 — vai aparecer ao lado do nome no checkout. PNG, JPEG ou WEBP, até 2 MB."
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
                  placeholder="99,90"
                  className={`${fieldInputClass} pl-10`}
                />
              </div>
            </Field>

            <Field
              label="Parcelamento máximo"
              hint="No cartão de crédito; PIX e boleto são à vista por padrão."
            >
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
          <PlansEditor
            plans={plans}
            onAdd={addPlan}
            onUpdate={updatePlan}
            onRemove={removePlan}
            onHighlight={setHighlighted}
          />
        )}

        <DeliverySection
          deliveryUrl={deliveryUrl}
          deliveryInstructions={deliveryInstructions}
          onUrlChange={setDeliveryUrl}
          onInstructionsChange={setDeliveryInstructions}
        />

        {validationError ? (
          <p className="text-[13px] text-[var(--color-danger)]">{validationError}</p>
        ) : null}
        {apiError ? <p className="text-[13px] text-[var(--color-danger)]">{apiError}</p> : null}

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!!validationError || create.isPending}>
            {create.isPending ? 'Salvando…' : 'Criar produto'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push('/produtos')}>
            Cancelar
          </Button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Type segment — "Compra única" vs "Assinatura"                              */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Plans editor — inline array of subscription plans                          */
/* -------------------------------------------------------------------------- */

function PlansEditor({
  plans,
  onAdd,
  onUpdate,
  onRemove,
  onHighlight,
}: {
  plans: PlanDraft[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<PlanDraft>) => void;
  onRemove: (id: string) => void;
  onHighlight: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-[13px] text-[var(--color-fg)]">
            Planos da assinatura
          </span>
          <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
            Crie 1 ou mais planos (ex: Mensal R$ 49,90 + Anual R$ 499). Buyer escolhe no checkout.
            Estrela = "Mais escolhido" no destaque.
          </span>
        </div>
        <button
          type="button"
          onClick={onAdd}
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
      </header>

      <ul className="flex flex-col gap-4">
        {plans.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_140px_140px_100px]">
              <Field label="Nome">
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => onUpdate(p.id, { name: e.target.value })}
                  className={fieldInputClass}
                  placeholder="Ex.: Mensal Premium"
                  maxLength={80}
                />
              </Field>
              <Field label="Período">
                <select
                  value={p.billingPeriod}
                  onChange={(e) =>
                    onUpdate(p.id, {
                      billingPeriod: e.target.value as 'monthly' | 'yearly',
                    })
                  }
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
                    value={p.priceInput}
                    onChange={(e) => onUpdate(p.id, { priceInput: e.target.value })}
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
                  value={p.trialDays}
                  onChange={(e) =>
                    onUpdate(p.id, {
                      trialDays: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                    })
                  }
                  className={fieldInputClass}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => onHighlight(p.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-[12px] transition ${
                  p.isHighlighted
                    ? 'bg-[var(--color-brand-500)] text-white hover:bg-[var(--color-brand-600)]'
                    : 'border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]'
                }`}
              >
                {p.isHighlighted ? '★ Destaque' : '☆ Destacar'}
              </button>
              {plans.length > 1 ? (
                <button
                  type="button"
                  onClick={() => onRemove(p.id)}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-danger)] transition hover:border-[var(--color-danger)]"
                >
                  Remover
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Delivery section — works for both one-time + subscription                  */
/* -------------------------------------------------------------------------- */

function DeliverySection({
  deliveryUrl,
  deliveryInstructions,
  onUrlChange,
  onInstructionsChange,
}: {
  deliveryUrl: string;
  deliveryInstructions: string;
  onUrlChange: (v: string) => void;
  onInstructionsChange: (v: string) => void;
}) {
  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
      <header className="flex flex-col gap-1">
        <span className="font-medium text-[13px] text-[var(--color-fg)]">Entrega pós-compra</span>
        <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
          Quando o pagamento for confirmado, mandamos esses dados pro comprador por email e
          WhatsApp. Use o link da área de membros, do grupo, do Drive — o que servir como entrega.
        </span>
      </header>
      <Field label="Link de entrega" hint="Opcional. Pode ser área de membros, Drive, Discord…">
        <input
          type="url"
          value={deliveryUrl}
          onChange={(e) => onUrlChange(e.target.value)}
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
          onChange={(e) => onInstructionsChange(e.target.value)}
          rows={3}
          className={`${fieldInputClass} resize-none`}
          placeholder="Ex.: acesse com o mesmo email que você usou na compra…"
          maxLength={1000}
        />
      </Field>
    </section>
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
