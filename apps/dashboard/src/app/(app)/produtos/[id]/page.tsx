'use client';

import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
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
      router.push('/produtos');
    },
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [maxInstallments, setMaxInstallments] = useState(12);
  const [isActive, setIsActive] = useState(true);
  const [cover, setCover] = useState<ImageUpload | null>(null);

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
    if (!Number.isFinite(priceCents) || priceCents <= 0) return 'Informe um preço válido.';
    if (priceCents > 10_000_000) return 'Preço acima do limite (R$ 100.000,00).';
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
      priceCents,
      maxInstallments,
      isActive,
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
