'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { trpc } from '../lib/trpc';

/**
 * Floating onboarding companion. Sits bottom-right on every authenticated
 * screen and follows the producer between pages. ClickUp/Linear-style.
 *
 * Three view states (server-persisted via `workspace.onboardingAction`):
 *   - `full`      → expanded panel with checklist + production tab
 *   - `minimized` → pill chip with X/Y progress
 *   - `hidden`    → not rendered (completed / dismissed)
 *
 * Two tabs inside the full panel:
 *   - "Configuração" — the six baseline steps the producer needs before
 *     the system functions at all.
 *   - "Pronto pra produção" — the last-mile readiness checklist that
 *     unlocks once the basics are done. Producers can ignore it on a
 *     sandbox / staging account, but every box here matters before
 *     accepting real money from real buyers.
 *
 * Each step is expandable inline so the producer can drill into the
 * step-by-step instructions without leaving the widget. Substeps stay
 * compact because the widget itself is the journey — verbose docs
 * defeat the point.
 *
 * Motion: framer-motion handles entry, tab swap, step expand/collapse
 * with our `easeOutExpo` curve so it never feels mechanical.
 */

type StepId = 'marca' | 'gateway' | 'whatsapp' | 'produto' | 'publicar' | 'primeiraVenda';

interface Step {
  id: StepId;
  label: string;
  hint: string;
  href: string;
  cta: string;
  substeps: string[];
}

const STEPS: Step[] = [
  {
    id: 'marca',
    label: 'Configure sua marca',
    hint: 'Nome da empresa + logo aparecem no checkout dos seus clientes.',
    href: '/configuracoes/marca',
    cta: 'Configurar marca',
    substeps: [
      'Abra Configurações → Marca.',
      'Coloque o nome da empresa que vai aparecer no recibo do MP.',
      'Faça upload do logo em PNG, JPEG ou WEBP (até 2 MB).',
      'Escolha a cor primária — usada no botão de pagar do checkout.',
    ],
  },
  {
    id: 'gateway',
    label: 'Conecte o Mercado Pago',
    hint: 'Cole suas chaves pra receber Pix, cartão e boleto.',
    href: '/integrations/gateways',
    cta: 'Conectar gateway',
    substeps: [
      'Crie uma aplicação em mercadopago.com.br/developers.',
      'Copie a Public Key (começa com APP_USR-… ou TEST-…).',
      'Copie o Access Token correspondente.',
      'Cole no formulário e clique "Salvar e validar" — testamos antes de salvar.',
    ],
  },
  {
    id: 'whatsapp',
    label: 'Conecte seu WhatsApp',
    hint: 'Sessão dedicada pra disparar confirmação + recuperação de carrinho.',
    href: '/integrations/whatsapp',
    cta: 'Escanear QR',
    substeps: [
      'Use um número exclusivo da empresa (não o seu pessoal).',
      'Escaneie o QR code com o WhatsApp Business no celular.',
      'Aguarde o status virar "WORKING" (verde) — leva ~10 s.',
      'Pronto: mensagens transacionais saem automaticamente.',
    ],
  },
  {
    id: 'produto',
    label: 'Crie seu primeiro produto',
    hint: 'Cadastre o produto pra gerar o link público de checkout.',
    href: '/produtos/novo',
    cta: 'Criar produto',
    substeps: [
      'Escolha entre Compra única ou Assinatura recorrente.',
      'Defina nome, preço em reais e parcelamento permitido.',
      'Cole a URL de entrega (vídeo, área de membros, download).',
      'Salve — o link público aparece na listagem.',
    ],
  },
  {
    id: 'publicar',
    label: 'Publique e compartilhe',
    hint: 'Copie o link do produto e envie no WhatsApp, anúncio ou bio.',
    href: '/produtos',
    cta: 'Ver produtos',
    substeps: [
      'Na listagem, clique no ícone de copiar do link público.',
      'Cole no WhatsApp, instagram, anúncio ou e-mail.',
      'O comprador chega no checkout já com sua marca aplicada.',
    ],
  },
  {
    id: 'primeiraVenda',
    label: 'Receba sua primeira venda',
    hint: 'A primeira compra desbloqueia o dashboard completo.',
    href: '/pedidos',
    cta: 'Ver pedidos',
    substeps: [
      'Compartilhe o link em um canal real ou rode um teste em sandbox.',
      'O pedido aparece em tempo real em /pedidos.',
      'O comprador recebe e-mail + WhatsApp automaticamente.',
    ],
  },
];

interface ProductionItem {
  id:
    | 'gatewayProduction'
    | 'producerNotifyPhone'
    | 'waProductionReady'
    | 'brandComplete'
    | 'testPurchase';
  label: string;
  why: string;
  href: string;
  cta: string;
}

const PRODUCTION: ProductionItem[] = [
  {
    id: 'gatewayProduction',
    label: 'Chaves de produção do Mercado Pago',
    why: 'Sandbox não move dinheiro real. Antes de divulgar o link, troque a credencial pra Access Token de produção (começa com APP_USR-).',
    href: '/integrations/gateways',
    cta: 'Trocar pra produção',
  },
  {
    id: 'brandComplete',
    label: 'Marca completa (logo + nome)',
    why: 'Checkout sem logo passa desconfiança. Comprador precisa enxergar sua marca antes de digitar o cartão.',
    href: '/configuracoes/marca',
    cta: 'Completar marca',
  },
  {
    id: 'waProductionReady',
    label: 'WhatsApp online em sessão estável',
    why: 'Se a sessão cair durante o pico de vendas, recuperação de carrinho não dispara. Confirme o status WORKING uma vez por semana.',
    href: '/integrations/whatsapp',
    cta: 'Conferir sessão',
  },
  {
    id: 'producerNotifyPhone',
    label: 'Seu número pra alertas de venda',
    why: 'A cada pedido pago você recebe um zap. Sem isso você só descobre vendas abrindo o painel.',
    href: '/configuracoes/empresa',
    cta: 'Cadastrar número',
  },
  {
    id: 'testPurchase',
    label: 'Compra de teste validada',
    why: 'Rode UMA compra real (R$ 1 no Pix por exemplo) pra confirmar que dinheiro chega, e-mail dispara e WhatsApp manda link de entrega.',
    href: '/produtos',
    cta: 'Rodar teste',
  },
];

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export function OnboardingFloating() {
  const utils = trpc.useUtils();
  const state = trpc.workspace.onboardingState.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const act = trpc.workspace.onboardingAction.useMutation({
    onSuccess: () => utils.workspace.onboardingState.invalidate(),
  });

  const [activeTab, setActiveTab] = useState<'setup' | 'production'>('setup');
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  // External "open with production tab" trigger. The sidebar's
  // "Pronto pra produção" chip dispatches this CustomEvent on click so
  // the producer lands directly on the production checklist instead of
  // hunting through the default setup tab.
  useEffect(() => {
    const handler = () => {
      setActiveTab('production');
      // If the widget is minimised/dismissed, restore it so the panel
      // is visible after the tab switch.
      if (state.data?.view !== 'full') {
        act.mutate({ action: 'restore' });
      }
    };
    if (typeof window === 'undefined') return;
    window.addEventListener('onboarding:open-production', handler);
    return () => window.removeEventListener('onboarding:open-production', handler);
  }, [state.data?.view, act]);

  if (state.isPending || !state.data) return null;
  if (state.data.view === 'hidden') return null;

  if (state.data.view === 'minimized') {
    const pct = Math.round((state.data.completedCount / state.data.totalSteps) * 100);
    return (
      <motion.button
        type="button"
        onClick={() => act.mutate({ action: 'restore' })}
        className="fixed right-5 bottom-5 z-40 inline-flex cursor-pointer items-center gap-3 rounded-full border border-[var(--color-brand-500)] bg-[var(--color-surface)] py-2 pr-4 pl-2 text-left shadow-[0_12px_32px_-12px_rgba(22,163,74,0.4)] backdrop-blur transition hover:bg-[var(--color-brand-50)]"
        aria-label="Abrir guia de início"
        initial={{ opacity: 0, scale: 0.85, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.85, y: 12 }}
        transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
      >
        <RingProgress pct={pct} />
        <span className="flex flex-col">
          <span className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.16em]">
            Guia de início
          </span>
          <span className="font-medium text-[12px] text-[var(--color-fg)]">
            {state.data.completedCount}/{state.data.totalSteps} concluídos
          </span>
        </span>
      </motion.button>
    );
  }

  const setupPct = (state.data.completedCount / state.data.totalSteps) * 100;
  const prodPct = (state.data.productionCompletedCount / state.data.productionTotalSteps) * 100;
  const setupDone = state.data.completedCount === state.data.totalSteps;

  return (
    <AnimatePresence>
      <motion.aside
        key="onboarding-floating"
        className="fixed right-5 bottom-5 z-40 flex w-[420px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_56px_-16px_rgba(0,0,0,0.32)]"
        aria-labelledby="onboarding-floating-title"
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.96 }}
        transition={{ duration: 0.32, ease: EASE_OUT_EXPO }}
      >
        {/* Header */}
        <header className="relative overflow-hidden border-[var(--color-border)] border-b bg-gradient-to-br from-[var(--color-brand-50)] via-[var(--color-surface)] to-transparent px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.16em]">
                Guia de início
              </p>
              <h2
                id="onboarding-floating-title"
                className="font-semibold text-[17px] text-[var(--color-fg)] leading-tight"
              >
                {setupDone ? 'Hora de subir pra produção.' : 'Bora deixar tudo pronto.'}
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

          {/* Tabs */}
          <div
            role="tablist"
            aria-label="Etapas do onboarding"
            className="mt-5 inline-flex w-full rounded-xl bg-[var(--color-surface-muted)] p-1"
          >
            <TabButton
              active={activeTab === 'setup'}
              onClick={() => setActiveTab('setup')}
              label={`Configuração · ${state.data.completedCount}/${state.data.totalSteps}`}
            />
            <TabButton
              active={activeTab === 'production'}
              onClick={() => setActiveTab('production')}
              label={`Produção · ${state.data.productionCompletedCount}/${state.data.productionTotalSteps}`}
            />
          </div>

          {/* Progress bar */}
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-700)]"
              initial={false}
              animate={{ width: `${activeTab === 'setup' ? setupPct : prodPct}%` }}
              transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
            />
          </div>
        </header>

        {/* Body */}
        <div className="max-h-[52vh] overflow-y-auto">
          <AnimatePresence mode="wait">
            {activeTab === 'setup' ? (
              <motion.ol
                key="setup"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.22, ease: EASE_OUT_EXPO }}
              >
                {STEPS.map((step, idx) => {
                  const done = state.data?.steps[step.id] === true;
                  const expanded = expandedStep === step.id;
                  return (
                    <StepRow
                      key={step.id}
                      done={done}
                      index={idx + 1}
                      label={step.label}
                      hint={step.hint}
                      href={step.href}
                      cta={step.cta}
                      substeps={step.substeps}
                      expanded={expanded}
                      onToggle={() => setExpandedStep(expanded ? null : step.id)}
                    />
                  );
                })}
              </motion.ol>
            ) : (
              <motion.ol
                key="production"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.22, ease: EASE_OUT_EXPO }}
              >
                {!setupDone && (
                  <li className="mx-5 mt-4 mb-2 flex items-start gap-2 rounded-xl border border-[var(--color-warning-bg)] bg-[var(--color-warning-bg)]/60 px-3 py-2.5">
                    <span aria-hidden className="mt-0.5 text-[14px]">
                      ⚠
                    </span>
                    <p className="text-[12px] text-[var(--color-warning)] leading-[1.5]">
                      Termine a aba "Configuração" antes de virar a chave de produção — esses itens
                      dependem dela.
                    </p>
                  </li>
                )}
                {PRODUCTION.map((item, idx) => {
                  const done = state.data?.production[item.id] === true;
                  const expanded = expandedStep === `prod-${item.id}`;
                  return (
                    <StepRow
                      key={item.id}
                      done={done}
                      index={idx + 1}
                      label={item.label}
                      hint={item.why}
                      href={item.href}
                      cta={item.cta}
                      substeps={[item.why]}
                      expanded={expanded}
                      onToggle={() => setExpandedStep(expanded ? null : `prod-${item.id}`)}
                    />
                  );
                })}
              </motion.ol>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <footer className="border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]/50 px-5 py-3">
          <p className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.5]">
            {activeTab === 'setup'
              ? 'Cada etapa libera funcionalidades. O guia some quando você termina.'
              : 'Esses itens são opcionais em sandbox, obrigatórios antes de divulgar pra clientes reais.'}
          </p>
        </footer>
      </motion.aside>
    </AnimatePresence>
  );
}

function StepRow({
  done,
  index,
  label,
  hint,
  href,
  cta,
  substeps,
  expanded,
  onToggle,
}: {
  done: boolean;
  index: number;
  label: string;
  hint: string;
  href: string;
  cta: string;
  substeps: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-[var(--color-border)] border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-3 px-5 py-3 text-left transition hover:bg-[var(--color-surface-muted)]/40"
      >
        <span
          className={
            done
              ? 'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white shadow-sm'
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
            index
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
            {label}
          </p>
          {!done && (
            <p className="text-[11px] text-[var(--color-fg-muted)] leading-[1.5]">{hint}</p>
          )}
        </div>
        <motion.span
          className="mt-1 text-[var(--color-fg-subtle)]"
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
          aria-hidden
        >
          <svg viewBox="0 0 16 16" fill="none" className="size-3">
            <title>Expandir</title>
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: EASE_OUT_EXPO }}
            className="overflow-hidden"
          >
            <div className="border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]/40 px-5 py-3.5">
              {substeps.length > 1 ? (
                <ol className="flex flex-col gap-2">
                  {substeps.map((sub, i) => (
                    <li
                      key={`${i}-${sub.slice(0, 12)}`}
                      className="flex items-start gap-2 text-[12px] text-[var(--color-fg-muted)] leading-[1.5]"
                    >
                      <span className="mt-1 size-1 shrink-0 rounded-full bg-[var(--color-brand-500)]" />
                      {sub}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[12px] text-[var(--color-fg-muted)] leading-[1.5]">
                  {substeps[0]}
                </p>
              )}
              {!done && (
                <Link
                  href={href}
                  className="mt-3 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-3 py-1.5 font-semibold text-[12px] text-white shadow-sm transition hover:brightness-110"
                >
                  {cta}
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
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function RingProgress({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 14;
  const offset = c - (pct / 100) * c;
  return (
    <span className="relative grid size-9 place-items-center" aria-hidden>
      <svg viewBox="0 0 32 32" className="-rotate-90 absolute inset-0 size-full">
        <title>Progresso</title>
        <circle cx="16" cy="16" r="14" fill="none" stroke="var(--color-border)" strokeWidth="3" />
        <motion.circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke="url(#og-grad)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
        />
        <defs>
          <linearGradient id="og-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-500)" />
            <stop offset="100%" stopColor="var(--color-brand-700)" />
          </linearGradient>
        </defs>
      </svg>
      <span className="relative font-semibold text-[10px] text-[var(--color-brand-700)]">
        {pct}%
      </span>
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={
        active
          ? 'flex-1 cursor-pointer rounded-lg bg-[var(--color-surface)] px-3 py-1.5 font-semibold text-[11px] text-[var(--color-fg)] shadow-sm transition'
          : 'flex-1 cursor-pointer rounded-lg px-3 py-1.5 font-medium text-[11px] text-[var(--color-fg-subtle)] transition hover:text-[var(--color-fg)]'
      }
    >
      {label}
    </button>
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
      className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
    >
      {icon}
    </button>
  );
}
