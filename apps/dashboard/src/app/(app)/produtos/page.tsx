'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { formatCents, type Currency } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Meus Produtos — catalog list view.
 *
 * Empty state mirrors the dashboard hero (Apple/Linear-tier kicker +
 * title + description + CTA). Once at least one product exists, we
 * switch to a dense table with a "Cadastrar produto" pill in the top
 * right corner. Slug is rendered as the eventual public checkout URL
 * so the producer's mental model lines up with the link they will
 * share.
 */
export default function ProdutosPage() {
  const router = useRouter();
  const list = trpc.products.list.useQuery(undefined, { staleTime: 15_000 });
  const archive = trpc.products.archive.useMutation({
    onSuccess: () => list.refetch(),
  });

  if (list.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }

  if (!list.data || list.data.length === 0) {
    return (
      <EmptyState
        kicker="catálogo · pronto pra preencher"
        title="Cadastre seu primeiro produto."
        description="Nome, preço, descrição. O link do checkout é gerado automaticamente — pronto pra colar no seu funil de WhatsApp, anúncio ou bio."
        action={
          <Button onClick={() => router.push('/produtos/novo')}>Cadastrar produto</Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Kicker>catálogo</Kicker>
          <Heading level={1}>Seus produtos</Heading>
          <p className="max-w-2xl text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
            {list.data.length === 1
              ? '1 produto cadastrado.'
              : `${list.data.length} produtos cadastrados.`}{' '}
            Cada um tem um link de checkout pronto pra ser compartilhado.
          </p>
        </div>
        <Button onClick={() => router.push('/produtos/novo')}>Cadastrar produto</Button>
      </header>

      <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-[14px]">
          <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            <tr>
              <th className="px-5 py-3 font-semibold">Produto</th>
              <th className="px-5 py-3 font-semibold">Preço</th>
              <th className="px-5 py-3 font-semibold">Link de checkout</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {list.data.map((product) => (
              <tr key={product.id} className="transition hover:bg-[var(--color-surface-muted)]/50">
                <td className="px-5 py-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-[var(--color-fg)]">{product.name}</span>
                    {product.description ? (
                      <span className="line-clamp-1 text-[12px] text-[var(--color-fg-subtle)]">
                        {product.description}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-5 py-4 font-medium text-[var(--color-fg)]">
                  {formatCents(product.priceCents, product.currency as Currency)}
                  <span className="ml-1 text-[11px] text-[var(--color-fg-subtle)]">
                    em até {product.maxInstallments}×
                  </span>
                </td>
                <td className="px-5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                  <Link
                    href={`/c/${product.slug}`}
                    className="font-mono underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-brand-600)]"
                  >
                    pay.univercart.com/c/{product.slug}
                  </Link>
                </td>
                <td className="px-5 py-4">
                  <span
                    className={
                      product.isActive
                        ? 'rounded-full bg-[var(--color-success-bg)] px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-success)]'
                        : 'rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]'
                    }
                  >
                    {product.isActive ? 'Ativo' : 'Pausado'}
                  </span>
                </td>
                <td className="px-5 py-4 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!confirm(`Arquivar "${product.name}"?`)) return;
                      archive.mutate({ id: product.id });
                    }}
                    disabled={archive.isPending}
                  >
                    Arquivar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
