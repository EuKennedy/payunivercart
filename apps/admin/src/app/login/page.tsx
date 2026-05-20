'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIn } from '../../lib/auth';

/**
 * Single-form login. The api's `superuserProcedure` is what actually
 * gates access — this page is just the credential-input surface. A
 * regular producer who signs in here lands on `/` and gets a friendly
 * "you are not authorised" rather than a cryptic 403.
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(err.message ?? 'Não conseguimos entrar.');
      return;
    }
    router.replace('/');
  }

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8"
      >
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <img src="/payunivercart-logo.png" alt="payunivercart" className="h-6 w-auto" />
            <span className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
              · admin
            </span>
          </div>
          <h1 className="font-semibold text-[22px] text-[var(--color-fg)]">Acesso interno</h1>
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            Apenas operadores cadastrados podem entrar. Producers usam pay.univercart.com.
          </p>
        </header>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-[12px] text-[var(--color-fg-muted)]">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-[12px] text-[var(--color-fg-muted)]">Senha</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
          />
        </label>

        {error ? <p className="text-[13px] text-[var(--color-danger)]">{error}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-[var(--color-brand-500)] px-4 py-2.5 font-semibold text-[14px] text-white transition hover:bg-[var(--color-brand-600)] disabled:opacity-60"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
