'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCents } from '../lib/money';
import { trpc } from '../lib/trpc';

/**
 * Notification bell with dropdown panel. Mounted in the sidebar
 * header next to the workspace switcher.
 *
 * Data source: tRPC `notifications.feed` returns a unified list of
 * paid orders, subscription activations, subscription cancellations
 * and affiliate commission availability events.
 *
 * Unread badge math: producer-local. We persist
 * `localStorage.notifications.lastSeenAt` and count items above it.
 * Opening the panel marks ALL as seen (lastSeenAt = now). This is
 * intentionally lossless — items don't disappear, the dot just goes
 * away.
 *
 * No real-time push yet — refetchInterval 30s keeps the badge fresh
 * enough that a producer browsing the dashboard sees new sales
 * within half a minute.
 */

const LAST_SEEN_KEY = 'payunivercart.notifications.lastSeenAt';
const EASE = [0.16, 1, 0.3, 1] as const;

export function NotificationBell() {
  const feed = trpc.notifications.feed.useQuery(
    { limit: 30 },
    {
      staleTime: 15_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  );

  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Hydrate persisted lastSeen on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LAST_SEEN_KEY);
      setLastSeenAt(stored ? Number.parseInt(stored, 10) || 0 : 0);
    } catch {
      /* private mode */
    }
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const items = feed.data ?? [];
  const unreadCount = useMemo(
    () => items.filter((i) => new Date(i.occurredAt).getTime() > lastSeenAt).length,
    [items, lastSeenAt],
  );

  const handleOpen = () => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        // Mark all as seen the moment the panel opens. Lossless —
        // items stay rendered, only the badge resets.
        const now = Date.now();
        setLastSeenAt(now);
        try {
          localStorage.setItem(LAST_SEEN_KEY, String(now));
        } catch {
          /* noop */
        }
      }
      return next;
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <motion.button
        type="button"
        onClick={handleOpen}
        whileTap={{ scale: 0.92 }}
        aria-label={unreadCount > 0 ? `${unreadCount} notificações novas` : 'Notificações'}
        aria-expanded={open}
        className="relative grid size-9 cursor-pointer place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
      >
        <BellIcon />
        <AnimatePresence>
          {unreadCount > 0 ? (
            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="-right-1 -top-1 absolute grid size-4 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] font-bold text-[9px] text-white shadow-sm ring-2 ring-[var(--color-surface)]"
              aria-hidden
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute top-full right-0 z-50 mt-2 flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_56px_-16px_rgba(0,0,0,0.28)]"
          >
            <header className="flex items-center justify-between border-[var(--color-border)] border-b px-4 py-3">
              <p className="font-semibold text-[13px] text-[var(--color-fg)]">Atividade recente</p>
              {feed.isFetching ? (
                <span className="font-mono text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                  atualizando…
                </span>
              ) : null}
            </header>

            <ul className="max-h-[60vh] divide-y divide-[var(--color-border)] overflow-y-auto">
              {items.length === 0 ? (
                <li className="px-6 py-12 text-center text-[13px] text-[var(--color-fg-subtle)]">
                  Sem atividade ainda. Compartilhe seu link de checkout pra ver vendas aqui.
                </li>
              ) : (
                items.map((item) => (
                  <li key={item.id}>
                    <FeedItem item={item} onClick={() => setOpen(false)} />
                  </li>
                ))
              )}
            </ul>

            <footer className="border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]/40 px-4 py-2.5 text-center">
              <Link
                href="/pedidos"
                onClick={() => setOpen(false)}
                className="font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
              >
                Ver todos os pedidos →
              </Link>
            </footer>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function FeedItem({
  item,
  onClick,
}: {
  item: {
    kind: 'order_paid' | 'subscription_active' | 'subscription_cancelled' | 'commission_available';
    title: string;
    subtitle: string;
    href: string | null;
    amountCents: number | null;
    currency: string | null;
    occurredAt: Date | string;
  };
  onClick: () => void;
}) {
  const body = (
    <>
      <KindIcon kind={item.kind} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate font-semibold text-[13px] text-[var(--color-fg)]">{item.title}</p>
        <p className="truncate text-[11px] text-[var(--color-fg-subtle)]">{item.subtitle}</p>
        <p className="text-[10px] text-[var(--color-fg-subtle)]">
          {formatRelative(new Date(item.occurredAt))}
        </p>
      </div>
      {item.amountCents != null ? (
        <span
          className={
            item.kind === 'subscription_cancelled'
              ? 'shrink-0 font-mono text-[12px] text-[var(--color-fg-subtle)] tabular-nums line-through'
              : 'shrink-0 font-semibold text-[13px] text-[var(--color-fg)] tabular-nums'
          }
        >
          {formatCents(item.amountCents, (item.currency ?? 'BRL') as 'BRL' | 'USD' | 'EUR')}
        </span>
      ) : null}
    </>
  );
  if (item.href) {
    return (
      <Link
        href={item.href}
        onClick={onClick}
        className="flex cursor-pointer items-start gap-3 px-4 py-3 transition hover:bg-[var(--color-surface-muted)]/40"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex items-start gap-3 px-4 py-3">{body}</div>;
}

function KindIcon({ kind }: { kind: string }) {
  const config: Record<string, { bg: string; fg: string; icon: React.ReactNode }> = {
    order_paid: {
      bg: 'bg-[var(--color-success-bg)]',
      fg: 'text-[var(--color-success)]',
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="size-3.5"
        >
          <title>Pagamento</title>
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    subscription_active: {
      bg: 'bg-[var(--color-brand-50)]',
      fg: 'text-[var(--color-brand-700)]',
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="size-3.5"
        >
          <title>Assinatura</title>
          <path
            d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3M13 2v3h-3M3 14v-3h3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    subscription_cancelled: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-subtle)]',
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-3.5"
        >
          <title>Cancelado</title>
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      ),
    },
    commission_available: {
      bg: 'bg-[var(--color-warning-bg)]',
      fg: 'text-[var(--color-warning)]',
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="size-3.5"
        >
          <title>Comissão</title>
          <path
            d="M8 3v10M5 6h4a2 2 0 010 4H6a2 2 0 000 4h4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
  };
  const meta = config[kind] ?? config.order_paid;
  return (
    <span
      className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${meta?.bg} ${meta?.fg}`}
      aria-hidden
    >
      {meta?.icon}
    </span>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-4"
      aria-hidden
    >
      <title>Notificações</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 14V9a5 5 0 0110 0v5l1.5 2h-13L5 14z"
      />
      <path strokeLinecap="round" d="M8.5 17.5a2 2 0 003 0" />
    </svg>
  );
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'agora mesmo';
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  if (diff < 7 * 86_400_000) return `há ${Math.floor(diff / 86_400_000)} dia(s)`;
  return date.toLocaleDateString('pt-BR');
}
