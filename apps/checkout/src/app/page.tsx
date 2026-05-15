export default function CheckoutLanding() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="max-w-md space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
        <p className="text-[var(--color-fg-muted)]">
          Acesse seu checkout através do link enviado pelo produtor (ex.
          <code className="ml-1 rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-sm">
            /c/&lt;slug&gt;
          </code>
          ).
        </p>
      </div>
    </main>
  );
}
