'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, EmptyState } from '../../../components/ui';
import { useSession } from '../../../lib/auth';

/**
 * Meu Checkout — configuration surface for the producer's checkout
 * appearance, payment methods, custom fields, brazil/international
 * tax compliance toggles, and recovery messaging. Vertical lands in
 * a future block.
 */
export default function CheckoutConfigPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  return (
    <EmptyState
      kicker="checkout · em construção"
      title="Personalize seu checkout."
      description="Cor, logo, campos extras, métodos de pagamento, parcelamento, upsell pós-compra e mensagens automáticas — você desenha o checkout do jeito que faz sentido para sua audiência. Em desenvolvimento."
      action={
        <Button variant="ghost" onClick={() => router.push('/dashboard')}>
          Voltar ao dashboard
        </Button>
      }
    />
  );
}
