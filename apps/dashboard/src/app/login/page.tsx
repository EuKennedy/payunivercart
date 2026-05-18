'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Heading, Input, Kicker } from '../../components/ui';
import { signIn } from '../../lib/auth';

/**
 * Login — split-screen: form on the left, marketing pillars on the right.
 * Mobile collapses to single column with the form first.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(err.message ?? 'Não foi possível entrar. Verifique suas credenciais.');
      return;
    }
    router.push('/dashboard');
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg)]">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 lg:grid-cols-2">
        {/* Left — form */}
        <section className="flex flex-col px-6 py-8 lg:px-16 lg:py-12">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-fg)] font-semibold text-[14px] text-[var(--color-fg-inverse)]">
              p
            </span>
            <span className="font-semibold text-[15px] tracking-tight">payunivercart</span>
          </Link>

          <div className="flex flex-1 flex-col justify-center py-10">
            <div className="mx-auto w-full max-w-sm">
              <Kicker>Painel do produtor</Kicker>
              <Heading level={1} className="mt-3">
                Bem-vindo de volta.
              </Heading>
              <p className="mt-3 text-[15px] text-[var(--color-fg-muted)]">
                Entre com seu email e senha pra acessar o workspace.
              </p>

              <form onSubmit={onSubmit} className="mt-8 space-y-5">
                <Input
                  label="Email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@empresa.com"
                />
                <Input
                  label="Senha"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                />
                {error && (
                  <div
                    role="alert"
                    className="rounded-xl border border-[rgba(194,38,26,0.18)] bg-[var(--color-danger-bg)] px-4 py-3 font-medium text-[13px] text-[var(--color-danger)]"
                  >
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" size="lg" disabled={busy}>
                  {busy ? 'Entrando…' : 'Entrar'}
                </Button>
              </form>

              <p className="mt-6 text-center text-[14px] text-[var(--color-fg-muted)]">
                Não tem conta?{' '}
                <Link
                  href="/signup"
                  className="font-medium text-[var(--color-fg)] underline-offset-4 hover:underline"
                >
                  Criar workspace
                </Link>
              </p>
            </div>
          </div>

          <p className="text-[12px] text-[var(--color-fg-subtle)]">
            © {new Date().getFullYear()} payunivercart
          </p>
        </section>

        {/* Right — sales/social proof panel. Hidden on mobile. */}
        <aside className="relative hidden overflow-hidden border-[var(--color-border)] border-l bg-[var(--color-surface-muted)] p-16 lg:flex lg:flex-col lg:justify-between">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[-15%] mx-auto h-[400px] max-w-md bg-[radial-gradient(closest-side,rgba(249,115,22,0.10),transparent_75%)] blur-3xl"
          />
          <div className="relative">
            <Kicker>Por que payunivercart</Kicker>
            <Heading level={2} className="mt-3 text-balance">
              A plataforma que cresce com a sua operação.
            </Heading>
            <p className="mt-4 text-[16px] text-[var(--color-fg-muted)] leading-[1.55]">
              Multi-tenant nativo, auditoria criptográfica em cada transação e checkout que aceita
              Pix, cartão, boleto e Stripe USD — pronto pra escalar de R$ 10k a R$ 10M por mês.
            </p>
          </div>

          <div className="relative space-y-3">
            <PullQuote
              quote="Migrei do Hotmart e a primeira venda chegou em 3 horas. O WhatsApp integrado é o diferencial."
              author="produtor digital, infoprodutos"
            />
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Workspaces" value="—" />
              <Stat label="GMV mensal" value="—" />
              <Stat label="Uptime" value="99,9%" />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function PullQuote({ quote, author }: { quote: string; author: string }) {
  return (
    <figure className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <blockquote className="text-[15px] text-[var(--color-fg)] leading-[1.55]">
        “{quote}”
      </blockquote>
      <figcaption className="mt-4 text-[12px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
        {author}
      </figcaption>
    </figure>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
        {label}
      </p>
      <p className="mt-1.5 font-semibold text-[22px] text-[var(--color-fg)] tracking-tight">
        {value}
      </p>
    </div>
  );
}
