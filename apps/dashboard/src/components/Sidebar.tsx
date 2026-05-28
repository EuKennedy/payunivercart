'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { signOut, useSession } from '../lib/auth';
import { trpc } from '../lib/trpc';
import { MpAccountSwitcher } from './MpAccountSwitcher';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * Persistent left sidebar — Linear/Vercel-tier navigation panel.
 *
 * Build notes from this redesign pass:
 *   - 288px fixed (was 280) — gives the nav rows breathing room.
 *   - Sticky header section (workspace + MP switcher) gets a subtle
 *     bottom hairline + backdrop blur so scrolled nav slides under it
 *     cleanly without a hard divider.
 *   - Per-route distinct icons (no more reusing IconGrid for 5 things).
 *   - Active item: layoutId sliding pill (Linear pattern) + brand-tinted
 *     icon + 2px left accent bar for instant recognition.
 *   - Section dividers replaced with kerned labels + 1px hairline.
 *   - User panel collapsible — expanded shows email + sign out, idle
 *     state is a compact chip so the nav owns most of the visual weight.
 *   - "Pronto pra produção" chip surfaces the onboarding production
 *     count when > 0 — pulls the producer's eye toward the next move.
 */

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: 'new' | 'count';
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV: NavGroup[] = [
  {
    label: 'Visão',
    items: [
      { href: '/dashboard', label: 'Visão geral', icon: <IconHome /> },
      { href: '/pedidos', label: 'Pedidos', icon: <IconReceipt /> },
      { href: '/assinaturas', label: 'Assinaturas', icon: <IconRefresh /> },
      { href: '/clientes', label: 'Clientes', icon: <IconUsers /> },
    ],
  },
  {
    label: 'Catálogo',
    items: [
      { href: '/produtos', label: 'Meus produtos', icon: <IconBox /> },
      { href: '/marketplace', label: 'Meu Marketplace', icon: <IconStorefront /> },
      {
        href: '/afiliar',
        label: 'Afiliar a um produto',
        icon: <IconStorefront />,
        badge: 'new',
      },
      { href: '/afiliado', label: 'Sou afiliado', icon: <IconUsers /> },
    ],
  },
  {
    label: 'Configurar',
    items: [
      { href: '/configuracoes', label: 'Configurações', icon: <IconSliders /> },
      { href: '/checkout', label: 'Meu checkout', icon: <IconCart /> },
      { href: '/carrinho', label: 'Recuperação', icon: <IconRecover /> },
    ],
  },
  {
    label: 'Integrações',
    items: [
      { href: '/integrations/gateways', label: 'Pagamentos', icon: <IconCard /> },
      { href: '/integrations/whatsapp', label: 'WhatsApp', icon: <IconChat /> },
      { href: '/integrations/email', label: 'Email', icon: <IconMail /> },
      { href: '/integrations/pixels', label: 'Configurar Pixel', icon: <IconBolt />, badge: 'new' },
      { href: '/integrations/webhooks', label: 'Webhooks', icon: <IconWebhook /> },
    ],
  },
];

const COLLAPSED_KEY = 'payunivercart.sidebar.collapsed';

export function Sidebar() {
  const path = usePathname();
  const session = useSession();
  const router = useRouter();
  const onboarding = trpc.workspace.onboardingState.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const [userPanelOpen, setUserPanelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Hydration: read the persisted preference once mounted. SSR
  // renders expanded by default — flipping after mount avoids
  // hydration-mismatch warnings (window doesn't exist on server).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch {
      /* private mode / SSR */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* noop */
      }
      // Collapsing while the user panel is expanded leaves a phantom
      // open state when the sidebar comes back — close it pre-emptively.
      if (next) setUserPanelOpen(false);
      return next;
    });
  };

  const userEmail = session.data?.user?.email ?? '';
  const userInitial = (session.data?.user?.name ?? userEmail).trim().charAt(0).toUpperCase() || '·';

  const prodCount = onboarding.data?.productionCompletedCount ?? 0;
  const prodTotal = onboarding.data?.productionTotalSteps ?? 0;
  const showProdChip = onboarding.data?.completedAt && prodTotal > 0 && prodCount < prodTotal;

  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 288 }}
      transition={{ type: 'spring', stiffness: 340, damping: 32 }}
      className="sticky top-0 flex h-screen shrink-0 flex-col overflow-hidden border-[var(--color-border)] border-r bg-[var(--color-surface)]"
    >
      {/* HEADER — sticky brand + workspace + MP switcher */}
      <header
        className={
          collapsed
            ? 'sticky top-0 z-10 flex flex-col items-center gap-2 border-[var(--color-border)] border-b bg-[var(--color-surface)]/95 px-2 py-3 backdrop-blur-xl'
            : 'sticky top-0 z-10 flex flex-col gap-2.5 border-[var(--color-border)] border-b bg-[var(--color-surface)]/95 px-4 py-4 backdrop-blur-xl'
        }
      >
        {collapsed ? (
          <>
            <Link
              href="/dashboard"
              className="grid size-10 cursor-pointer place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-bold text-[16px] text-white shadow-sm"
              aria-label="Visão geral"
            >
              P
            </Link>
            <NotificationBell />
          </>
        ) : (
          <>
            <div className="flex items-stretch gap-2">
              <div className="flex-1">
                <WorkspaceSwitcher />
              </div>
              <NotificationBell />
            </div>
            <MpAccountSwitcher />
          </>
        )}
      </header>

      {/* NAV — scrollable */}
      <nav
        className={
          collapsed
            ? 'flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-4'
            : 'flex flex-1 flex-col gap-7 overflow-y-auto px-3 py-5'
        }
      >
        {NAV.map((group, groupIdx) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            {collapsed ? (
              // Group divider — thin hairline so the user still has
              // visual grouping cues in icon-only mode.
              groupIdx > 0 ? (
                <span aria-hidden className="mx-3 mb-2 h-px bg-[var(--color-border)]" />
              ) : null
            ) : (
              <p className="mb-1.5 px-2.5 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const active = path === item.href || path?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={clsx(
                    'group relative flex cursor-pointer items-center gap-3 rounded-xl font-medium text-[14px] transition',
                    collapsed ? 'h-10 justify-center px-0' : 'px-2.5 py-2',
                    active
                      ? 'text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]/60 hover:text-[var(--color-fg)]',
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="sidebar-active-pill"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      className="absolute inset-0 rounded-xl bg-gradient-to-r from-[var(--color-brand-50)]/40 via-[var(--color-surface-muted)] to-[var(--color-surface-muted)] ring-1 ring-[var(--color-brand-500)]/15"
                      aria-hidden
                    />
                  ) : null}
                  {active && !collapsed ? (
                    <motion.span
                      layoutId="sidebar-active-accent"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      className="-translate-y-1/2 absolute top-1/2 left-0 h-5 w-[3px] rounded-r-full bg-gradient-to-b from-[var(--color-brand-500)] to-[var(--color-brand-700)]"
                      aria-hidden
                    />
                  ) : null}
                  <span
                    className={clsx(
                      'relative flex size-5 items-center justify-center transition',
                      active
                        ? 'text-[var(--color-brand-600)]'
                        : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]',
                    )}
                  >
                    {item.icon}
                  </span>
                  {!collapsed ? (
                    <>
                      <span className="relative flex-1 truncate">{item.label}</span>
                      {item.badge === 'new' ? (
                        <span className="relative rounded-full bg-[var(--color-brand-50)] px-1.5 py-0.5 font-semibold text-[9px] text-[var(--color-brand-700)] uppercase tracking-wider">
                          Novo
                        </span>
                      ) : null}
                    </>
                  ) : item.badge === 'new' ? (
                    // Collapsed badge: tiny dot in the top-right of the
                    // icon so producer doesn't miss new features.
                    <span
                      aria-hidden
                      className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-brand-500)]"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}

        {/* Pronto pra produção chip — appears once setup is done and
            production checklist isn't fully checked. Click dispatches
            a CustomEvent that OnboardingFloating listens for; the
            widget opens directly on the production tab so producer
            sees exactly what's missing without hunting. Hidden in
            collapsed mode (no room for inline progress bar). */}
        {showProdChip && !collapsed ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('onboarding:open-production'));
              }
            }}
            className="mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer flex-col gap-2 rounded-xl border border-[var(--color-brand-500)]/30 bg-gradient-to-br from-[var(--color-brand-50)]/60 via-[var(--color-surface)] to-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-500)]/60 hover:shadow-[0_8px_20px_-12px_rgba(22,163,74,0.35)]"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="grid size-5 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white"
              >
                <svg viewBox="0 0 12 12" fill="none" className="size-3">
                  <title>Pronto</title>
                  <path
                    d="M3 6.5l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="flex-1 font-semibold text-[11px] text-[var(--color-brand-700)] uppercase tracking-[0.12em]">
                Pronto pra produção
              </span>
              <span aria-hidden className="text-[var(--color-brand-700)]">
                →
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                {prodCount}/{prodTotal}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-700)]"
                  initial={false}
                  animate={{ width: `${(prodCount / prodTotal) * 100}%` }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
            </div>
            <span className="text-[10px] text-[var(--color-fg-subtle)] leading-[1.4]">
              Clique pra ver o que falta resolver
            </span>
          </motion.button>
        ) : null}
      </nav>

      {/* FOOTER — user chip + collapse toggle + theme + wordmark */}
      <footer
        className={
          collapsed
            ? 'flex flex-col items-center gap-3 border-[var(--color-border)] border-t bg-[var(--color-surface)]/95 px-2 py-3 backdrop-blur-xl'
            : 'flex flex-col gap-3 border-[var(--color-border)] border-t bg-[var(--color-surface)]/95 px-4 py-4 backdrop-blur-xl'
        }
      >
        {collapsed ? (
          <button
            type="button"
            onClick={async () => {
              await signOut();
              router.push('/login');
            }}
            title={`${session.data?.user?.name ?? userEmail.split('@')[0] ?? '—'} · Sair`}
            aria-label="Sair"
            className="grid size-10 cursor-pointer place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-semibold text-[13px] text-white shadow-sm transition hover:brightness-110"
          >
            {userInitial}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setUserPanelOpen((v) => !v)}
              aria-expanded={userPanelOpen}
              className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition hover:bg-[var(--color-surface-muted)]"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-semibold text-[13px] text-white shadow-sm">
                {userInitial}
              </span>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate font-semibold text-[13px] text-[var(--color-fg)]">
                  {session.data?.user?.name ?? userEmail.split('@')[0] ?? '—'}
                </p>
                <p className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                  {userEmail || 'Carregando…'}
                </p>
              </div>
              <motion.span
                animate={{ rotate: userPanelOpen ? 180 : 0 }}
                transition={{ duration: 0.2 }}
                className="text-[var(--color-fg-subtle)]"
                aria-hidden
              >
                <svg viewBox="0 0 12 12" fill="none" className="size-3">
                  <title>Expandir</title>
                  <path
                    d="M3 4.5L6 7.5L9 4.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {userPanelOpen ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-2 pt-1">
                    <Link
                      href="/configuracoes/empresa"
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                    >
                      <IconSliders />
                      Conta
                    </Link>
                    <button
                      type="button"
                      onClick={async () => {
                        await signOut();
                        router.push('/login');
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
                    >
                      <IconLogout />
                      Sair
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </>
        )}

        {/* Collapse toggle — always visible. Chevron icon flips based
            on state. Title attribute provides discoverability. */}
        <div
          className={
            collapsed
              ? 'flex w-full flex-col items-center gap-2 border-[var(--color-border)] border-t pt-3'
              : 'flex items-center justify-between gap-3 border-[var(--color-border)] border-t pt-3'
          }
        >
          {!collapsed ? <ThemeToggle /> : null}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expandir sidebar' : 'Recolher sidebar'}
            aria-label={collapsed ? 'Expandir sidebar' : 'Recolher sidebar'}
            className="grid size-7 cursor-pointer place-items-center rounded-lg text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
          >
            <motion.svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="size-3.5"
              animate={{ rotate: collapsed ? 180 : 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden
            >
              <title>Toggle sidebar</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 4L6 8l4 4" />
            </motion.svg>
          </button>
          {!collapsed ? (
            <img
              src="/payunivercart-logo.png"
              alt="payunivercart"
              className="h-4 w-auto opacity-60"
            />
          ) : null}
        </div>
      </footer>
    </motion.aside>
  );
}

// =============================================================================
// Icons — inline SVG, no external dep. 20×20 viewBox, 1.6px stroke.
// =============================================================================

function IconHome() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 9l7-6 7 6v8a1 1 0 01-1 1h-4v-6H8v6H4a1 1 0 01-1-1V9z"
      />
    </svg>
  );
}
function IconReceipt() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 2.5h10v15l-2.5-1.5L10 17l-2.5-1.5L5 17V2.5z"
      />
      <path strokeLinecap="round" d="M7.5 7h5M7.5 10h5M7.5 13h3" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 10a7 7 0 0112-4.9L17 7M17 3v4h-4M17 10a7 7 0 01-12 4.9L3 13M3 17v-4h4"
      />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <circle cx="7" cy="7" r="3" />
      <path strokeLinecap="round" d="M2 17a5 5 0 0110 0" />
      <circle cx="14" cy="8" r="2.4" />
      <path strokeLinecap="round" d="M12 17a4 4 0 016 0" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinejoin="round" d="M10 2.5L17 6v8l-7 3.5L3 14V6l7-3.5z" />
      <path strokeLinecap="round" d="M3 6l7 3.5L17 6M10 9.5v8" />
    </svg>
  );
}
function IconStorefront() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3.5h14l-1 4a2.5 2.5 0 01-5 0 2.5 2.5 0 01-5 0L4 3.5z"
      />
      <path strokeLinecap="round" d="M4 8.5V17h12V8.5" />
      <path strokeLinecap="round" d="M8 17v-5h4v5" />
    </svg>
  );
}
function IconSliders() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinecap="round" d="M3 6h6M13 6h4M3 14h4M11 14h6" />
      <circle cx="11" cy="6" r="2" />
      <circle cx="9" cy="14" r="2" />
    </svg>
  );
}
function IconCart() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 3h2l1.5 9h9l1.5-6h-11" />
      <circle cx="7" cy="16" r="1.4" />
      <circle cx="14" cy="16" r="1.4" />
    </svg>
  );
}
function IconRecover() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4h8a4 4 0 014 4v3a4 4 0 01-4 4H7l-3 2.5V4z"
      />
      <path strokeLinecap="round" d="M7 9h6M7 12h4" />
    </svg>
  );
}
function IconCard() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <rect x="2.5" y="5" width="15" height="10" rx="2" />
      <path strokeLinecap="round" d="M2.5 8.5h15M5.5 12.5h3" />
    </svg>
  );
}
function IconChat() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 8a5 5 0 015-5h4a5 5 0 015 5v2a5 5 0 01-5 5H8l-4 3v-3a5 5 0 01-1-2V8z"
      />
    </svg>
  );
}
function IconMail() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6l7 5 7-5" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 2l-7 10h5l-1 6 7-10h-5l1-6z" />
    </svg>
  );
}
function IconWebhook() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13a3 3 0 1 0 3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 1 1-3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6a3 3 0 1 1 2.5 4.5L10 16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16h7" />
    </svg>
  );
}
function IconLogout() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-4"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3h4a1 1 0 011 1v12a1 1 0 01-1 1h-4M13 10H3m0 0l3-3m-3 3l3 3"
      />
    </svg>
  );
}
