'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, EmptyState, Heading, Kicker } from '../../../components/ui';
import { API_URL, CHECKOUT_URL } from '../../../lib/env';
import { type Currency, formatCents, parseCentsBRL } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

// ─── Skeleton row ────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr>
      {[60, 80, 120, 50, 80].map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton row is a static array; widths repeat so index is the only stable key.
        <td key={`skel-${i}`} className="px-5 py-4">
          <div
            className="h-4 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
            style={{ width: w }}
          />
        </td>
      ))}
    </tr>
  );
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copie o link:', text);
    }
  };
  return (
    <motion.button
      type="button"
      onClick={copy}
      title={copied ? 'Copiado!' : 'Copiar link de checkout'}
      whileTap={{ scale: 0.92 }}
      className={`ml-2 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[11px] transition ${
        copied
          ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
          : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
      }`}
    >
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.svg
            key="check"
            initial={{ scale: 0.4, rotate: -25, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            className="size-3"
            aria-hidden
          >
            <title>Link copiado</title>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
          </motion.svg>
        ) : (
          <motion.svg
            key="copy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className="size-3.5"
            aria-hidden
          >
            <title>Copiar link</title>
            <rect x="4" y="4" width="9" height="9" rx="1.5" />
            <path d="M11 4V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
          </motion.svg>
        )}
      </AnimatePresence>
      {copied ? 'Copiado' : 'Copiar'}
    </motion.button>
  );
}

// ─── Archive confirm modal ────────────────────────────────────────────────────

function ArchiveModal({
  name,
  onConfirm,
  onCancel,
  loading,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismisses via Cancel button (keyboard-accessible) — div onClick is just a UX convenience for mouse users.
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onCancel}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only; card content is interactive via real buttons. */}
      <motion.div
        className="mx-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.92, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, y: 12, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      >
        <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">Arquivar produto?</h3>
        <p className="mt-2 text-[14px] text-[var(--color-fg-muted)] leading-[1.5]">
          <span className="font-medium text-[var(--color-fg)]">"{name}"</span> ficará invisível no
          checkout. Você pode reativar pelo suporte se precisar.
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
            Cancelar
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={loading}>
            {loading ? 'Arquivando…' : 'Arquivar'}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Inline price cell ────────────────────────────────────────────────────────

function PriceCell({
  productId,
  priceCents,
  currency,
  maxInstallments,
  isSubscription,
}: {
  productId: string;
  priceCents: number;
  currency: string;
  maxInstallments: number;
  isSubscription: boolean;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const update = trpc.products.update.useMutation({
    onSuccess: () => {
      utils.products.list.invalidate();
      toast.success('Preço atualizado');
      setEditing(false);
    },
    onError: (err) => toast.error(err.message),
  });

  if (isSubscription) {
    return <span className="text-[13px] text-[var(--color-fg-muted)] italic">Ver planos</span>;
  }

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setVal((priceCents / 100).toFixed(2).replace('.', ','));
    setEditing(true);
    window.setTimeout(() => inputRef.current?.select(), 30);
  };

  const save = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const cents = parseCentsBRL(val);
    if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000) {
      toast.error('Preço inválido');
      setEditing(false);
      return;
    }
    update.mutate({ id: productId, priceCents: cents, maxInstallments });
  };

  const cancel = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditing(false);
  };

  if (editing) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard; the editable input inside owns keyboard handlers (Enter/Escape).
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <div className="relative">
          <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 text-[12px] text-[var(--color-fg-subtle)]">
            R$
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }}
            onBlur={() => save()}
            className="w-24 rounded-lg border border-[var(--color-brand-500)] bg-[var(--color-surface)] py-1.5 pr-2 pl-8 text-[13px] text-[var(--color-fg)] outline-none ring-2 ring-[var(--color-brand-500)]/20"
            disabled={update.isPending}
          />
        </div>
        {update.isPending && (
          <span className="text-[11px] text-[var(--color-fg-subtle)]">Salvando…</span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      title="Clique para editar o preço"
      className="group flex flex-col items-start gap-0.5 text-left"
    >
      <span className="font-medium text-[var(--color-fg)] transition group-hover:text-[var(--color-brand-600)]">
        {formatCents(priceCents, currency as Currency)}
      </span>
      <span className="text-[11px] text-[var(--color-fg-subtle)]">
        em até {maxInstallments}×{' '}
        <span className="text-[var(--color-brand-600)] opacity-0 transition group-hover:opacity-100">
          · editar
        </span>
      </span>
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProdutosPage() {
  const router = useRouter();
  const list = trpc.products.list.useQuery(undefined, { staleTime: 15_000 });
  const archive = trpc.products.archive.useMutation({
    onSuccess: () => {
      list.refetch();
      toast.success('Produto arquivado');
    },
    onError: (err) => toast.error(err.message),
  });
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);

  if (list.isPending) {
    return (
      <div className="flex flex-col gap-8">
        <header className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-3">
            <Kicker>catálogo</Kicker>
            <Heading level={1}>Seus produtos</Heading>
          </div>
        </header>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full min-w-[700px] text-[14px]">
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
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </tbody>
          </table>
        </div>
      </div>
    );
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
    <>
      <AnimatePresence>
        {archiveTarget && (
          <ArchiveModal
            name={archiveTarget.name}
            loading={archive.isPending}
            onConfirm={() => {
              archive.mutate({ id: archiveTarget.id });
              setArchiveTarget(null);
            }}
            onCancel={() => setArchiveTarget(null)}
          />
        )}
      </AnimatePresence>

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

        <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full min-w-[700px] text-[14px]">
            <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              <tr>
                <th className="px-5 py-3 font-semibold">Produto</th>
                <th className="px-5 py-3 font-semibold">
                  Preço{' '}
                  <span className="text-[10px] normal-case tracking-normal opacity-60">
                    (clique pra editar)
                  </span>
                </th>
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
                  // biome-ignore lint/a11y/useKeyWithClickEvents: convenience handler — the explicit "Editar" button in the row is the keyboard-accessible path.
                  <tr
                    key={product.id}
                    className="cursor-pointer transition hover:bg-[var(--color-surface-muted)]/50"
                    onClick={() => router.push(`/produtos/${product.id}`)}
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
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard so row navigation doesn't trigger when buyer interacts with the price cell. */}
                    <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                      <PriceCell
                        productId={product.id}
                        priceCents={product.priceCents}
                        currency={product.currency}
                        maxInstallments={product.maxInstallments}
                        isSubscription={product.isSubscription}
                      />
                    </td>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard; real link + Copy button inside are keyboard-accessible. */}
                    <td
                      className="px-5 py-4 text-[12px] text-[var(--color-fg-muted)]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center">
                        <a
                          href={publicUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-brand-600)]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {checkoutHostLabel}
                        </a>
                        <CopyButton text={publicUrl} />
                      </div>
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
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard; real buttons inside handle keyboard. */}
                      <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
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
                          onClick={() => setArchiveTarget({ id: product.id, name: product.name })}
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
    </>
  );
}
