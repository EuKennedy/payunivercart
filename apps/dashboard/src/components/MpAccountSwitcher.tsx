'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';

/**
 * Mercado Pago account switcher — sidebar chip below the workspace
 * picker. Shows the producer which credential is currently charging
 * buyers + lets them swap between connected accounts (e.g. sandbox →
 * production, or store A → store B) in a single click without leaving
 * the page they're on.
 *
 * Why surface this here rather than only in /integrations/gateways:
 *   - Producers with multiple stores rotate the "active" account often.
 *   - Mixing up sandbox and production in the gateway page costs real
 *     money — having the active flag in the sidebar at all times keeps
 *     the producer constantly aware of which environment is live.
 *   - Mirrors what Stripe Dashboard does with the env switcher in the
 *     top-left brand block (test mode vs live mode).
 *
 * Empty state: when no MP credential exists we render a "Conectar" CTA
 * that deep-links into the gateways page. Single-account state: render
 * static chip (no dropdown). Multi-account: dropdown with each row
 * pickable.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export function MpAccountSwitcher() {
  const utils = trpc.useUtils();
  const list = trpc.gateways.list.useQuery(undefined, { staleTime: 30_000 });
  const setDefault = trpc.gateways.setDefault.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  if (list.isPending || !list.data) {
    return (
      <div className="flex h-[44px] items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5">
        <span className="size-7 animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />
        <span className="h-3 flex-1 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      </div>
    );
  }

  const mpAccounts = list.data.filter((g) => g.gatewayId === 'mercadopago');

  if (mpAccounts.length === 0) {
    return (
      <Link
        href="/integrations/gateways"
        className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-2.5 py-2 transition hover:border-[var(--color-brand-500)] hover:bg-[var(--color-brand-50)]"
      >
        <span className="grid size-7 place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]">
          <PlusIcon />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Mercado Pago
          </span>
          <span className="font-medium text-[12px] text-[var(--color-fg-muted)]">Conectar</span>
        </div>
      </Link>
    );
  }

  const active = mpAccounts.find((a) => a.isDefault) ?? mpAccounts[0];
  if (!active) return null;
  const multi = mpAccounts.length > 1;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => multi && setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup={multi ? 'listbox' : undefined}
        disabled={!multi}
        className={
          multi
            ? 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 transition hover:border-[var(--color-brand-500)]/60 hover:bg-[var(--color-surface-muted)]'
            : 'flex w-full items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2'
        }
      >
        <EnvBadge isSandbox={active.isSandbox} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            MP {active.isSandbox ? 'Sandbox' : 'Produção'}
          </span>
          <span className="truncate font-medium text-[12px] text-[var(--color-fg)]">
            {active.label}
          </span>
        </div>
        {multi ? (
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="text-[var(--color-fg-subtle)]"
            aria-hidden
          >
            <ChevronDown />
          </motion.span>
        ) : null}
      </button>

      <AnimatePresence>
        {open && multi ? (
          // biome-ignore lint/a11y/useSemanticElements: custom dropdown — not a native select; uses listbox semantics for keyboard a11y.
          <motion.ul
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute top-full right-0 left-0 z-30 mt-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.28)]"
          >
            {mpAccounts.map((acc) => (
              <li key={acc.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!acc.isDefault) {
                      setDefault.mutate({ id: acc.id });
                    }
                    setOpen(false);
                  }}
                  disabled={setDefault.isPending}
                  className={
                    acc.isDefault
                      ? 'flex w-full cursor-default items-center gap-2.5 bg-[var(--color-brand-50)]/60 px-3 py-2 text-left transition'
                      : 'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--color-surface-muted)]'
                  }
                >
                  <EnvBadge isSandbox={acc.isSandbox} />
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-semibold text-[12px] text-[var(--color-fg)]">
                      {acc.label}
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                      {acc.isSandbox ? 'Sandbox' : 'Produção'}
                    </span>
                  </div>
                  {acc.isDefault ? (
                    <span className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-wider">
                      ★ Ativa
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            <li className="border-[var(--color-border)] border-t">
              <Link
                href="/integrations/gateways"
                onClick={() => setOpen(false)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
              >
                <span className="grid size-5 place-items-center rounded-md border border-[var(--color-border)] border-dashed text-[10px] leading-none">
                  +
                </span>
                Gerenciar contas
              </Link>
            </li>
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function EnvBadge({ isSandbox }: { isSandbox: boolean }) {
  return (
    <span
      aria-hidden
      className={
        isSandbox
          ? 'grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--color-warning-bg)] font-bold text-[10px] text-[var(--color-warning)] uppercase'
          : 'grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-bold text-[10px] text-white uppercase shadow-sm'
      }
    >
      {isSandbox ? 'SBX' : 'PRO'}
    </span>
  );
}

function ChevronDown() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-3.5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="size-3.5"
    >
      <path strokeLinecap="round" d="M8 3v10M3 8h10" />
    </svg>
  );
}
