'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut, useSession } from '../lib/auth.js';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '◧' },
  { href: '/produtos', label: 'Meus Produtos', icon: '◍' },
  { href: '/checkout', label: 'Meu Checkout', icon: '◐' },
  { href: '/carrinho', label: 'Carrinho Abandonado', icon: '⟲' },
  { href: '/integrations/whatsapp', label: 'WhatsApp', icon: '✦' },
  { href: '/integrations/email', label: 'Email', icon: '✉' },
] as const;

/**
 * Persistent left sidebar — Apple-style frosted panel, fixed, single
 * column. Matches the "side to side" layout the founder requested.
 */
export function Sidebar() {
  const path = usePathname();
  const session = useSession();
  const router = useRouter();

  return (
    <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col gap-6 border-r border-[var(--color-border)] bg-[var(--color-surface-1)]/60 p-6 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand-400)] to-[var(--color-brand-700)] text-black font-bold">
          P
        </span>
        <span className="text-base font-semibold tracking-tight">payunivercart</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((item) => {
          const active = path === item.href || path?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition',
                active
                  ? 'bg-white/[0.06] text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-white/[0.03] hover:text-[var(--color-fg)]',
              )}
            >
              <span className="w-5 text-center text-[var(--color-brand-400)]">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--color-border)] pt-4">
        <div className="mb-3 text-xs text-[var(--color-fg-subtle)]">
          {session.data?.user?.email ?? '—'}
        </div>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.push('/login');
          }}
          className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Sair
        </button>
      </div>
    </aside>
  );
}
