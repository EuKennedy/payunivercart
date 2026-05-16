/**
 * App Router 404. See apps/admin/src/app/not-found.tsx for rationale.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="space-y-3 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent-500)]">
          404
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Página não encontrada
        </h1>
        <p className="max-w-md text-[var(--color-fg-muted)]">
          Essa rota não existe. Volte ao{' '}
          <a href="/" className="underline">
            início
          </a>{' '}
          ou ao seu{' '}
          <a href="/dashboard" className="underline">
            dashboard
          </a>
          .
        </p>
      </div>
    </main>
  );
}
