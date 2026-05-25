'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';

/**
 * Pilar 4 — Public marketplace page. Hits `marketplace.browse` and
 * renders a grid of producer-published listings with category +
 * search + sort filters. Click on a card → producer's own checkout
 * (we never reroute the gateway leg; this is pure distribution).
 *
 * Layout: header w/ search + filter chips, then a responsive grid
 * (1col mobile / 2col tablet / 3col desktop). Each card animates in
 * with stagger so a fresh page never flashes the entire grid at once.
 *
 * No pagination UI yet — `browse` returns 24 per page with a cursor;
 * "Carregar mais" button appears when nextCursor !== null.
 */

const CATEGORIES = [
  { value: undefined, label: 'Tudo' },
  { value: 'cursos' as const, label: 'Cursos' },
  { value: 'mentorias' as const, label: 'Mentorias' },
  { value: 'comunidades' as const, label: 'Comunidades' },
  { value: 'software' as const, label: 'Software' },
  { value: 'ebooks' as const, label: 'E-books' },
  { value: 'consultorias' as const, label: 'Consultorias' },
  { value: 'eventos' as const, label: 'Eventos' },
  { value: 'servicos' as const, label: 'Serviços' },
  { value: 'outros' as const, label: 'Outros' },
];

const SORT_OPTIONS = [
  { value: 'popular' as const, label: 'Populares' },
  { value: 'recent' as const, label: 'Recentes' },
  { value: 'price_lo' as const, label: 'Menor preço' },
  { value: 'price_hi' as const, label: 'Maior preço' },
];

const EASE = [0.16, 1, 0.3, 1] as const;

export default function MarketplacePublicPage() {
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<'popular' | 'recent' | 'price_lo' | 'price_hi'>('popular');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const list = trpc.marketplace.browse.useQuery({
    q: query || undefined,
    // biome-ignore lint/suspicious/noExplicitAny: discriminated category enum mirrors backend; cast keeps the call site terse.
    category: category as any,
    sort,
    limit: 24,
  });

  return (
    <main className="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-6 py-10 sm:py-14">
      <header className="flex flex-col gap-3">
        <p className="font-semibold text-[10px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
          Marketplace
        </p>
        <h1 className="font-semibold text-[36px] text-[var(--ink-100)] leading-[1.1] tracking-tight sm:text-[44px]">
          Descubra novos produtos.
        </h1>
        <p className="max-w-2xl text-[15px] text-[var(--ink-70)] leading-[1.55]">
          Tudo vendido por produtores verificados. Você paga via Pix, cartão ou boleto direto no
          checkout do criador.
        </p>
      </header>

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
        className="flex items-center gap-2 rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-2.5"
      >
        <SearchIcon />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar produtos..."
          className="w-full bg-transparent text-[15px] text-[var(--ink-100)] outline-none placeholder:text-[var(--ink-50)]"
        />
        {search !== query ? (
          <button
            type="submit"
            className="rounded-lg bg-[var(--dop-500)] px-3 py-1.5 font-semibold text-[12px] text-white"
          >
            Buscar
          </button>
        ) : null}
      </form>

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <motion.button
              key={c.value ?? 'all'}
              type="button"
              onClick={() => setCategory(c.value)}
              whileTap={{ scale: 0.94 }}
              className={
                category === c.value
                  ? 'rounded-full border border-[var(--ink-100)] bg-[var(--ink-100)] px-3 py-1.5 font-semibold text-[12px] text-[var(--surface-1)]'
                  : 'rounded-full border border-[var(--hairline)] bg-[var(--surface-1)] px-3 py-1.5 font-medium text-[12px] text-[var(--ink-70)] transition hover:border-[var(--ink-50)]'
              }
            >
              {c.label}
            </motion.button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSort(s.value)}
              className={
                sort === s.value
                  ? 'rounded-full bg-[var(--dop-50)] px-3 py-1 font-semibold text-[11px] text-[var(--dop-700)] uppercase tracking-wider'
                  : 'rounded-full bg-[var(--surface-2)] px-3 py-1 font-medium text-[11px] text-[var(--ink-50)] uppercase tracking-wider transition hover:text-[var(--ink-100)]'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {list.isPending ? (
        <SkeletonGrid />
      ) : !list.data || list.data.items.length === 0 ? (
        <p className="rounded-2xl border border-[var(--hairline)] border-dashed bg-[var(--surface-1)] px-6 py-12 text-center text-[14px] text-[var(--ink-50)]">
          Nenhum produto encontrado nesta categoria.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence initial={false}>
            {list.data.items.map((item, idx) => (
              <motion.li
                key={item.id}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.32, ease: EASE, delay: Math.min(idx * 0.04, 0.4) }}
              >
                <ListingCard listing={item} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </main>
  );
}

function ListingCard({
  listing,
}: {
  listing: {
    id: string;
    productSlug: string;
    workspaceName: string;
    headline: string;
    pitch: string;
    coverImageUrl: string | null;
    priceCents: number;
    currency: string;
  };
}) {
  // Card click routes to the detail page (which then routes to the
  // producer's checkout). Two-step lets us record clicks server-side
  // + show the pitch before the buyer leaves the marketplace.
  const detailUrl = `/marketplace/${listing.id}`;
  const recordClick = trpc.marketplace.recordClick.useMutation();
  const formattedPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: listing.currency || 'BRL',
  }).format(listing.priceCents / 100);
  return (
    <motion.a
      href={detailUrl}
      onClick={() => recordClick.mutate({ listingId: listing.id })}
      whileHover={{ y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="group flex h-full flex-col gap-3 overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-4 transition hover:border-[var(--ink-50)] hover:shadow-[0_18px_36px_-12px_rgba(15,23,42,0.18)]"
    >
      {listing.coverImageUrl ? (
        <img
          src={listing.coverImageUrl}
          alt={listing.headline}
          className="aspect-square w-full rounded-xl object-cover"
        />
      ) : (
        <div className="grid aspect-square w-full place-items-center rounded-xl bg-[var(--surface-2)] text-[var(--ink-50)]">
          <svg viewBox="0 0 24 24" fill="none" className="size-8" aria-hidden>
            <title>Sem capa</title>
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" />
            <circle cx="9" cy="11" r="1.5" fill="currentColor" />
            <path d="M3 17l5-5 6 6 4-4 3 3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-[10px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
          {listing.workspaceName}
        </p>
        <h3 className="line-clamp-2 font-semibold text-[16px] text-[var(--ink-100)] leading-tight">
          {listing.headline}
        </h3>
        {listing.pitch ? (
          <p className="line-clamp-2 text-[12px] text-[var(--ink-70)] leading-[1.5]">
            {listing.pitch}
          </p>
        ) : null}
      </div>
      <div className="mt-auto flex items-baseline justify-between gap-2">
        <span className="font-bold text-[18px] text-[var(--ink-100)] tracking-tight">
          {formattedPrice}
        </span>
        <span className="font-semibold text-[12px] text-[var(--dop-600)] transition group-hover:underline">
          Ver oferta →
        </span>
      </div>
    </motion.a>
  );
}

function SkeletonGrid() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton; index is the only stable key.
          key={i}
          className="aspect-[3/4] animate-pulse rounded-2xl bg-[var(--surface-2)]"
        />
      ))}
    </ul>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-4 text-[var(--ink-50)]"
      aria-hidden
    >
      <title>Buscar</title>
      <circle cx="7" cy="7" r="4" />
      <path d="M10.5 10.5L13 13" strokeLinecap="round" />
    </svg>
  );
}
