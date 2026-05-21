'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { signOut, useSession } from '../lib/auth';
import { trpc } from '../lib/trpc';

/**
 * Admin home — platform-wide overview + cross-tenant workspace list.
 *
 * Auth: redirects unauthenticated callers to `/login`. The api's
 * `superuserProcedure` is what really decides whether the session can
 * read cross-tenant data; this page just translates a tRPC FORBIDDEN
 * into a friendly empty-state instead of a stack trace.
 */
export default function AdminHome() {
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  const overview = trpc.admin.overview.useQuery(undefined, {
    enabled: !!session.data,
    retry: false,
  });
  const workspaces = trpc.admin.workspaces.useQuery(undefined, {
    enabled: !!session.data,
    retry: false,
  });
  const utils = trpc.useUtils();
  const setSuspended = trpc.admin.setWorkspaceSuspended.useMutation({
    onSuccess: () => utils.admin.workspaces.invalidate(),
  });

  if (session.isPending) {
    return <p className="p-8 text-[14px] text-[var(--color-fg-muted)]">Carregando sessão…</p>;
  }
  if (!session.data) return null;

  const forbidden =
    overview.error?.data?.code === 'FORBIDDEN' || workspaces.error?.data?.code === 'FORBIDDEN';

  if (forbidden) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="flex max-w-md flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
          <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
            403
          </p>
          <h1 className="font-semibold text-[20px]">Sem permissão</h1>
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Sua conta não está na lista de operadores do painel interno. Se você é produtor, use{' '}
            <code className="font-mono">app.univercart.com</code>.
          </p>
          <button
            type="button"
            onClick={() => signOut().then(() => router.replace('/login'))}
            className="rounded-xl border border-[var(--color-border)] px-4 py-2 font-medium text-[13px] text-[var(--color-fg)] hover:border-[var(--color-border-strong)]"
          >
            Sair
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <img src="/payunivercart-logo.png" alt="payunivercart" className="h-6 w-auto" />
            <span className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
              · admin
            </span>
          </div>
          <h1 className="font-semibold text-[28px] tracking-tight">Operação</h1>
          <p className="text-[14px] text-[var(--color-fg-muted)]">
            Visão cross-tenant da plataforma. Use com cautela — toda ação aqui afeta múltiplos
            produtores.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/partners"
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
          >
            Univercart Connect →
          </Link>
          <button
            type="button"
            onClick={() => signOut().then(() => router.replace('/login'))}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
          >
            Sair · {session.data.user.email}
          </button>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Produtores" value={overview.data?.producers ?? '—'} />
        <Kpi label="Workspaces" value={overview.data?.workspaces ?? '—'} />
        <Kpi
          label="GMV pago"
          value={overview.data ? formatCents(overview.data.paidGmvCents) : '—'}
        />
        <Kpi label="Pedidos pagos" value={overview.data?.paidOrders ?? '—'} />
        <Kpi label="Pendentes" value={overview.data?.pendingOrders ?? '—'} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-semibold text-[16px]">Workspaces · {workspaces.data?.length ?? 0}</h2>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-muted)] text-left text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Workspace</th>
                <th className="px-4 py-2.5 font-semibold">Owner</th>
                <th className="px-4 py-2.5 font-semibold">GMV (pago)</th>
                <th className="px-4 py-2.5 font-semibold">Pedidos</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 text-right font-semibold">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(workspaces.data ?? []).map((row) => (
                <tr key={row.workspaceId}>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-medium text-[var(--color-fg)]">
                        {row.companyName ?? row.workspaceName}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                        {row.organizationName} · {row.workspaceSlug}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {row.ownerEmail ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-medium">{formatCents(row.gmvCents)}</td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {row.paidOrders} pagos · {row.pendingOrders} pendentes
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        row.suspended
                          ? 'rounded-full bg-[var(--color-danger-bg)] px-2.5 py-0.5 font-medium text-[10px] text-[var(--color-danger)] uppercase tracking-wider'
                          : 'rounded-full bg-[var(--color-success-bg)] px-2.5 py-0.5 font-medium text-[10px] text-[var(--color-success)] uppercase tracking-wider'
                      }
                    >
                      {row.suspended ? 'Suspenso' : 'Ativo'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        const next = !row.suspended;
                        if (
                          next &&
                          !confirm(
                            `Suspender "${row.companyName ?? row.workspaceName}"? O produtor perde acesso a mutations.`,
                          )
                        )
                          return;
                        setSuspended.mutate({ workspaceId: row.workspaceId, suspended: next });
                      }}
                      disabled={setSuspended.isPending}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1 font-medium text-[11px] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
                    >
                      {row.suspended ? 'Reativar' : 'Suspender'}
                    </button>
                  </td>
                </tr>
              ))}
              {workspaces.isPending ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[var(--color-fg-subtle)]">
                    Carregando workspaces…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        {label}
      </p>
      <p className="mt-2 font-semibold text-[22px] text-[var(--color-fg)]">{value}</p>
    </div>
  );
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
