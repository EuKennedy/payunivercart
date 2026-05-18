'use client';

import { useRouter } from 'next/navigation';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { API_URL, CHECKOUT_URL } from '../../../lib/env';
import { type Currency, formatCents } from '../../../lib/money';
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
        action={<Button onClick={() => router.push('/produtos/novo')}>Cadastrar produto</Button>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Kicker>catálogo</Kicker>
          <Heading level={1}>Seus produtos</Heading>
          <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
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
          <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            <tr>
              <th className="px-5 py-3 font-semibold">Produto</th>
              <th className="px-5 py-3 font-semibold">Preço</th>
              <th className="px-5 py-3 font-semibold">Link de checkout</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 text-right font-semibold">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {list.data.map((product) => {
              const publicUrl = `${CHECKOUT_URL}/c/${product.slug}`;
              const checkoutHostLabel = publicUrl.replace(/^https?:\/\//, '');
              return (
                <tr
                  key={product.id}
                  className="transition hover:bg-[var(--color-surface-muted)]/50"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      {product.hasCover ? (
                        <img
                          src={`${API_URL}/img/product/${product.id}/cover`}
                          alt=""
                          className="size-10 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div
                          className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[10px] text-[var(--color-fg-subtle)]"
                          aria-hidden
                        >
                          1:1
                        </div>
                      )}
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-[var(--color-fg)]">{product.name}</span>
                        {product.description ? (
                          <span className="line-clamp-1 text-[12px] text-[var(--color-fg-subtle)]">
                            {product.description}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-medium text-[var(--color-fg)]">
                    {formatCents(product.priceCents, product.currency as Currency)}
                    <span className="ml-1 text-[11px] text-[var(--color-fg-subtle)]">
                      em até {product.maxInstallments}×
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-brand-600)]"
                    >
                      {checkoutHostLabel}
                    </a>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={
                        product.isActive
                          ? 'rounded-full bg-[var(--color-success-bg)] px-2.5 py-0.5 font-medium text-[11px] text-[var(--color-success)] uppercase tracking-wider'
                          : 'rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider'
                      }
                    >
                      {product.isActive ? 'Ativo' : 'Pausado'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/produtos/${product.id}`)}
                      >
                        Editar
                      </Button>
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
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
