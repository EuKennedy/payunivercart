export default function AdminHome() {
  // The super-admin gate (role check via Better-Auth + IP allowlist)
  // lands with the first endpoint that touches cross-tenant data.
  // Until then the page renders a barebones operator screen.
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-3xl space-y-8">
        <header className="space-y-2 border-b border-[var(--color-border)] pb-6">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent-500)]">
            internal · super-admin
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">payunivercart ops</h1>
          <p className="text-[var(--color-fg-muted)]">
            Painel de operação. Use com cautela — toda ação aqui é cross-tenant.
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { label: 'Producers', value: '—' },
            { label: 'Workspaces ativos', value: '—' },
            { label: 'MRR (BRL)', value: '—' },
          ].map((m) => (
            <div
              key={m.label}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
            >
              <p className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
                {m.label}
              </p>
              <p className="mt-2 text-3xl font-semibold">{m.value}</p>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-fg-subtle)]">Áreas</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {[
              ['/producers', 'Produtores'],
              ['/workspaces', 'Workspaces'],
              ['/transactions', 'Transações (cross-tenant)'],
              ['/audit', 'Audit log + verificador de cadeia'],
              ['/webhooks', 'Webhooks inbound / outbox'],
              ['/jobs', 'Filas BullMQ'],
            ].map(([href, label]) => (
              <li
                key={href}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-fg-muted)]"
              >
                <code className="mr-2 text-xs text-[var(--color-fg-subtle)]">{href}</code>
                {label}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Endpoints concretos aparecem aqui conforme os domínios entram em produção. Por enquanto
            o painel serve como inventário.
          </p>
        </section>
      </div>
    </main>
  );
}
