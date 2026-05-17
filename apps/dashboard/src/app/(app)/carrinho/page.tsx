'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, EmptyState } from '../../../components/ui';
import { useSession } from '../../../lib/auth';

/**
 * Recuperação de carrinho abandonado — automação de retargeting via
 * WhatsApp/email com cadência configurável. Backend (BullMQ recovery
 * queue, audit chain) já está implementado; falta a UI de cadência e
 * a métrica de conversão.
 */
export default function CarrinhoPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  return (
    <EmptyState
      kicker="recuperação · em construção"
      title="Cada carrinho abandonado é uma venda esperando."
      description="Configure a cadência de mensagens (WhatsApp e email), o tom de cada toque e o intervalo entre eles. A engine de retargeting já está rodando no backend; em breve você define as regras desta tela."
      action={
        <Button variant="ghost" onClick={() => router.push('/dashboard')}>
          Voltar ao dashboard
        </Button>
      }
    />
  );
}
