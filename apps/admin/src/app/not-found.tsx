/**
 * App Router 404 page.
 *
 * Without an explicit `not-found.tsx`, Next.js falls back to a
 * Pages-Router-style `_document` template at prerender time, which
 * imports `<Html>` from `next/document` and crashes an App Router
 * build with "Html should not be imported outside of pages/_document".
 * Defining the boundary ourselves keeps the build on the App Router
 * happy path AND gives us a branded 404 to ship.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="space-y-3 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent-500)]">
          404
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Rota não encontrada
        </h1>
        <p className="max-w-md text-[var(--color-fg-muted)]">
          Este endereço não existe no painel de operação. Verifique a URL
          ou volte ao{' '}
          <a href="/" className="underline">
            painel principal
          </a>
          .
        </p>
      </div>
    </main>
  );
}
