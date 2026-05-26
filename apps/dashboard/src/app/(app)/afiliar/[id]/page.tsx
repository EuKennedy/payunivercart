'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { formatCents } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';

/**
 * Affiliate-product detail page.
 *
 * Routed at `/afiliar/[id]` where `[id]` is the marketplace listing id
 * (UUID). Shows the full pitch (no line-clamp), commission terms in
 * plain language, approval policy, refund + attribution windows, the
 * producer's own checkout URL for reference, and a sticky "Afiliar-se"
 * CTA.
 *
 * Data: `marketplace.detailForAffiliation` returns NULL when the
 * listing is paused/draft OR the workspace has no public+active
 * program — both render the same "not found" state so a stale
 * bookmark never reveals an unaffiliable card.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

const CATEGORY_LABELS: Record<string, string> = {
  cursos: 'Cursos',
  mentorias: 'Mentorias',
  comunidades: 'Comunidades',
  software: 'Software / SaaS',
  ebooks: 'E-books',
  consultorias: 'Consultorias',
  eventos: 'Eventos',
  servicos: 'Serviços',
  outros: 'Outros',
};

export default function AffiliateDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();

  const detail = trpc.marketplace.detailForAffiliation.useQuery(
    { listingId: params.id },
    { enabled: !!params.id },
  );

  const request = trpc.affiliates.requestMembership.useMutation({
    onSuccess: (result) => {
      utils.affiliates.myDashboard.invalidate();
      if (result.autoApproved) {
        toast.success('Afiliação aprovada.', {
          description: 'Vá em "Sou afiliado" pra pegar seu link de divulgação.',
          action: { label: 'Abrir', onClick: () => router.push('/afiliado') },
        });
      } else if (result.status === 'pending') {
        toast.success('Solicitação enviada.', {
          description: 'O produtor vai revisar — você é notificado na aprovação.',
        });
      } else if (result.status === 'approved') {
        toast.success('Você já é afiliado deste produto.', {
          description: 'Abra "Sou afiliado" pra pegar seu link.',
          action: { label: 'Abrir', onClick: () => router.push('/afiliado') },
        });
      } else if (result.status === 'rejected') {
        toast.error('Sua afiliação anterior a esse produto foi rejeitada.');
      } else if (result.status === 'suspended') {
        toast.error('Sua afiliação a esse produto está suspensa.');
      } else {
        toast(`Status: ${result.status}`);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const checkoutBase = useMemo(
    () => (process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://pay.univercart.com').replace(/\/$/, ''),
    [],
  );

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <div className="h-6 w-40 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="h-[420px] animate-pulse rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-[420px] animate-pulse rounded-2xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    );
  }

  if (!detail.data) {
    return (
      <div className="flex flex-col gap-6">
        <Link
          href="/afiliar"
          className="font-medium text-[13px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
        >
          ← Voltar para a vitrine
        </Link>
        <div className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] p-10 text-center">
          <Heading level={3}>Produto indisponível.</Heading>
          <p className="mx-auto mt-2 max-w-md text-[14px] text-[var(--color-fg-muted)] leading-[1.55]">
            Esse produto não está mais aberto para afiliação ou foi pausado pelo produtor.
          </p>
        </div>
      </div>
    );
  }

  const item = detail.data;
  const categoryLabel = CATEGORY_LABELS[item.category] ?? item.category;
  // Producer's custom sales/landing page wins over the default checkout
  // URL — they may run a VSL or longform copy before the bare checkout.
  const productCheckoutUrl = item.salesPageUrl ?? `${checkoutBase}/c/${item.productSlug}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-8"
    >
      <Link
        href="/afiliar"
        className="self-start font-medium text-[13px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
      >
        ← Voltar para a vitrine
      </Link>

      <header className="flex flex-col gap-3">
        <Kicker>
          {categoryLabel} · por {item.workspaceName}
        </Kicker>
        <Heading level={1}>{item.headline}</Heading>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        {/* Left — cover + pitch */}
        <section className="flex flex-col gap-6">
          <div className="relative aspect-[16/9] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
            {item.coverImageUrl ? (
              <img
                src={item.coverImageUrl}
                alt={item.headline}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[12px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                sem capa
              </div>
            )}
          </div>

          <article className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Sobre o produto
            </h2>
            <p className="whitespace-pre-line text-[14px] text-[var(--color-fg)] leading-[1.65]">
              {item.pitch?.trim() || 'O produtor ainda não escreveu um pitch para este produto.'}
            </p>
          </article>

          <article className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Página de venda do produtor
            </h2>
            <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">
              Esta é a página onde o comprador finaliza a compra. Seu link de afiliado redireciona
              pra cá com o cookie de atribuição ativo.
            </p>
            <a
              href={productCheckoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 self-start rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-medium text-[13px] text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]"
            >
              Abrir página de venda
              <span aria-hidden>↗</span>
            </a>
          </article>
        </section>

        {/* Right — sticky CTA + program facts */}
        <aside className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
          <div className="flex flex-col gap-5 rounded-2xl border border-[var(--color-brand-500)]/30 bg-gradient-to-br from-[var(--color-brand-50)]/40 via-[var(--color-surface)] to-[var(--color-surface)] p-6 shadow-[0_24px_56px_-24px_rgba(22,163,74,0.18)]">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                Sua comissão
              </span>
              <span className="font-bold text-[28px] text-[var(--color-brand-700)] tracking-tight">
                {formatCommissionFull(item)}
              </span>
              <span className="text-[12px] text-[var(--color-fg-subtle)]">
                Sobre ticket de{' '}
                <span className="font-semibold text-[var(--color-fg)]">
                  {formatCents(item.priceCents, item.currency as 'BRL' | 'USD' | 'EUR')}
                </span>
              </span>
            </div>

            <Button
              onClick={() => request.mutate({ programId: item.defaultProgramId })}
              disabled={request.isPending}
              size="lg"
              className="w-full"
            >
              {request.isPending ? 'Solicitando…' : 'Afiliar-se a este produto'}
            </Button>

            <PolicyExplainer policy={item.approvalPolicy} />
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Regras do programa
            </h3>
            <Fact
              label="Janela de atribuição"
              value={`${item.attributionWindowDays} dias`}
              hint="Tempo entre o clique no seu link e a compra para você receber a comissão."
            />
            <Fact
              label="Janela de reembolso"
              value={`${item.refundWindowDays} dias`}
              hint="Período em que a comissão fica pendente. Se o comprador não pedir reembolso, libera."
            />
            <Fact
              label="Modelo de comissão"
              value={commissionModelLabel(item.commissionType)}
              hint={commissionModelHint(item)}
            />
          </div>
        </aside>
      </div>
    </motion.div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1 border-[var(--color-border)] border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-[var(--color-fg-muted)]">{label}</span>
        <span className="font-semibold text-[14px] text-[var(--color-fg)] tabular-nums">
          {value}
        </span>
      </div>
      <span className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.45]">{hint}</span>
    </div>
  );
}

function PolicyExplainer({ policy }: { policy: 'automatic' | 'manual' | 'invite_only' }) {
  const map = {
    automatic: {
      label: 'Aprovação automática',
      detail: 'Ao clicar você é aprovado na hora e já recebe o link de divulgação.',
      classes: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    },
    manual: {
      label: 'Análise do produtor',
      detail: 'Sua solicitação entra na fila do produtor. Você é notificado quando ele decidir.',
      classes: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
    },
    invite_only: {
      label: 'Somente convidados',
      detail: 'Este programa só aceita afiliados via convite direto. Fale com o produtor.',
      classes: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
    },
  } as const;
  const meta = map[policy];
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${meta.classes}`}
      >
        {meta.label}
      </span>
      <span className="text-[12px] text-[var(--color-fg-muted)] leading-[1.5]">{meta.detail}</span>
    </div>
  );
}

function formatCommissionFull(item: {
  commissionType: 'percent' | 'flat' | 'recurring' | 'lifetime';
  commissionPercent: number | null;
  commissionFlatCents: number | null;
  currency: string;
  recurringCycleLimit: number | null;
}): string {
  switch (item.commissionType) {
    case 'percent':
      return `${item.commissionPercent ?? 0}% por venda`;
    case 'flat':
      return `${formatCents(item.commissionFlatCents ?? 0, item.currency as 'BRL' | 'USD' | 'EUR')} por venda`;
    case 'recurring': {
      const cap = item.recurringCycleLimit;
      return cap
        ? `${item.commissionPercent ?? 0}% recorrente · ${cap}x`
        : `${item.commissionPercent ?? 0}% recorrente`;
    }
    case 'lifetime':
      return `${item.commissionPercent ?? 0}% vitalício`;
    default: {
      const _exhaustive: never = item.commissionType;
      return _exhaustive;
    }
  }
}

function commissionModelLabel(type: 'percent' | 'flat' | 'recurring' | 'lifetime'): string {
  switch (type) {
    case 'percent':
      return 'Pagamento único';
    case 'flat':
      return 'Valor fixo';
    case 'recurring':
      return 'Recorrente';
    case 'lifetime':
      return 'Vitalício';
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function commissionModelHint(item: {
  commissionType: 'percent' | 'flat' | 'recurring' | 'lifetime';
  recurringCycleLimit: number | null;
}): string {
  switch (item.commissionType) {
    case 'percent':
      return 'Você ganha a comissão uma vez por venda, mesmo se for assinatura recorrente.';
    case 'flat':
      return 'Valor fixo por venda, independente do preço do produto.';
    case 'recurring':
      return item.recurringCycleLimit
        ? `Comissão a cada ciclo da assinatura, limitada a ${item.recurringCycleLimit} ciclos.`
        : 'Comissão a cada renovação da assinatura, dentro do limite definido pelo produtor.';
    case 'lifetime':
      return 'Comissão por todas as renovações enquanto o cliente continuar pagando. Para sempre.';
    default: {
      const _exhaustive: never = item.commissionType;
      return _exhaustive;
    }
  }
}
