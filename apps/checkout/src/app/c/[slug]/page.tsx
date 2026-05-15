'use client';

import clsx from 'clsx';
import { use, useState } from 'react';

/**
 * Public checkout page — `/c/<slug>`.
 *
 * First iteration: a clean BR-first form with the four mandatory fields
 * (name, email, document, phone), product/price block, and three method
 * tabs (Pix / Cartão / Boleto). Submission posts to the api's
 * `payments.create*` endpoints, which land alongside the MP/Pagar.me
 * HTTP integration in Bloco 15.
 *
 * Until then the form validates locally + surfaces the structured payload
 * so the rest of the flow can be exercised without a live gateway call.
 */
type Method = 'pix' | 'credit_card' | 'boleto';

export default function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [method, setMethod] = useState<Method>('pix');
  const [submitted, setSubmitted] = useState<Record<string, FormDataEntryValue> | null>(null);

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-2xl space-y-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            Checkout · {slug}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Finalize sua compra</h1>
        </header>

        <div className="grid grid-cols-3 gap-2 rounded-xl bg-[var(--color-surface-muted)] p-1">
          {(['pix', 'credit_card', 'boleto'] as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={clsx(
                'rounded-lg px-3 py-2 text-sm font-medium transition',
                method === m
                  ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              {m === 'pix' ? 'Pix' : m === 'credit_card' ? 'Cartão' : 'Boleto'}
            </button>
          ))}
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const entries = Object.fromEntries(fd.entries());
            setSubmitted({ ...entries, method });
          }}
        >
          <Field name="name" label="Nome completo" required />
          <Field name="email" label="Email" type="email" required />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="document" label="CPF / CNPJ" required />
            <Field name="phone" label="Telefone" type="tel" required />
          </div>

          {method === 'credit_card' && (
            <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-4">
              <p className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Cartão
              </p>
              <Field name="cardNumber" label="Número do cartão" inputMode="numeric" required />
              <div className="grid grid-cols-2 gap-4">
                <Field name="cardExpiry" label="Validade (MM/AA)" required />
                <Field name="cardCvc" label="CVV" inputMode="numeric" required />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="w-full rounded-xl bg-[var(--color-brand-600)] px-5 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_-12px_rgba(234,88,12,0.6)] transition hover:bg-[var(--color-brand-500)]"
          >
            {method === 'pix'
              ? 'Gerar QR-code Pix'
              : method === 'credit_card'
                ? 'Pagar com cartão'
                : 'Gerar boleto'}
          </button>
        </form>

        {submitted && (
          <pre className="overflow-auto rounded-xl bg-[var(--color-surface-muted)] p-4 text-xs">
            {JSON.stringify(submitted, null, 2)}
          </pre>
        )}

        <p className="text-center text-xs text-[var(--color-fg-subtle)]">
          Pagamento processado por payunivercart · ambiente de homologação
        </p>
      </div>
    </main>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required,
  inputMode,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  inputMode?: 'numeric' | 'tel' | 'email';
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        inputMode={inputMode}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm outline-none transition focus:border-[var(--color-brand-500)]/60"
      />
    </label>
  );
}
