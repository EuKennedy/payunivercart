/**
 * App Router 404. See apps/admin/src/app/not-found.tsx for rationale.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="space-y-3 text-center">
        <p className="text-[var(--color-accent-500)] text-xs uppercase tracking-[0.2em]">404</p>
        <h1 className="font-semibold text-3xl tracking-tight">Checkout não encontrado</h1>
        <p className="max-w-md text-[var(--color-fg-muted)]">
          O link de pagamento que você acessou não existe ou já foi encerrado. Volte ao produtor e
          gere um novo link.
        </p>
      </div>
    </main>
  );
}
