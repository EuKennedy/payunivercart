'use client';

import Link from 'next/link';
import { trpc } from '../lib/trpc';

/**
 * Floating onboarding widget — ClickUp-style persistent companion that
 * sits at the bottom-right corner of every authenticated screen and
 * follows the producer between pages. State machine:
 *
 *   - `full`      → expanded panel with the checklist + actions
 *   - `minimized` → small chip showing the X/Y progress; click to open
 *   - `hidden`    → not rendered (completed, dismissed, or still loading)
 *
 * State is persisted server-side via `workspace.onboardingState` +
 * `workspace.onboardingAction`. We poll on mount + tab focus rather
 * than open a WebSocket; the API is fast and the progress only
 * advances when the producer takes an action that already triggers a
 * tRPC invalidation.
 *
 * Steps surface as DOM links to the relevant pages — we intentionally
 * skip spotlight/walkthrough/highlight overlays in v1. Spotlight is a
 * lot of overhead (position tracking, scroll lock, accessibility) and
 * a well-labeled link delivers ~80% of the value. Walkthrough comes
 * back in v2 if engagement data justifies it.
 */

interface Step {
  id: 'marca' | 'gateway' | 'whatsapp' | 'produto' | 'publicar' | 'primeiraVenda';
  label: string;
  hint: string;
  href: string;
  cta: string;
}

const STEPS: Step[] = [
  {
    id: 'marca',
    label: 'Configure sua marca',
    hint: 'Nome da empresa + logo aparecem no checkout dos seus clientes.',
    href: '/configuracoes/marca',
    cta: 'Configurar marca',
  },
  {
    id: 'gateway',
    label: 'Conecte o Mercado Pago',
    hint: 'Cole suas chaves pra receber Pix, cartão e boleto.',
    href: '/integrations/gateways',
    cta: 'Conectar gateway',
  },
  {
    id: 'whatsapp',
    label: 'Conecte seu WhatsApp',
    hint: 'Sessão dedicada pra disparar confirmação + recuperação.',
    href: '/integrations/whatsapp',
    cta: 'Escanear QR',
  },
  {
    id: 'produto',
    label: 'Crie seu primeiro produto',
    hint: 'Cadastre o produto pra gerar o link público de checkout.',
    href: '/produtos/novo',
    cta: 'Criar produto',
  },
  {
    id: 'publicar',
    label: 'Publique e compartilhe',
    hint: 'Copie o link do produto e envie no WhatsApp, anúncio ou bio.',
    href: '/produtos',
    cta: 'Ver produtos',
  },
  {
    id: 'primeiraVenda',
    label: 'Receba sua primeira venda',
    hint: 'A primeira compra desbloqueia a tela completa do dashboard.',
    href: '/pedidos',
    cta: 'Ver pedidos',
  },
];

export function OnboardingFloating() {
  const utils = trpc.useUtils();
  const state = trpc.workspace.onboardingState.useQuery(undefined, {
    // Re-check when the tab regains focus — typical pattern is "open
    // gateway page, paste keys, switch back". We want the chip to flip
    // immediately, not on the next manual refresh.
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const act = trpc.workspace.onboardingAction.useMutation({
    onSuccess: () => utils.workspace.onboardingState.invalidate(),
  });

  if (state.isPending || !state.data) return null;
  if (state.data.view === 'hidden') return null;

  if (state.data.view === 'minimized') {
    return (
      <button
        type="button"
        onClick={() => act.mutate({ action: 'restore' })}
        className="fixed right-5 bottom-5 z-40 inline-flex items-center gap-2 rounded-full border border-[var(--color-brand-500)] bg-[var(--color-surface)] py-2 pr-3 pl-2 text-left shadow-[0_8px_24px_-8px_rgba(22,163,74,0.35)] backdrop-blur transition hover:bg-[var(--color-brand-50)]"
        aria-label="Abrir guia de início"
      >
        <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white">
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <title>Onboarding</title>
            <path
              d="M2 9l4-6 4 4 4-3"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="6" cy="3" r="1.2" fill="currentColor" />
            <circle cx="10" cy="7" r="1.2" fill="currentColor" />
            <circle cx="14" cy="4" r="1.2" fill="currentColor" />
          </svg>
        </span>
        <span className="flex flex-col">
          <span className="font-semibold text-[11px] text-[var(--color-brand-700)] uppercase tracking-[0.14em]">
            Guia de início
          </span>
          <span className="font-medium text-[12px] text-[var(--color-fg)]">
            {state.data.completedCount}/{state.data.totalSteps} concluídos
          </span>
        </span>
      </button>
    );
  }

  // full
  const pct = (state.data.completedCount / state.data.totalSteps) * 100;
  return (
    <aside
      className="fixed right-5 bottom-5 z-40 flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_48px_-12px_rgba(0,0,0,0.25)]"
      aria-labelledby="onboarding-floating-title"
    >
      {/* Header — gradient dopamine + progress chip + close/minimize */}
      <header className="relative overflow-hidden border-[var(--color-border)] border-b bg-gradient-to-br from-[var(--color-brand-50)] to-transparent px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.16em]">
              Guia de início
            </p>
            <h2
              id="onboarding-floating-title"
              className="font-semibold text-[16px] text-[var(--color-fg)] leading-tight"
            >
              Bora deixar tudo pronto.
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              label="Minimizar"
              onClick={() => act.mutate({ action: 'minimize' })}
              icon={
                <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                  <title>Minimizar</title>
                  <path
                    d="M3 11h10"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
            <IconButton
              label="Fechar permanentemente"
              onClick={() => {
                if (confirm('Fechar o guia? Você pode reabrir depois nas configurações.')) {
                  act.mutate({ action: 'dismiss' });
                }
              }}
              icon={
                <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                  <title>Fechar</title>
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
            {state.data.completedCount}/{state.data.totalSteps}
          </span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
            aria-hidden
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-700)] transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </header>

      {/* Steps — scrollable when count > 4 */}
      <ol className="max-h-[44vh] overflow-y-auto">
        {STEPS.map((step, idx) => {
          const done = state.data.steps[step.id];
          return (
            <li
              key={step.id}
              className="flex items-start gap-3 border-[var(--color-border)] border-b px-5 py-3 last:border-b-0"
            >
              <span
                className={
                  done
                    ? 'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-brand-500)] text-white'
                    : 'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-[var(--color-border)] font-semibold text-[10px] text-[var(--color-fg-subtle)]'
                }
                aria-hidden
              >
                {done ? (
                  <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                    <title>Concluído</title>
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  idx + 1
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p
                  className={
                    done
                      ? 'font-semibold text-[13px] text-[var(--color-fg-subtle)] line-through'
                      : 'font-semibold text-[13px] text-[var(--color-fg)]'
                  }
                >
                  {step.label}
                </p>
                {!done && (
                  <p className="text-[11px] text-[var(--color-fg-muted)] leading-[1.5]">
                    {step.hint}
                  </p>
                )}
                {!done && (
                  <Link
                    href={step.href}
                    className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-[var(--color-brand-500)] px-2.5 py-1 font-medium text-[11px] text-white transition hover:bg-[var(--color-brand-700)]"
                  >
                    {step.cta}
                    <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                      <title>Ir</title>
                      <path
                        d="M3 8h10M9 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-6 place-items-center rounded-md text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
    >
      {icon}
    </button>
  );
}
