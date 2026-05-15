'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, GlassCard, Heading, Input } from '../../components/ui.js';
import { signUp } from '../../lib/auth.js';

export default function SignupPage() {
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
      setError(err.message ?? 'Falha ao criar conta');
      return;
    }
    router.push('/dashboard');
  }

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <GlassCard className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <Heading level={2}>Criar conta</Heading>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Comece a vender no payunivercart em minutos.
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
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
            <p className="text-sm text-red-300/90" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Criando…' : 'Criar conta'}
          </Button>
        </form>
        <p className="text-center text-sm text-[var(--color-fg-muted)]">
          Já tem conta?{' '}
          <Link href="/login" className="text-[var(--color-brand-400)] hover:underline">
            Entrar
          </Link>
        </p>
      </GlassCard>
    </main>
  );
}
