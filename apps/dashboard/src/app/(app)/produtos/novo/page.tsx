'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { formatCents, parseCentsBRL } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Cadastrar produto — premium 3-step wizard with live preview.
 *
 * Three steps:
 *   1. Identidade — nome, descrição, capa
 *   2. Comercial  — tipo + preço/planos + parcelamento
 *   3. Entrega    — link + instruções + final review
 *
 * Why a wizard vs single-page:
 *   - Lower cognitive load per step. Producer is never staring at
 *     12 fields at once.
 *   - Each step validates independently so the producer can't reach
 *     review with broken data.
 *   - Slide animations + step progress create the "i'm building
 *     something" feeling Hotmart/Kiwify lack.
 *
 * Live preview on the right column always reflects the current state
 * — producer sees the checkout card render as they type.
 *
 * Persistence: form state lives in component state until "Publicar".
 * Cancel = router.back(). No localStorage draft yet (TODO when
 * abandonment data shows it matters).
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

type StepId = 'identity' | 'commerce' | 'delivery';
const STEPS: { id: StepId; label: string; kicker: string }[] = [
  { id: 'identity', label: 'Identidade', kicker: 'passo 1 de 3' },
  { id: 'commerce', label: 'Comercial', kicker: 'passo 2 de 3' },
  { id: 'delivery', label: 'Entrega & revisão', kicker: 'passo 3 de 3' },
];

const EASE = [0.16, 1, 0.3, 1] as const;

export default function NovoProdutoPage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const create = trpc.products.create.useMutation({
    onSuccess: async () => {
      await utils.products.list.invalidate();
      router.push('/produtos');
    },
  });

  const [step, setStep] = useState<StepId>('identity');
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

  /* Per-step validation — each step gates the "Próximo" button. */
  const stepErrors = useMemo(() => {
    const e: Partial<Record<StepId, string>> = {};
    if (trimmedName.length === 0) e.identity = 'Informe o nome do produto.';
    else if (trimmedName.length > 120) e.identity = 'Nome muito longo (máx 120 caracteres).';
    else if (description.trim().length > 2000)
      e.identity = 'Descrição muito longa (máx 2000 caracteres).';
    else if (!cover) e.identity = 'Selecione uma capa para o produto.';

    if (!isSubscription) {
      if (!Number.isFinite(priceCents) || priceCents <= 0) e.commerce = 'Informe um preço válido.';
      else if (priceCents > 10_000_000) e.commerce = 'Preço acima do limite (R$ 100.000,00).';
    } else {
      if (parsedPlans.length === 0) e.commerce = 'Adicione pelo menos um plano.';
      for (const p of parsedPlans) {
        if (!p.name.trim()) {
          e.commerce = 'Cada plano precisa de um nome.';
          break;
        }
        if (!Number.isFinite(p.amountCents) || p.amountCents <= 0) {
          e.commerce = `Plano "${p.name}" sem preço válido.`;
          break;
        }
        if (p.amountCents < 100) {
          e.commerce = `Plano "${p.name}" abaixo do mínimo (R$ 1,00).`;
          break;
        }
      }
    }
    return e;
  }, [trimmedName, description, cover, isSubscription, priceCents, parsedPlans]);

  const allValid = !stepErrors.identity && !stepErrors.commerce && !stepErrors.delivery;
  const apiError = create.error?.message ?? null;

  const onSubmit = () => {
    if (!allValid || !cover) return;
    create.mutate({
      name: trimmedName,
      description: description.trim() || undefined,
      type: isSubscription ? 'subscription' : 'one_time',
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
    const next = plans.some((p) => p.billingPeriod === 'yearly') ? 'monthly' : 'yearly';
    setPlans((curr) => [...curr, emptyPlan(next)]);
  };
  const updatePlan = (id: string, patch: Partial<PlanDraft>) =>
    setPlans((curr) => curr.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const removePlan = (id: string) =>
    setPlans((curr) => (curr.length <= 1 ? curr : curr.filter((p) => p.id !== id)));
  const setHighlighted = (id: string) =>
    setPlans((curr) => curr.map((p) => ({ ...p, isHighlighted: p.id === id })));

  const idx = STEPS.findIndex((s) => s.id === step);
  const canGoNext =
    (step === 'identity' && !stepErrors.identity) ||
    (step === 'commerce' && !stepErrors.commerce) ||
    step === 'delivery';

  const goNext = () => {
    const next = STEPS[idx + 1];
    if (next && canGoNext) setStep(next.id);
  };
  const goPrev = () => {
    const prev = STEPS[idx - 1];
    if (prev) setStep(prev.id);
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Kicker>catálogo · novo produto</Kicker>
        <Heading level={1}>Cadastre um produto.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Três passos: identidade, comercial e entrega. O link público é gerado no final, pronto pra
          colar no seu funil.
        </p>
      </header>

      <Stepper current={step} onJump={setStep} errors={stepErrors} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left column — current step content */}
        <section className="min-w-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.28, ease: EASE }}
              className="flex flex-col gap-7"
            >
              {step === 'identity' ? (
                <IdentityStep
                  name={name}
                  setName={setName}
                  description={description}
                  setDescription={setDescription}
                  onCoverChange={setCover}
                />
              ) : null}
              {step === 'commerce' ? (
                <CommerceStep
                  isSubscription={isSubscription}
                  setIsSubscription={setIsSubscription}
                  priceInput={priceInput}
                  setPriceInput={setPriceInput}
                  previewFormatted={previewFormatted}
                  maxInstallments={maxInstallments}
                  setMaxInstallments={setMaxInstallments}
                  plans={plans}
                  onAdd={addPlan}
                  onUpdate={updatePlan}
                  onRemove={removePlan}
                  onHighlight={setHighlighted}
                />
              ) : null}
              {step === 'delivery' ? (
                <DeliveryStep
                  deliveryUrl={deliveryUrl}
                  deliveryInstructions={deliveryInstructions}
                  onUrlChange={setDeliveryUrl}
                  onInstructionsChange={setDeliveryInstructions}
                />
              ) : null}
            </motion.div>
          </AnimatePresence>

          {/* Errors */}
          <div className="mt-6 min-h-[20px]">
            {stepErrors[step] ? (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="text-[13px] text-[var(--color-danger)]"
              >
                {stepErrors[step]}
              </motion.p>
            ) : null}
            {apiError ? <p className="text-[13px] text-[var(--color-danger)]">{apiError}</p> : null}
          </div>

          {/* Nav bar */}
          <div className="mt-6 flex items-center justify-between gap-3 border-[var(--color-border)] border-t pt-6">
            <Button type="button" variant="ghost" onClick={() => router.push('/produtos')}>
              Cancelar
            </Button>
            <div className="flex items-center gap-2">
              {idx > 0 ? (
                <Button type="button" variant="secondary" onClick={goPrev}>
                  ← Voltar
                </Button>
              ) : null}
              {step !== 'delivery' ? (
                <PrimaryCta onClick={goNext} disabled={!canGoNext}>
                  Próximo →
                </PrimaryCta>
              ) : (
                <PrimaryCta onClick={onSubmit} disabled={!allValid || create.isPending}>
                  {create.isPending ? 'Publicando…' : 'Publicar produto'}
                </PrimaryCta>
              )}
            </div>
          </div>
        </section>

        {/* Right column — live preview (sticky on desktop) */}
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <LivePreview
              name={trimmedName}
              description={description.trim()}
              cover={cover}
              isSubscription={isSubscription}
              priceFormatted={previewFormatted}
              plans={parsedPlans}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stepper                                                                    */
/* -------------------------------------------------------------------------- */

function Stepper({
  current,
  onJump,
  errors,
}: {
  current: StepId;
  onJump: (id: StepId) => void;
  errors: Partial<Record<StepId, string>>;
}) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex w-full items-center gap-3">
      {STEPS.map((s, i) => {
        const active = current === s.id;
        const passed = i < idx;
        const hasError = !!errors[s.id];
        return (
          <li key={s.id} className="flex flex-1 items-center gap-3">
            <button
              type="button"
              onClick={() => onJump(s.id)}
              className={
                active
                  ? 'flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-[var(--color-brand-500)] bg-[var(--color-brand-50)]/40 px-4 py-3 text-left'
                  : 'flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition hover:border-[var(--color-border-strong)]'
              }
            >
              <span
                className={
                  passed
                    ? 'grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white shadow-sm'
                    : active
                      ? 'grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-brand-500)] font-semibold text-[12px] text-white shadow-sm'
                      : 'grid size-8 shrink-0 place-items-center rounded-full border border-[var(--color-border)] font-semibold text-[12px] text-[var(--color-fg-subtle)]'
                }
                aria-hidden
              >
                {passed ? (
                  <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
                    <title>OK</title>
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
                  {s.kicker}
                </span>
                <span className="font-semibold text-[14px] text-[var(--color-fg)]">{s.label}</span>
              </div>
              {hasError && !active ? (
                <span
                  aria-label="Pendente"
                  className="ml-auto grid size-5 place-items-center rounded-full bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                >
                  !
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1 — Identity                                                          */
/* -------------------------------------------------------------------------- */

function IdentityStep({
  name,
  setName,
  description,
  setDescription,
  onCoverChange,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  onCoverChange: (c: ImageUpload | null) => void;
}) {
  return (
    <>
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
        onChange={onCoverChange}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2 — Commerce                                                          */
/* -------------------------------------------------------------------------- */

function CommerceStep({
  isSubscription,
  setIsSubscription,
  priceInput,
  setPriceInput,
  previewFormatted,
  maxInstallments,
  setMaxInstallments,
  plans,
  onAdd,
  onUpdate,
  onRemove,
  onHighlight,
}: {
  isSubscription: boolean;
  setIsSubscription: (v: boolean) => void;
  priceInput: string;
  setPriceInput: (v: string) => void;
  previewFormatted: string | null;
  maxInstallments: number;
  setMaxInstallments: (n: number) => void;
  plans: PlanDraft[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<PlanDraft>) => void;
  onRemove: (id: string) => void;
  onHighlight: (id: string) => void;
}) {
  return (
    <>
      <ProductTypeSegment value={isSubscription} onChange={setIsSubscription} />
      <AnimatePresence mode="wait">
        {!isSubscription ? (
          <motion.div
            key="one_time"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="grid grid-cols-1 gap-7 md:grid-cols-2"
          >
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
          </motion.div>
        ) : (
          <motion.div
            key="subscription"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            <PlansEditor
              plans={plans}
              onAdd={onAdd}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onHighlight={onHighlight}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3 — Delivery + final review                                           */
/* -------------------------------------------------------------------------- */

function DeliveryStep({
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

/* -------------------------------------------------------------------------- */
/* Live preview card                                                          */
/* -------------------------------------------------------------------------- */

function LivePreview({
  name,
  description,
  cover,
  isSubscription,
  priceFormatted,
  plans,
}: {
  name: string;
  description: string;
  cover: ImageUpload | null;
  isSubscription: boolean;
  priceFormatted: string | null;
  plans: (PlanDraft & { amountCents: number })[];
}) {
  const highlightedPlan = plans.find((p) => p.isHighlighted) ?? plans[0];
  const displayPrice =
    isSubscription && highlightedPlan && Number.isFinite(highlightedPlan.amountCents)
      ? formatCents(highlightedPlan.amountCents, 'BRL')
      : priceFormatted;

  return (
    <motion.div
      className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_56px_-16px_rgba(0,0,0,0.25)]"
      initial={false}
      animate={{ y: 0 }}
    >
      <div className="border-[var(--color-border)] border-b bg-gradient-to-br from-[var(--color-brand-50)] via-[var(--color-surface)] to-transparent px-4 py-3">
        <p className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.14em]">
          Pré-visualização ao vivo
        </p>
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          É assim que o comprador vai ver no checkout.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {cover ? (
          <img
            src={`data:${cover.mime};base64,${cover.base64}`}
            alt={name || 'Produto'}
            className="aspect-square w-full rounded-xl object-cover"
          />
        ) : (
          <div className="grid aspect-square w-full place-items-center rounded-xl bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]">
            <svg viewBox="0 0 24 24" fill="none" className="size-8" aria-hidden>
              <title>Sem capa</title>
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" />
              <circle cx="9" cy="11" r="1.5" fill="currentColor" />
              <path d="M3 17l5-5 6 6 4-4 3 3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="font-semibold text-[15px] text-[var(--color-fg)] leading-tight">
            {name || 'Nome do seu produto'}
          </h3>
          {description ? (
            <p className="line-clamp-3 text-[12px] text-[var(--color-fg-muted)] leading-[1.5]">
              {description}
            </p>
          ) : (
            <p className="text-[12px] text-[var(--color-fg-subtle)] italic">
              Descrição aparecerá aqui.
            </p>
          )}
        </div>

        <div className="flex items-baseline gap-2">
          {displayPrice ? (
            <>
              <span className="font-bold text-[24px] text-[var(--color-fg)] tracking-tight">
                {displayPrice}
              </span>
              {isSubscription ? (
                <span className="text-[12px] text-[var(--color-fg-subtle)]">
                  /{highlightedPlan?.billingPeriod === 'yearly' ? 'ano' : 'mês'}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-[14px] text-[var(--color-fg-subtle)] italic">R$ —</span>
          )}
        </div>

        {isSubscription && plans.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {plans.map((p) => (
              <span
                key={p.id}
                className={
                  p.isHighlighted
                    ? 'rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-2 py-0.5 font-medium text-[10px] text-white uppercase tracking-wider'
                    : 'rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wider'
                }
              >
                {p.name}
              </span>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          disabled
          className="mt-1 cursor-not-allowed rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-4 py-2.5 font-semibold text-[13px] text-white opacity-90 shadow-sm"
        >
          Pagar agora
        </button>
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Type segment                                                               */
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
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={
        selected
          ? 'group flex cursor-pointer flex-col items-start gap-2 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
          : 'group flex cursor-pointer flex-col items-start gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]'
      }
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</span>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">{subtitle}</span>
        </div>
        <AnimatePresence>
          {selected ? (
            <motion.span
              key="check"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 22 }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white shadow-sm"
            >
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
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">{description}</p>
    </motion.button>
  );
}

/* -------------------------------------------------------------------------- */
/* Plans editor                                                               */
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
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-3 py-2 font-semibold text-[13px] text-white shadow-sm transition hover:brightness-110"
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
        <AnimatePresence initial={false}>
          {plans.map((p) => (
            <motion.li
              key={p.id}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
              transition={{ duration: 0.24, ease: EASE }}
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
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-[12px] transition ${
                    p.isHighlighted
                      ? 'bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white shadow-sm hover:brightness-110'
                      : 'border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]'
                  }`}
                >
                  {p.isHighlighted ? '★ Destaque' : '☆ Destacar'}
                </button>
                {plans.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => onRemove(p.id)}
                    className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-danger)] transition hover:border-[var(--color-danger)]"
                  >
                    Remover
                  </button>
                ) : null}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Primary CTA — gradient + spring                                            */
/* -------------------------------------------------------------------------- */

function PrimaryCta({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.16, ease: EASE }}
      className={
        disabled
          ? 'inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-[var(--color-surface-muted)] px-4 py-2.5 font-semibold text-[14px] text-[var(--color-fg-subtle)]'
          : 'inline-flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-4 py-2.5 font-semibold text-[14px] text-white shadow-[0_10px_24px_-8px_rgba(22,163,74,0.45)] transition hover:brightness-110'
      }
    >
      {children}
    </motion.button>
  );
}

/* -------------------------------------------------------------------------- */
/* Field primitive                                                            */
/* -------------------------------------------------------------------------- */

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
