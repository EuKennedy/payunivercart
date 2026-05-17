'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';

/**
 * Workspace switcher — the top-left brand block of the sidebar.
 *
 * Visual language: matches the static brand block it replaces (9px
 * black square + 15px semibold label) so the sidebar shell does not
 * shift when the data hydrates. A chevron sits to the right; clicking
 * opens a dropdown listing every workspace the user is a member of.
 *
 * Single-workspace producers (the only state today) see the dropdown
 * with one item + a disabled "Criar workspace" hint — the affordance
 * exists so the founder is never surprised when a second workspace
 * becomes possible later in the platform's life.
 */
export function WorkspaceSwitcher() {
  const me = trpc.workspace.me.useQuery(undefined, { staleTime: 60_000 });
  const list = trpc.workspace.list.useQuery(undefined, { staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Loading skeleton — exact pixel footprint of the resolved state so
  // the sidebar never reflows.
  if (me.isPending || !me.data) {
    return (
      <div className="flex items-center gap-2.5 px-1 py-1">
        <span className="size-9 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
        <span className="h-3.5 flex-1 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      </div>
    );
  }

  const initial = (me.data.workspace.name[0] ?? 'p').toLowerCase();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 transition hover:bg-[var(--color-surface-muted)]"
      >
        <span className="grid size-9 place-items-center rounded-xl bg-[var(--color-fg)] text-[15px] font-semibold tracking-tight text-[var(--color-fg-inverse)]">
          {initial}
        </span>
        <span className="flex-1 truncate text-left text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
          {me.data.workspace.name}
        </span>
        <ChevronDown className="size-3.5 text-[var(--color-fg-subtle)]" />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-10 mt-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          <ul className="flex flex-col py-1">
            {(list.data ?? [{ workspaceId: me.data.workspace.id, name: me.data.workspace.name, role: me.data.role }]).map(
              (ws) => (
                <li key={ws.workspaceId}>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--color-surface-muted)]',
                      ws.workspaceId === me.data.workspace.id
                        ? 'text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-muted)]',
                    )}
                  >
                    <span className="grid size-6 place-items-center rounded-md bg-[var(--color-fg)] text-[10px] font-semibold text-[var(--color-fg-inverse)]">
                      {(ws.name[0] ?? 'p').toLowerCase()}
                    </span>
                    <span className="flex-1 truncate font-medium">{ws.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                      {ws.role}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
          <div className="border-t border-[var(--color-border)] px-3 py-2">
            <button
              type="button"
              disabled
              className="flex w-full items-center gap-2 text-left text-[12px] font-medium text-[var(--color-fg-subtle)]"
            >
              <span className="grid size-5 place-items-center rounded-md border border-dashed border-[var(--color-border)] text-[12px] leading-none">
                +
              </span>
              <span className="flex-1">Criar workspace</span>
              <span className="text-[9px] uppercase tracking-wider">em breve</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}
