'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { GlassCard, Heading } from '../../components/ui.js';
import { useSession } from '../../lib/auth.js';

export default function DashboardHome() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) {
    return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Heading>Olá, {session.data.user.name ?? 'produtor'}.</Heading>
        <p className="text-[var(--color-fg-muted)]">
          Sua plataforma de pagamentos. Comece conectando seu WhatsApp.
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <GlassCard>
          <p className="mb-1 text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            GMV hoje
          </p>
          <p className="text-3xl font-semibold">R$ 0,00</p>
        </GlassCard>
        <GlassCard>
          <p className="mb-1 text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            Pedidos hoje
          </p>
          <p className="text-3xl font-semibold">0</p>
        </GlassCard>
        <GlassCard>
          <p className="mb-1 text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            Taxa de conversão
          </p>
          <p className="text-3xl font-semibold">—</p>
        </GlassCard>
      </div>
    </div>
  );
}
