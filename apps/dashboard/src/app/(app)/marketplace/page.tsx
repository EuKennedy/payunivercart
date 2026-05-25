'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { trpc } from '../../../lib/trpc';

/**
 * Producer marketplace page — Pilar 4 producer surface.
 *
 * Two halves:
 *   - "Meus produtos no marketplace" — listings already created, with
 *     status + quick publish/pause/remove + clicks/purchase counters.
 *   - "Publicar produto" — form to opt an existing product into the
 *     public catalog.
 *
 * Status badges mirror the schema enum so the producer always sees the
 * exact value the public surface filters on.
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

export default function MarketplacePage() {
  const utils = trpc.useUtils();
  const myListings = trpc.marketplace.listMine.useQuery();
  const products = trpc.products.list.useQuery();

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

  const [showForm, setShowForm] = useState(false);
  const [productId, setProductId] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('cursos');
  const [headline, setHeadline] = useState('');
  const [pitch, setPitch] = useState('');
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [keywordsInput, setKeywordsInput] = useState('');

  function resetForm() {
    setProductId('');
    setCategory('cursos');
    setHeadline('');
    setPitch('');
    setCoverImageUrl('');
    setKeywordsInput('');
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
    upsert.mutate({
      productId,
      category,
      headline: headline.trim(),
      pitch: pitch.trim(),
      coverImageUrl: coverImageUrl.trim() || null,
      searchKeywords,
    });
  };

  // Products already listed somehow — don't double-publish.
  const existingProductIds = new Set(myListings.data?.map((l) => l.productId) ?? []);
  const eligibleProducts =
    products.data?.filter((p) => !existingProductIds.has(p.id) && p.isActive) ?? [];

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
                  className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
                >
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
                    </div>
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      {listing.cachedClicks} cliques · {listing.cachedPurchases} compras
                      {listing.publishedAt
                        ? ` · publicado em ${new Date(listing.publishedAt).toLocaleDateString('pt-BR')}`
                        : ''}
                    </span>
                    {listing.moderationNote ? (
                      <span className="text-[12px] text-[var(--color-danger)]">
                        Nota: {listing.moderationNote}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
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
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <header className="mb-5 flex items-center justify-between">
              <Heading level={3}>Novo listing</Heading>
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
            <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 sm:grid-cols-2">
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
              <div className="flex items-center gap-3 pt-2 sm:col-span-2">
                <Button type="submit" disabled={upsert.isPending}>
                  {upsert.isPending ? 'Salvando…' : 'Criar listing'}
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
