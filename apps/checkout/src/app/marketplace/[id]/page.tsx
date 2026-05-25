'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { use, useEffect } from 'react';
import { trpc } from '../../../lib/trpc';

/**
 * Pilar 4 — Public marketplace listing detail.
 *
 * Hits `marketplace.bySlug` (single listing fetch) + records a click
 * via `marketplace.recordClick` on mount. Renders a hero with the
 * pitch, producer name, gradient brand surface, and a primary CTA
 * that deep-links to the producer's own checkout `/c/{slug}`.
 *
 * Premium feel:
 *   - Hero gradient + large product image
 *   - Sticky right column with price + CTA on desktop
 *   - Motion on mount (fade + y), CTA spring on hover/tap
 *   - Producer attribution chip at the top so the buyer knows
 *     they're transacting with the creator, not with the marketplace.
 */

const EASE = [0.16, 1, 0.3, 1] as const;
const CHECKOUT_BASE = (typeof window !== 'undefined' ? window.location.origin : '') || '';

export default function MarketplaceListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const listing = trpc.marketplace.bySlug.useQuery({ listingId: id });
  const recordClick = trpc.marketplace.recordClick.useMutation();

  useEffect(() => {
    if (listing.data) {
      recordClick.mutate({
        listingId: id,
        referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      });
    }
    // intentionally NOT depending on recordClick.mutate to avoid loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.data, id]);

  if (listing.isPending) {
    return (
      <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 px-6 py-10">
        <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
          <div className="h-[420px] animate-pulse rounded-3xl bg-[var(--surface-2)]" />
          <div className="h-[420px] animate-pulse rounded-3xl bg-[var(--surface-2)]" />
        </div>
      </main>
    );
  }

  if (!listing.data) {
    return (
      <main className="mx-auto flex w-full max-w-[680px] flex-col items-center gap-6 px-6 py-24 text-center">
        <h1 className="font-semibold text-[28px] text-[var(--ink-100)] tracking-tight">
          Produto não encontrado.
        </h1>
        <p className="text-[15px] text-[var(--ink-70)] leading-[1.55]">
          A vitrine desse produtor pode ter sido pausada ou removida.
        </p>
        <Link
          href="/marketplace"
          className="rounded-xl bg-[var(--dop-500)] px-5 py-2.5 font-semibold text-[14px] text-white"
        >
          Voltar pra vitrine
        </Link>
      </main>
    );
  }

  const item = listing.data;
  // Pass the marketplace listing id + utm_source as URL params; the
  // checkout page picks them up via useSearchParams() and forwards
  // them in the submit input so the rollup worker can correlate the
  // resulting paid order back to THIS click (exact attribution, not
  // the 24h IP-hash heuristic).
  const checkoutUrl = `${CHECKOUT_BASE}/c/${item.productSlug}?mlid=${encodeURIComponent(
    item.id,
  )}&utm_source=payuniv_marketplace&utm_medium=marketplace&utm_campaign=${encodeURIComponent(
    item.category,
  )}`;
  const formattedPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: item.currency || 'BRL',
  }).format(item.priceCents / 100);

  return (
    <motion.main
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: EASE }}
      className="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-6 py-10 sm:py-14"
    >
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 font-medium text-[12px] text-[var(--ink-50)]">
        <Link href="/marketplace" className="hover:text-[var(--ink-100)] hover:underline">
          Marketplace
        </Link>
        <span aria-hidden>·</span>
        <span className="font-semibold text-[var(--dop-600)] uppercase tracking-wider">
          {item.category}
        </span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        {/* LEFT — cover + pitch */}
        <section className="flex flex-col gap-8">
          <div className="relative overflow-hidden rounded-3xl border border-[var(--hairline)] bg-[var(--surface-1)] shadow-[0_30px_60px_-30px_rgba(15,23,42,0.25)]">
            {item.coverImageUrl ? (
              <img
                src={item.coverImageUrl}
                alt={item.headline}
                className="aspect-[16/10] w-full object-cover"
              />
            ) : (
              <div className="grid aspect-[16/10] w-full place-items-center bg-gradient-to-br from-[var(--dop-50)] via-[var(--surface-2)] to-[var(--surface-1)]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="size-16 text-[var(--ink-50)]"
                  aria-hidden
                >
                  <title>Sem capa</title>
                  <rect
                    x="3"
                    y="5"
                    width="18"
                    height="14"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <circle cx="9" cy="11" r="1.5" fill="currentColor" />
                  <path d="M3 17l5-5 6 6 4-4 3 3" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
            )}
          </div>

          <article className="flex flex-col gap-4">
            <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
              {item.workspaceName}
            </span>
            <h1 className="font-semibold text-[32px] text-[var(--ink-100)] leading-[1.15] tracking-tight sm:text-[40px]">
              {item.headline}
            </h1>
            {item.pitch ? (
              <p className="whitespace-pre-line text-[15px] text-[var(--ink-70)] leading-[1.65]">
                {item.pitch}
              </p>
            ) : (
              <p className="text-[14px] text-[var(--ink-50)] italic">
                Esse produto ainda não tem um pitch detalhado.
              </p>
            )}
          </article>
        </section>

        {/* RIGHT — sticky CTA + producer chip + trust block */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: EASE, delay: 0.08 }}
            className="flex flex-col gap-5 overflow-hidden rounded-3xl border border-[var(--hairline)] bg-[var(--surface-1)] p-6 shadow-[0_30px_60px_-30px_rgba(15,23,42,0.25)]"
          >
            <div className="flex flex-col gap-1">
              <span className="font-semibold text-[10px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
                A partir de
              </span>
              <span className="font-bold text-[36px] text-[var(--ink-100)] tracking-tight tabular-nums">
                {formattedPrice}
              </span>
              <span className="text-[12px] text-[var(--ink-50)]">
                Pagamento Pix · Cartão · Boleto
              </span>
            </div>

            <motion.a
              href={checkoutUrl}
              target="_blank"
              rel="noreferrer"
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-[var(--dop-500)] to-[var(--dop-700)] px-5 py-3 font-semibold text-[15px] text-white shadow-[0_12px_28px_-10px_rgba(22,163,74,0.55)] transition hover:brightness-110"
            >
              Comprar agora
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="size-3.5"
                aria-hidden
              >
                <title>Ir</title>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </motion.a>

            <div className="border-[var(--hairline)] border-t pt-4">
              <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
                Vendido por
              </p>
              <p className="mt-1 font-semibold text-[14px] text-[var(--ink-100)]">
                {item.workspaceName}
              </p>
              <p className="text-[11px] text-[var(--ink-50)] leading-[1.5]">
                Pagamento processado diretamente pelo produtor via Mercado Pago. A payunivercart só
                conecta vocês.
              </p>
            </div>

            <ul className="flex flex-col gap-2.5 border-[var(--hairline)] border-t pt-4">
              <Trust>Acesso imediato após confirmação do pagamento</Trust>
              <Trust>Suporte direto com o produtor</Trust>
              <Trust>Compra protegida pelo Mercado Pago</Trust>
            </ul>
          </motion.div>
        </aside>
      </div>
    </motion.main>
  );
}

function Trust({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[12px] text-[var(--ink-70)] leading-[1.5]">
      <span
        aria-hidden
        className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[var(--dop-50)] text-[var(--dop-700)]"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          className="size-2.5"
        >
          <title>OK</title>
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {children}
    </li>
  );
}
