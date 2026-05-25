'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RedirectIfAuthed } from '../../components/RedirectIfAuthed';
import { Button, Heading, Input, Kicker } from '../../components/ui';
import { signUp } from '../../lib/auth';

/**
 * Signup — wrapped in `<RedirectIfAuthed>` so an already-authed
 * visitor lands on /dashboard instead of being asked to create a new
 * account.
 */
export default function SignupPage() {
  return (
    <RedirectIfAuthed>
      <SignupPageInner />
    </RedirectIfAuthed>
  );
}

function SignupPageInner() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await signUp.email({ name, email, password });
    setBusy(false);
    if (err) {
      setError(err.message ?? 'Não foi possível criar sua conta.');
      return;
    }
    router.push('/dashboard');
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg)]">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 lg:grid-cols-2">
        {/* Left — form */}
        <section className="flex flex-col px-6 py-8 lg:px-16 lg:py-12">
          <Link href="/" className="inline-flex items-center">
            <img src="/payunivercart-logo.png" alt="payunivercart" className="h-7 w-auto" />
          </Link>

          <div className="flex flex-1 flex-col justify-center py-10">
            <div className="mx-auto w-full max-w-sm">
              <Kicker>Criar workspace</Kicker>
              <Heading level={1} className="mt-3">
                Comece a vender em minutos.
              </Heading>
              <p className="mt-3 text-[15px] text-[var(--color-fg-muted)]">
                R$ 99,90/mês por workspace. Sem taxa de adesão. Cancela quando quiser.
              </p>

              <form onSubmit={onSubmit} className="mt-8 space-y-5">
                <Input
                  label="Nome"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Como você quer ser chamado"
                />
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
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  minLength={8}
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
                  {busy ? 'Criando…' : 'Criar workspace'}
                </Button>
              </form>

              <p className="mt-6 text-center text-[14px] text-[var(--color-fg-muted)]">
                Já tem conta?{' '}
                <Link
                  href="/login"
                  className="font-medium text-[var(--color-fg)] underline-offset-4 hover:underline"
                >
                  Entrar
                </Link>
              </p>
            </div>
          </div>

          <p className="text-[12px] text-[var(--color-fg-subtle)]">
            © {new Date().getFullYear()} payunivercart
          </p>
        </section>

        {/* Right — onboarding sequence preview */}
        <aside className="relative hidden overflow-hidden border-[var(--color-border)] border-l bg-[var(--color-surface-muted)] p-16 lg:flex lg:flex-col lg:justify-between">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[-15%] mx-auto h-[400px] max-w-md bg-[radial-gradient(closest-side,rgba(22,163,74,0.10),transparent_75%)] blur-3xl"
          />
          <div className="relative">
            <Kicker>O que vem a seguir</Kicker>
            <Heading level={2} className="mt-3 text-balance">
              Três passos pra primeira venda.
            </Heading>
          </div>

          <ol className="relative space-y-4">
            <Step n="01" title="Conectar o WhatsApp">
              Sessão dedicada por workspace. Escaneie o QR code e o canal de venda fica ativo em
              minutos.
            </Step>
            <Step n="02" title="Cadastrar o primeiro produto">
              Nome, preço, descrição. O link de checkout é gerado automaticamente — pronto pra
              compartilhar.
            </Step>
            <Step n="03" title="Configurar a recuperação">
              Cadência de mensagens via WhatsApp e email. A engine roda sozinha e converte os
              abandonos.
            </Step>
          </ol>
        </aside>
      </div>
    </main>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-surface-muted)] font-semibold text-[13px] text-[var(--color-fg)]">
        {n}
      </span>
      <div>
        <p className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</p>
        <p className="mt-1 text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">{children}</p>
      </div>
    </li>
  );
}
