'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOut, useSession } from '../lib/auth';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * Persistent left sidebar — Apple-style light-mode navigation panel.
 *
 * Visual language:
 *   - 280px fixed, surface white, hair-thin border-right.
 *   - Brand mark + product name top.
 *   - Section labels in tracked uppercase (Atalhos · Configurar · Integrações).
 *   - Active nav item: subtle gray surface + colored icon + brand-tinted text.
 *   - Inactive: muted text, icon in subtle tone, hover lift.
 *   - User panel at bottom with avatar bubble + email + Sair link.
 */

type NavGroup = {
  label: string;
  items: { href: string; label: string; icon: ReactNode }[];
};

const NAV: NavGroup[] = [
  {
    label: 'Atalhos',
    items: [
      { href: '/dashboard', label: 'Visão geral', icon: <IconHome /> },
      { href: '/produtos', label: 'Meus produtos', icon: <IconGrid /> },
      { href: '/pedidos', label: 'Pedidos', icon: <IconCard /> },
    ],
  },
  {
    label: 'Configurar',
    items: [
      { href: '/configuracoes', label: 'Configurações', icon: <IconGrid /> },
      { href: '/checkout', label: 'Meu checkout', icon: <IconCard /> },
      { href: '/carrinho', label: 'Recuperação', icon: <IconRefresh /> },
    ],
  },
  {
    label: 'Integrações',
    items: [
      { href: '/integrations/gateways', label: 'Pagamentos', icon: <IconCard /> },
      { href: '/integrations/whatsapp', label: 'WhatsApp', icon: <IconChat /> },
      { href: '/integrations/email', label: 'Email', icon: <IconMail /> },
    ],
  },
];

export function Sidebar() {
  const path = usePathname();
  const session = useSession();
  const router = useRouter();

  const userEmail = session.data?.user?.email ?? '';
  const userInitial = (session.data?.user?.name ?? userEmail).trim().charAt(0).toUpperCase() || '·';

  return (
    <aside className="sticky top-0 flex h-screen w-[280px] shrink-0 flex-col gap-7 border-[var(--color-border)] border-r bg-[var(--color-surface)] px-5 py-6">
      {/* Workspace switcher — replaces the static brand block now that
          producers have a real (and switchable) tenant. */}
      <WorkspaceSwitcher />

      {/* Sections */}
      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto">
        {NAV.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <p className="px-3 pb-1 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active = path === item.href || path?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    'group flex items-center gap-3 rounded-xl px-3 py-2 font-medium text-[14px] transition',
                    active
                      ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
                  )}
                >
                  <span
                    className={clsx(
                      'flex size-5 items-center justify-center transition',
                      active
                        ? 'text-[var(--color-brand-600)]'
                        : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]',
                    )}
                  >
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User panel */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-surface-muted)] font-semibold text-[13px] text-[var(--color-fg)]">
            {userInitial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-[13px] text-[var(--color-fg)]">
              {session.data?.user?.name ?? userEmail.split('@')[0] ?? '—'}
            </p>
            <p className="truncate text-[11px] text-[var(--color-fg-subtle)]">{userEmail}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.push('/login');
          }}
          className="mt-3 w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
        >
          Sair
        </button>
      </div>

      {/* Product wordmark — moved out of the brand mark so the workspace
          name owns the top-left. Keeps the payunivercart attribution
          visible without competing with the producer's tenant name. */}
      <p className="px-1 text-center font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.18em]">
        payunivercart
      </p>
    </aside>
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
function IconGrid() {
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
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" />
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
