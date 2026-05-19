'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Heading, Kicker } from '../../../components/ui';
import { useSession } from '../../../lib/auth';
import { API_URL } from '../../../lib/env';
import { trpc } from '../../../lib/trpc';

/**
 * Meu Checkout — high-level configuration surface that joins three
 * domains the producer thinks of together:
 *   1. Brand (cor + logo + nome da empresa) → routes to /configuracoes/marca
 *   2. Métodos de pagamento → routes to /integrations/gateways
 *   3. Recuperação de carrinho → routes to /carrinho
 *
 * The "Builder" surface (custom fields, layout, upsells, pixels) is
 * the bigger product surface that follows — we ship the navigational
 * hub now so producers find the controls they're looking for instead
 * of bouncing.
 */

interface Capability {
  id: string;
  title: string;
  description: string;
  href?: string;
  status: 'ativo' | 'em-breve';
}

const CAPABILITIES: Capability[] = [
  {
    id: 'brand',
    title: 'Identidade visual',
    description: 'Logo, nome da empresa e cor primária aparecem no topo do checkout público.',
    href: '/configuracoes/marca',
    status: 'ativo',
  },
  {
    id: 'methods',
    title: 'Métodos de pagamento',
    description: 'Pix, cartão e boleto ligados via Mercado Pago. Outros gateways em breve.',
    href: '/integrations/gateways',
    status: 'ativo',
  },
  {
    id: 'recovery',
    title: 'Recuperação de carrinho',
    description: 'Cadência automática por WhatsApp + email quando o pagamento não completa.',
    href: '/carrinho',
    status: 'ativo',
  },
  {
    id: 'fields',
    title: 'Campos extras',
    description: 'CEP + endereço completo, perguntas customizadas, validações dinâmicas.',
    status: 'em-breve',
  },
  {
    id: 'pixels',
    title: 'Pixels & tracking',
    description: 'Meta Pixel, Google Analytics, TikTok Pixel — eventos disparados por etapa.',
    status: 'em-breve',
  },
  {
    id: 'upsell',
    title: 'Order bump · upsell pós-compra',
    description: 'Ofereça produtos adicionais no checkout e após o pagamento.',
    status: 'em-breve',
  },
];

export default function CheckoutConfigPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  // Preview state — show the producer's most-recent product + branding
  // so the page feels alive instead of static.
  const products = trpc.products.list.useQuery(undefined, {
    enabled: !!session.data,
    staleTime: 30_000,
  });
  const branding = trpc.workspace.branding.useQuery(undefined, {
    enabled: !!session.data,
    staleTime: 30_000,
  });

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  const firstProduct = products.data?.[0];

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <Kicker>configurar · meu checkout</Kicker>
        <Heading level={1}>Personalize seu checkout.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Cada produto tem um link público pronto em
          <code className="font-mono text-[13px]"> check.univercart.com/c/&lt;slug&gt;</code> com a
          sua marca, métodos de pagamento e cadência de recuperação. Ajuste tudo nas seções abaixo.
        </p>
      </header>

      {/* Live preview strip */}
      <section className="grid gap-6 lg:grid-cols-[1fr_minmax(0,1.2fr)]">
        <article className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Preview da identidade
          </h2>
          <div className="flex items-center gap-4">
            {branding.data?.hasLogo ? (
              <img
                src={`${API_URL}/img/workspace/${branding.data.workspaceId}/logo?v=${Date.now()}`}
                alt={branding.data.displayName}
                className="size-12 rounded-xl object-cover"
              />
            ) : (
              <div
                className="grid size-12 place-items-center rounded-xl font-semibold text-[16px] text-white"
                style={{
                  background:
                    branding.data?.brandPrimaryColor ??
                    'linear-gradient(135deg, var(--color-brand-400) 0%, var(--color-brand-600) 100%)',
                }}
              >
                {(branding.data?.displayName?.[0] ?? 'p').toUpperCase()}
              </div>
            )}
            <div className="flex flex-col">
              <span className="font-semibold text-[16px] text-[var(--color-fg)]">
                {branding.data?.displayName ?? '—'}
              </span>
              <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                {branding.data?.brandPrimaryColor ?? 'sem cor primária'}
              </span>
            </div>
          </div>
          <Link
            href="/configuracoes/marca"
            className="self-start rounded-xl border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)]"
          >
            Editar marca →
          </Link>
        </article>

        <article className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Produto em destaque
          </h2>
          {firstProduct ? (
            <div className="flex items-center gap-4">
              {firstProduct.hasCover ? (
                <img
                  src={`${API_URL}/img/product/${firstProduct.id}/cover?v=${Date.now()}`}
                  alt={firstProduct.name}
                  className="size-16 rounded-xl object-cover"
                />
              ) : (
                <div
                  aria-hidden
                  className="grid size-16 place-items-center rounded-xl bg-[var(--color-surface-muted)] text-[10px] text-[var(--color-fg-subtle)]"
                >
                  1:1
                </div>
              )}
              <div className="flex flex-col">
                <span className="font-semibold text-[15px] text-[var(--color-fg)]">
                  {firstProduct.name}
                </span>
                <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                  check.univercart.com/c/{firstProduct.slug}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Você ainda não cadastrou nenhum produto.
            </p>
          )}
          <Link
            href={firstProduct ? `/produtos/${firstProduct.id}` : '/produtos/novo'}
            className="self-start rounded-xl border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)]"
          >
            {firstProduct ? 'Editar produto →' : 'Cadastrar produto →'}
          </Link>
        </article>
      </section>

      {/* Capabilities grid */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold text-[16px] text-[var(--color-fg)]">Áreas do checkout</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {CAPABILITIES.map((cap) => {
            const active = cap.status === 'ativo';
            const Wrapper = ({ children }: { children: React.ReactNode }) =>
              cap.href ? (
                <Link
                  href={cap.href}
                  className="group flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition hover:border-[var(--color-border-strong)]"
                >
                  {children}
                </Link>
              ) : (
                <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 opacity-70">
                  {children}
                </div>
              );
            return (
              <Wrapper key={cap.id}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-[15px] text-[var(--color-fg)]">{cap.title}</h3>
                  <span
                    className={
                      active
                        ? 'rounded-full bg-[var(--color-success-bg)] px-2.5 py-0.5 font-medium text-[10px] text-[var(--color-success)] uppercase tracking-wider'
                        : 'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider'
                    }
                  >
                    {active ? (
                      'Ativo'
                    ) : (
                      <>
                        <LockIcon size={10} /> Em breve
                      </>
                    )}
                  </span>
                </div>
                <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
                  {cap.description}
                </p>
                {active && cap.href ? (
                  <span className="self-start text-[12px] text-[var(--color-brand-600)] group-hover:underline">
                    Abrir →
                  </span>
                ) : null}
              </Wrapper>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>cadeado</title>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
