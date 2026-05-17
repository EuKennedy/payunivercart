'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, EmptyState } from '../../../../components/ui';
import { useSession } from '../../../../lib/auth';

/**
 * Email integration — outbound transactional + marketing channel. The
 * server-side adapter (Resend) is queued behind `packages/emails` and
 * lands with the recovery cadence vertical.
 */
export default function EmailIntegrationPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  return (
    <EmptyState
      kicker="email · em construção"
      title="Email transacional + marketing."
      description="Confirmações de compra, recovery automatizado, broadcasts segmentados por audiência — tudo no mesmo painel, com tracking de abertura e clique. Em desenvolvimento."
      action={
        <Button variant="ghost" onClick={() => router.push('/dashboard')}>
          Voltar ao dashboard
        </Button>
      }
    />
  );
}
