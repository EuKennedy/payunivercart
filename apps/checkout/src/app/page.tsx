/**
 * Public checkout landing — buyers should always arrive via `/c/<slug>`
 * but a stray hit on the root is handled gracefully.
 */
export default function CheckoutLanding() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <div className="surface mx-auto w-full max-w-md p-10 text-center">
        <p className="font-medium text-[11px] text-[var(--color-brand-600)] uppercase tracking-[0.18em]">
          payunivercart
        </p>
        <h1 className="display mt-3 font-semibold text-[28px] text-[var(--color-fg)]">Checkout</h1>
        <p className="mt-4 text-[15px] text-[var(--color-fg-muted)] leading-[1.5]">
          Acesse o checkout pelo link enviado pelo produtor
          <span className="mt-1 block font-mono text-[12px] text-[var(--color-fg-subtle)]">
            pay.univercart.com/c/&lt;slug&gt;
          </span>
        </p>
      </div>
    </main>
  );
}
