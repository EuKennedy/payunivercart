'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, EmptyState } from '../../../components/ui';
import { useSession } from '../../../lib/auth';

/**
 * Meus Produtos — landing for the product catalog vertical.
 *
 * The CRUD (cadastro de novo produto, categorias, performance analytics)
 * lands in upcoming blocks. Until then this page is a deliberately
 * branded "shape of the surface" so the navigation never dead-ends in a
 * 404 and producers see what's coming.
 */
export default function ProdutosPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  return (
    <EmptyState
      kicker="catálogo · em construção"
      title="Seus produtos vivem aqui."
      description="Cadastre infoprodutos, físicos e assinaturas em um só lugar. Categorias, variações de preço, performance por SKU e link de checkout — tudo conectado. Esta superfície entra no ar no próximo bloco de desenvolvimento."
      action={
        <Button variant="ghost" onClick={() => router.push('/dashboard')}>
          Voltar ao dashboard
        </Button>
      }
    />
  );
}
