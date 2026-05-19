'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { trpc } from '../lib/trpc';

/**
 * Post-signup wizard that the dashboard hero collapses into until the
 * producer has reached a "sellable" state. Four gates:
 *
 *   1. Marca       — companyName OR brand logo set in Configurações
 *   2. Mercado Pago — at least one gateway connected
 *   3. WhatsApp    — session exists AND status === 'WORKING'
 *   4. Produto     — at least one product cadastrado
 *
 * When all four are checked we hide the wizard entirely (the dashboard
 * hero takes over). The wizard never blocks the rest of the dashboard
 * — it sits at the top as a guided checklist the producer can follow
 * out of order if they want.
 */

interface Step {
  id: 'marca' | 'gateway' | 'whatsapp' | 'produto';
  label: string;
  description: string;
  href: string;
  ctaPending: string;
  ctaDone: string;
}

const STEPS: Step[] = [
  {
    id: 'marca',
    label: 'Marca da empresa',
    description: 'Nome + logo aparecem no topo do seu checkout público.',
    href: '/configuracoes/marca',
    ctaPending: 'Configurar marca',
    ctaDone: 'Editar marca',
  },
  {
    id: 'gateway',
    label: 'Mercado Pago',
    description: 'Conecte suas chaves pra receber Pix, cartão e boleto.',
    href: '/integrations/gateways',
    ctaPending: 'Conectar gateway',
    ctaDone: 'Gerenciar gateway',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    description: 'Sessão dedicada pra disparar confirmação e recuperação.',
    href: '/integrations/whatsapp',
    ctaPending: 'Conectar WhatsApp',
    ctaDone: 'Gerenciar sessão',
  },
  {
    id: 'produto',
    label: 'Primeiro produto',
    description: 'Cadastre o produto pra gerar o link público de checkout.',
    href: '/produtos/novo',
    ctaPending: 'Cadastrar produto',
    ctaDone: 'Ver produtos',
  },
];

export function OnboardingWizard() {
  const branding = trpc.workspace.branding.useQuery();
  const gateways = trpc.gateways.list.useQuery();
  const whatsappMe = trpc.whatsapp.me.useQuery();
  const whatsappStatus = trpc.whatsapp.status.useQuery(undefined, {
    enabled: !!whatsappMe.data,
  });
  const products = trpc.products.list.useQuery();

  const completion = useMemo(() => {
    const marca =
      !!branding.data &&
      ((branding.data.companyName?.trim().length ?? 0) > 0 || branding.data.hasLogo);
    const gateway = (gateways.data?.length ?? 0) > 0;
    const whatsapp = !!whatsappMe.data && whatsappStatus.data?.status === 'WORKING';
    const produto = (products.data?.length ?? 0) > 0;
    return {
      marca,
      gateway,
      whatsapp,
      produto,
      done: [marca, gateway, whatsapp, produto].every(Boolean),
      total: [marca, gateway, whatsapp, produto].filter(Boolean).length,
    };
  }, [branding.data, gateways.data, whatsappMe.data, whatsappStatus.data?.status, products.data]);

  const loading =
    branding.isPending || gateways.isPending || whatsappMe.isPending || products.isPending;

  // Don't render the wizard when:
  //   - any query is still loading (we'd flash a bogus "0/4" otherwise)
  //   - everything's done (dashboard hero takes over)
  if (loading || completion.done) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-end justify-between gap-4 border-[var(--color-border)] border-b px-6 py-5">
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-[11px] text-[var(--color-brand-600)] uppercase tracking-[0.18em]">
            Bora começar
          </p>
          <h2 className="font-semibold text-[20px] text-[var(--color-fg)]">
            Quatro passos pra primeira venda.
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px] text-[var(--color-fg-subtle)]">
            {completion.total}/{STEPS.length}
          </span>
          <div
            className="h-2 w-28 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full bg-[var(--color-brand-500)] transition-all"
              style={{ width: `${(completion.total / STEPS.length) * 100}%` }}
            />
          </div>
        </div>
      </header>

      <ol className="divide-y divide-[var(--color-border)]">
        {STEPS.map((step, idx) => {
          const done = completion[step.id];
          return (
            <li
              key={step.id}
              className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-[var(--color-surface-muted)]/40"
            >
              <div className="flex items-center gap-4">
                {done ? (
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)]"
                    aria-label="concluído"
                  >
                    <CheckIcon />
                  </span>
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-surface-muted)] font-semibold text-[12px] text-[var(--color-fg-subtle)]">
                    {idx + 1}
                  </span>
                )}
                <div className="flex flex-col gap-0.5">
                  <span
                    className={
                      done
                        ? 'font-semibold text-[14px] text-[var(--color-fg-subtle)] line-through'
                        : 'font-semibold text-[14px] text-[var(--color-fg)]'
                    }
                  >
                    {step.label}
                  </span>
                  <span className="text-[12px] text-[var(--color-fg-subtle)]">
                    {step.description}
                  </span>
                </div>
              </div>
              <Link
                href={step.href}
                className={
                  done
                    ? 'rounded-xl border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                    : 'rounded-xl bg-[var(--color-fg)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-inverse)] transition hover:bg-[var(--color-fg-muted)]'
                }
              >
                {done ? step.ctaDone : step.ctaPending}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>concluído</title>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
