'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { formatCents, parseCentsBRL } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Cadastrar produto — single-screen form.
 *
 * Why one screen and not a multi-step wizard?
 *   The producer is paying R$ 99,90/month for this surface to NOT
 *   waste their time. Stripe's product create form is one screen.
 *   Shopify's is one screen. The platforms that turned product-create
 *   into a 5-step wizard (Hotmart, Eduzz) are who the founder is
 *   replacing — keep the screen flat.
 *
 * Fields:
 *   - Nome (required, 1-120 chars)
 *   - Descrição (optional, 0-2000 chars)
 *   - Tipo (one_time | subscription | course | physical)
 *   - Preço em R$ (parsed to cents on submit)
 *   - Parcelas máx (1-24, default 12)
 */
const PRODUCT_TYPES = [
  { value: 'one_time', label: 'Pagamento único' },
  { value: 'subscription', label: 'Assinatura' },
  { value: 'course', label: 'Curso' },
  { value: 'physical', label: 'Produto físico' },
] as const;

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
  const [type, setType] = useState<(typeof PRODUCT_TYPES)[number]['value']>('one_time');
  const [priceInput, setPriceInput] = useState('');
  const [maxInstallments, setMaxInstallments] = useState(12);

  const priceCents = useMemo(() => parseCentsBRL(priceInput), [priceInput]);
  const previewFormatted =
    Number.isFinite(priceCents) && priceCents > 0 ? formatCents(priceCents, 'BRL') : null;

  const trimmedName = name.trim();
  const validationError = (() => {
    if (trimmedName.length === 0) return 'Informe o nome do produto.';
    if (trimmedName.length > 120) return 'Nome muito longo (máx 120 caracteres).';
    if (description.trim().length > 2000) return 'Descrição muito longa (máx 2000 caracteres).';
    if (!Number.isFinite(priceCents) || priceCents <= 0) return 'Informe um preço válido.';
    if (priceCents > 10_000_000) return 'Preço acima do limite (R$ 100.000,00).';
    return null;
  })();
  const apiError = create.error?.message ?? null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError) return;
    create.mutate({
      name: trimmedName,
      description: description.trim() || undefined,
      type,
      priceCents,
      currency: 'BRL',
      maxInstallments,
    });
  };

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

        <Field label="Tipo">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {PRODUCT_TYPES.map((option) => {
              const active = type === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setType(option.value)}
                  className={`rounded-xl border px-4 py-3 text-left font-medium text-[13px] transition ${
                    active
                      ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </Field>

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
