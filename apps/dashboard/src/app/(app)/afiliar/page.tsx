'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../components/ui';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

type RouterOutput = inferRouterOutputs<AppRouter>;
type Item = RouterOutput['marketplace']['browseForAffiliation']['items'][number];

/**
 * Affiliate shop — Pilar 1 buyer-as-affiliate surface.
 *
 * Lists every public+active marketplace product that has at least one
 * open affiliate program. Each card surfaces the commission preview
 * (% / flat / recurring / lifetime) + approval policy so the
 * affiliate decides without leaving the grid.
 *
 * Click the "Afiliar" button → `affiliates.requestMembership` →
 *   - `automatic` programs auto-approve and the toast invites the
 *     user to /afiliado to grab the tracking link.
 *   - `manual` programs put the application into the producer queue
 *     (pending status). The producer sees it in `/produtos` review.
 *   - `invite_only` programs throw FORBIDDEN — we hide the button
 *     for those (already filtered out server-side via isPublic).
 *
 * Filters mirror the marketplace shop (search + category + sort) so a
 * producer who is also an affiliate uses one mental model across both
 * surfaces.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

const CATEGORIES = [
  { value: undefined, label: 'Todas' },
  { value: 'cursos' as const, label: 'Cursos' },
  { value: 'mentorias' as const, label: 'Mentorias' },
  { value: 'comunidades' as const, label: 'Comunidades' },
  { value: 'software' as const, label: 'Software' },
  { value: 'ebooks' as const, label: 'E-books' },
  { value: 'consultorias' as const, label: 'Consultorias' },
  { value: 'eventos' as const, label: 'Eventos' },
  { value: 'servicos' as const, label: 'Serviços' },
  { value: 'outros' as const, label: 'Outros' },
] as const;

const SORTS = [
  { value: 'popular' as const, label: 'Populares' },
  { value: 'recent' as const, label: 'Mais novos' },
  { value: 'price_lo' as const, label: 'Menor preço' },
  { value: 'price_hi' as const, label: 'Maior preço' },
];

type Category = (typeof CATEGORIES)[number]['value'];
type Sort = (typeof SORTS)[number]['value'];

export default function AfiliarPage() {
  const router = useRouter();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>(undefined);
  const [sort, setSort] = useState<Sort>('popular');

  // Trim + minLength to satisfy the input schema (`.min(1)`).
  const q = search.trim().length >= 1 ? search.trim() : undefined;

  const browse = trpc.marketplace.browseForAffiliation.useQuery({
    q,
    category,
    sort,
    limit: 48,
  });

  const request = trpc.affiliates.requestMembership.useMutation({
    onSuccess: (result) => {
      utils.affiliates.myDashboard.invalidate();
      if (result.autoApproved) {
        toast.success('Afiliação aprovada.', {
          description: 'Vá em "Sou afiliado" pra pegar seu link de divulgação.',
          action: {
            label: 'Abrir',
            onClick: () => router.push('/afiliado'),
          },
        });
      } else if (result.status === 'pending') {
        toast.success('Solicitação enviada.', {
          description: 'O produtor vai revisar e você é notificado assim que aprovar.',
        });
      } else if (result.status === 'approved') {
        toast.success('Você já é afiliado deste produto.', {
          description: 'Abra "Sou afiliado" pra pegar seu link.',
          action: {
            label: 'Abrir',
            onClick: () => router.push('/afiliado'),
          },
        });
      } else if (result.status === 'rejected') {
        toast.error('Sua afiliação anterior a esse produto foi rejeitada.');
      } else if (result.status === 'suspended') {
        toast.error('Sua afiliação a esse produto está suspensa.');
      } else {
        toast(`Status: ${result.status}`);
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const items = browse.data?.items ?? [];
  const isEmpty = !browse.isPending && items.length === 0;

  // Reset the filter chip animation key whenever the active filter
  // changes — keeps the grid feeling responsive without a layout shift.
  const gridKey = useMemo(() => `${category ?? 'all'}-${sort}-${q ?? ''}`, [category, sort, q]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-10"
    >
      <header className="flex flex-col gap-3">
        <Kicker>distribuição · afiliação</Kicker>
        <Heading level={1}>Afilie-se a um produto.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Vitrine dos produtos abertos pra afiliação na rede Univercart. Solicite uma vez, ganhe um
          link próprio e leve sua comissão a cada venda gerada.
        </p>
      </header>

      {/* Filter bar */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, nicho ou palavra-chave"
              className="w-full rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pr-4 pl-11 text-[14px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
            />
            <span className="-translate-y-1/2 absolute top-1/2 left-4 text-[var(--color-fg-subtle)]">
              <SearchIcon />
            </span>
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="appearance-none rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pr-9 pl-4 text-[14px] text-[var(--color-fg)] outline-none transition hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => {
            const active = category === c.value;
            return (
              <button
                key={c.value ?? 'all'}
                type="button"
                onClick={() => setCategory(c.value)}
                className={`cursor-pointer rounded-full border px-4 py-1.5 font-medium text-[13px] transition ${
                  active
                    ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-white'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Grid */}
      {browse.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
              key={i}
              className="h-72 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
            />
          ))}
        </div>
      ) : isEmpty ? (
        <div className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] p-10 text-center">
          <Heading level={3}>Nada encontrado.</Heading>
          <p className="mx-auto mt-2 max-w-md text-[14px] text-[var(--color-fg-muted)] leading-[1.55]">
            Nenhum produto aberto para afiliação bate com seu filtro agora. Tente outra categoria ou
            volte depois — a vitrine cresce todos os dias.
          </p>
        </div>
      ) : (
        <motion.section
          key={gridKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: EASE }}
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <AnimatePresence initial={false}>
            {items.map((item, idx) => (
              <ListingCard
                key={item.id}
                item={item}
                index={idx}
                onAffiliate={() => request.mutate({ programId: item.defaultProgramId })}
                disabled={
                  request.isPending && request.variables?.programId === item.defaultProgramId
                }
              />
            ))}
          </AnimatePresence>
        </motion.section>
      )}
    </motion.div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function ListingCard({
  item,
  index,
  onAffiliate,
  disabled,
}: {
  item: Item;
  index: number;
  onAffiliate: () => void;
  disabled: boolean;
}) {
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.28, ease: EASE, delay: Math.min(index * 0.02, 0.16) }}
      className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] transition hover:border-[var(--color-border-strong)] hover:shadow-[0_8px_28px_-12px_rgba(0,0,0,0.18)]"
    >
      {/* Cover */}
      <div className="relative aspect-[16/9] overflow-hidden bg-[var(--color-surface-muted)]">
        {item.coverImageUrl ? (
          <img
            src={item.coverImageUrl}
            alt={item.headline}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
            sem capa
          </div>
        )}
        <div className="absolute top-3 left-3">
          <CategoryBadge category={item.category} />
        </div>
        <div className="absolute top-3 right-3">
          <PolicyBadge policy={item.approvalPolicy} />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <h3 className="line-clamp-2 font-semibold text-[16px] text-[var(--color-fg)] leading-snug">
            {item.headline}
          </h3>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">
            por {item.workspaceName}
          </span>
        </div>

        <p className="line-clamp-3 text-[13px] text-[var(--color-fg-muted)] leading-relaxed">
          {item.pitch || 'O produtor ainda não escreveu um pitch.'}
        </p>

        {/* Commission + price strip */}
        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--color-surface-muted)] px-4 py-3">
            <div className="flex flex-col">
              <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                Sua comissão
              </span>
              <span className="font-semibold text-[15px] text-[var(--color-brand-700)]">
                {formatCommission(item)}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                Ticket
              </span>
              <span className="font-semibold text-[15px] text-[var(--color-fg)]">
                {formatCents(item.priceCents, item.currency as 'BRL' | 'USD' | 'EUR')}
              </span>
            </div>
          </div>

          <Button onClick={onAffiliate} disabled={disabled} className="w-full" size="sm">
            {disabled ? 'Solicitando…' : 'Afiliar-se'}
          </Button>
        </div>
      </div>
    </motion.article>
  );
}

// ─── Badges ────────────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category: string }) {
  const label = CATEGORIES.find((c) => c.value === category)?.label ?? category;
  return (
    <span className="rounded-full bg-[var(--color-bg)]/85 px-3 py-1 font-medium text-[11px] text-[var(--color-fg)] uppercase tracking-wider shadow-sm backdrop-blur">
      {label}
    </span>
  );
}

function PolicyBadge({ policy }: { policy: 'automatic' | 'manual' | 'invite_only' }) {
  const map = {
    automatic: {
      label: 'Aprovação automática',
      classes: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    manual: {
      label: 'Análise do produtor',
      classes: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
    },
    invite_only: {
      label: 'Somente convidados',
      classes: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
    },
  } as const;
  const meta = map[policy];
  return (
    <span
      className={`rounded-full px-3 py-1 font-semibold text-[10px] uppercase tracking-wider shadow-sm ${meta.classes}`}
    >
      {meta.label}
    </span>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatCommission(item: Item): string {
  switch (item.commissionType) {
    case 'percent': {
      const pct = item.commissionPercent ?? 0;
      return `${pct}% por venda`;
    }
    case 'flat': {
      const flat = item.commissionFlatCents ?? 0;
      return `${formatCents(flat, item.currency as 'BRL' | 'USD' | 'EUR')} por venda`;
    }
    case 'recurring': {
      const pct = item.commissionPercent ?? 0;
      const cap = item.recurringCycleLimit;
      return cap ? `${pct}% recorrente · ${cap}x` : `${pct}% recorrente`;
    }
    case 'lifetime': {
      const pct = item.commissionPercent ?? 0;
      return `${pct}% vitalício`;
    }
    default: {
      // exhaustiveness — when the enum grows, TS flags this branch.
      const _exhaustive: never = item.commissionType;
      return _exhaustive;
    }
  }
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Buscar"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
