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
  const utils = trpc.useUtils();

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
  const profile = trpc.workspace.profile.useQuery(undefined, {
    enabled: !!session.data,
    staleTime: 30_000,
  });
  const updateProfile = trpc.workspace.updateProfile.useMutation({
    onSuccess: () => {
      utils.workspace.profile.invalidate();
    },
  });

  const selectedTemplate: 'single' | 'stepper' = profile.data?.checkoutTemplate ?? 'single';
  const pickTemplate = (next: 'single' | 'stepper') => {
    if (next === selectedTemplate) return;
    updateProfile.mutate({ checkoutTemplate: next });
  };

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

      {/* Template picker */}
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold text-[16px] text-[var(--color-fg)]">Modelo do checkout</h2>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">
            Vale para todos os produtos
          </span>
        </div>
        <p className="max-w-2xl text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
          Escolha o layout que o comprador vai ver em todos os seus produtos. O modelo de etapa
          única converte melhor em impulso; o passo-a-passo passa mais segurança em tickets altos.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <TemplateOption
            templateId="single"
            title="Etapa única"
            tagline="Tudo na mesma tela"
            description="Identificação e pagamento num único formulário. Menos cliques, mais conversão em compras de impulso."
            selected={selectedTemplate === 'single'}
            pending={updateProfile.isPending}
            onPick={() => pickTemplate('single')}
            preview={<TemplatePreviewSingle />}
          />
          <TemplateOption
            templateId="stepper"
            title="Passo-a-passo"
            tagline="3 cards numerados"
            description="Identificação primeiro, pagamento depois. Cada passo concluído colapsa em um cartão com Editar — ótimo pra ticket alto."
            selected={selectedTemplate === 'stepper'}
            pending={updateProfile.isPending}
            onPick={() => pickTemplate('stepper')}
            preview={<TemplatePreviewStepper />}
          />
        </div>
        {updateProfile.error ? (
          <p className="text-[13px] text-[var(--color-danger)]">{updateProfile.error.message}</p>
        ) : null}
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

function TemplateOption({
  templateId,
  title,
  tagline,
  description,
  selected,
  pending,
  preview,
  onPick,
}: {
  templateId: 'single' | 'stepper';
  title: string;
  tagline: string;
  description: string;
  selected: boolean;
  pending: boolean;
  preview: React.ReactNode;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={pending && !selected}
      aria-pressed={selected}
      data-template={templateId}
      className={
        selected
          ? 'group flex flex-col gap-4 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
          : 'group flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]'
      }
    >
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
        {preview}
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</span>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">{tagline}</span>
        </div>
        {selected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-brand-50)] px-2.5 py-1 font-semibold text-[11px] text-[var(--color-brand-700)] uppercase tracking-wider">
            <CheckIcon size={11} /> Em uso
          </span>
        ) : (
          <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
            {pending ? 'Salvando…' : 'Usar este'}
          </span>
        )}
      </div>
      <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">{description}</p>
    </button>
  );
}

/** Wire-frame style preview: single column with one solid form block. */
function TemplatePreviewSingle() {
  return (
    <svg
      viewBox="0 0 240 130"
      className="h-[130px] w-full"
      role="img"
      aria-label="Preview do checkout em etapa única"
    >
      <title>Etapa única</title>
      <rect x="0" y="0" width="240" height="130" fill="transparent" />
      {/* Header */}
      <rect x="12" y="10" width="60" height="6" rx="2" fill="#cbd5e1" />
      {/* Single form column */}
      <rect
        x="12"
        y="26"
        width="150"
        height="92"
        rx="6"
        fill="#fff"
        stroke="#16a34a"
        strokeOpacity="0.55"
      />
      <rect x="22" y="36" width="40" height="4" rx="1.5" fill="#94a3b8" />
      <rect x="22" y="46" width="130" height="10" rx="3" fill="#f1f5f9" />
      <rect x="22" y="60" width="56" height="10" rx="3" fill="#f1f5f9" />
      <rect x="84" y="60" width="68" height="10" rx="3" fill="#f1f5f9" />
      <rect x="22" y="76" width="130" height="10" rx="3" fill="#f1f5f9" />
      <rect x="22" y="94" width="130" height="14" rx="4" fill="#16a34a" />
      {/* Sticky summary */}
      <rect x="172" y="26" width="56" height="92" rx="6" fill="#fff" stroke="#e2e8f0" />
      <rect x="180" y="34" width="32" height="4" rx="1.5" fill="#94a3b8" />
      <rect x="180" y="44" width="40" height="4" rx="1.5" fill="#e2e8f0" />
      <rect x="180" y="52" width="40" height="4" rx="1.5" fill="#e2e8f0" />
      <rect x="180" y="100" width="40" height="8" rx="2" fill="#16a34a" />
    </svg>
  );
}

/** Wire-frame style preview: 3 numbered cards stacked vertically. */
function TemplatePreviewStepper() {
  return (
    <svg
      viewBox="0 0 240 130"
      className="h-[130px] w-full"
      role="img"
      aria-label="Preview do checkout em 3 passos"
    >
      <title>Passo-a-passo</title>
      <rect x="0" y="0" width="240" height="130" fill="transparent" />
      {/* Header */}
      <rect x="12" y="10" width="60" height="6" rx="2" fill="#cbd5e1" />
      {/* Stacked stepper cards */}
      <rect x="12" y="24" width="150" height="22" rx="6" fill="#fff" stroke="#e2e8f0" />
      <circle cx="22" cy="35" r="5" fill="#16a34a" />
      <path
        d="M19.5 35 l2 2 l3 -3"
        stroke="#fff"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="32" y="32" width="50" height="4" rx="1.5" fill="#0f172a" />
      <rect x="140" y="32" width="16" height="4" rx="1.5" fill="#16a34a" />

      <rect
        x="12"
        y="50"
        width="150"
        height="60"
        rx="6"
        fill="#fff"
        stroke="#16a34a"
        strokeOpacity="0.55"
        strokeWidth="1.4"
      />
      <circle cx="22" cy="61" r="5" fill="#16a34a" />
      <text x="22" y="63.5" textAnchor="middle" fontSize="6" fill="#fff" fontWeight="700">
        2
      </text>
      <rect x="32" y="58" width="50" height="4" rx="1.5" fill="#0f172a" />
      <rect x="22" y="72" width="130" height="8" rx="3" fill="#f1f5f9" />
      <rect x="22" y="84" width="130" height="8" rx="3" fill="#f1f5f9" />
      <rect x="22" y="96" width="130" height="10" rx="3" fill="#16a34a" />

      {/* Summary */}
      <rect x="172" y="24" width="56" height="86" rx="6" fill="#fff" stroke="#e2e8f0" />
      <rect x="180" y="32" width="32" height="4" rx="1.5" fill="#94a3b8" />
      <rect x="180" y="42" width="40" height="4" rx="1.5" fill="#e2e8f0" />
      <rect x="180" y="92" width="40" height="8" rx="2" fill="#16a34a" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>selecionado</title>
      <path d="M5 12l5 5 9-9" />
    </svg>
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
