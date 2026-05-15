'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, GlassCard, Heading, Input } from '../../components/ui.js';
import { signIn } from '../../lib/auth.js';

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
      setError(err.message ?? 'Falha ao entrar');
      return;
    }
    router.push('/dashboard');
  }

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <GlassCard className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <Heading level={2}>Entrar</Heading>
          <p className="text-sm text-[var(--color-fg-muted)]">Acesse seu painel de produtor.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
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
            <p className="text-sm text-red-300/90" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>
        <p className="text-center text-sm text-[var(--color-fg-muted)]">
          Não tem conta?{' '}
          <Link href="/signup" className="text-[var(--color-brand-400)] hover:underline">
            Criar conta
          </Link>
        </p>
      </GlassCard>
    </main>
  );
}
