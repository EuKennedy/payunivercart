'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../lib/env';
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

  // Customer-facing brand name beats the internal workspace name when
  // the producer has set one. Mirrors the checkout header behaviour so
  // the sidebar identity matches what the buyer sees.
  const displayName = me.data.workspace.companyName?.trim() || me.data.workspace.name;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 transition hover:bg-[var(--color-surface-muted)]"
      >
        <WorkspaceAvatar
          workspaceId={me.data.workspace.id}
          name={displayName}
          hasLogo={me.data.workspace.hasLogo}
          size="md"
        />
        <span className="flex-1 truncate text-left font-semibold text-[15px] text-[var(--color-fg)] tracking-tight">
          {displayName}
        </span>
        <ChevronDown className="size-3.5 text-[var(--color-fg-subtle)]" />
      </button>

      {open ? (
        <div className="absolute top-full right-0 left-0 z-10 mt-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          <ul className="flex flex-col py-1">
            {(
              list.data ?? [
                {
                  workspaceId: me.data.workspace.id,
                  name: me.data.workspace.name,
                  companyName: me.data.workspace.companyName,
                  hasLogo: me.data.workspace.hasLogo,
                  role: me.data.role,
                },
              ]
            ).map((ws) => {
              const wsDisplayName = ws.companyName?.trim() || ws.name;
              return (
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
                    <WorkspaceAvatar
                      workspaceId={ws.workspaceId}
                      name={wsDisplayName}
                      hasLogo={ws.hasLogo}
                      size="sm"
                    />
                    <span className="flex-1 truncate font-medium">{wsDisplayName}</span>
                    <span className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                      {ws.role}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-[var(--color-border)] border-t px-3 py-2">
            <button
              type="button"
              disabled
              className="flex w-full items-center gap-2 text-left font-medium text-[12px] text-[var(--color-fg-subtle)]"
            >
              <span className="grid size-5 place-items-center rounded-md border border-[var(--color-border)] border-dashed text-[12px] leading-none">
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

/**
 * Avatar block for a workspace. Renders the producer's uploaded brand
 * logo when present, otherwise falls back to the initial letter of the
 * (customer-facing) name. The logo is served by the API as raw bytes at
 * `/img/workspace/:id/logo` — no auth required because the workspace id
 * is non-enumerable (uuidv4) and the bytes are already exposed via the
 * public checkout.
 *
 * Two sizes:
 *   - `md` (size-9) sidebar top-left, matches the legacy initial block.
 *   - `sm` (size-6) dropdown rows.
 *
 * When the `<img>` 404s (logo deleted between fetch + render) the
 * `onError` handler hides it and falls back to the initial without
 * breaking the layout.
 */
function WorkspaceAvatar({
  workspaceId,
  name,
  hasLogo,
  size,
}: {
  workspaceId: string;
  name: string;
  hasLogo: boolean;
  size: 'md' | 'sm';
}) {
  const [errored, setErrored] = useState(false);
  const dims = size === 'md' ? 'size-9 rounded-xl text-[15px]' : 'size-6 rounded-md text-[10px]';
  const initial = (name[0] ?? 'p').toLowerCase();

  if (hasLogo && !errored) {
    return (
      <span
        className={clsx(
          'grid shrink-0 place-items-center overflow-hidden bg-white ring-1 ring-[var(--color-border)]',
          dims,
        )}
      >
        <img
          src={`${API_URL.replace(/\/$/, '')}/img/workspace/${workspaceId}/logo`}
          alt={name}
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center bg-[var(--color-fg)] font-semibold text-[var(--color-fg-inverse)] tracking-tight',
        dims,
      )}
    >
      {initial}
    </span>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}
