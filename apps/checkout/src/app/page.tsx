/**
 * Public checkout landing — buyers should always arrive via `/c/<slug>`
 * but a stray hit on the root is handled gracefully.
 */
export default function CheckoutLanding() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <div className="surface mx-auto w-full max-w-md p-10 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-brand-600)]">
          payunivercart
        </p>
        <h1 className="display mt-3 text-[28px] font-semibold text-[var(--color-fg)]">
          Checkout
        </h1>
        <p className="mt-4 text-[15px] leading-[1.5] text-[var(--color-fg-muted)]">
          Acesse o checkout pelo link enviado pelo produtor
          <span className="block mt-1 font-mono text-[12px] text-[var(--color-fg-subtle)]">
            check.univercart.com/c/&lt;slug&gt;
          </span>
        </p>
      </div>
    </main>
  );
}
