'use client';

import { useState } from 'react';

/**
 * Resumo do pedido colapsável — renderizado SÓ no mobile (`lg:hidden`), no topo
 * do checkout. Colapsado por padrão mostrando "Resumo do pedido" + total; toca
 * pra expandir o produto/parcelamento. No desktop o resumo completo segue na
 * coluna direita (este componente fica escondido).
 *
 * 100% themeável: usa as CSS vars (`--ink-*`, `--hairline`, `glass-card`) que já
 * têm valores pra dark e light — compatível com os dois temas sem código extra.
 */
export function MobileSummaryAccordion({
  productName,
  coverImageUrl,
  total,
  originalTotal,
  perInstallment,
  maxInstallments,
  brandTone,
  className,
}: {
  productName: string;
  coverImageUrl?: string | null;
  total: string;
  /**
   * Preço de tabela riscado ao lado do total, quando o cronômetro de
   * escassez já concedeu o desconto de última chance. NULL na esmagadora
   * maioria dos pedidos. Sem isto o mobile mostraria só o valor menor —
   * honesto, mas sem a única informação que explica por que ele mudou.
   */
  originalTotal?: string | null;
  perInstallment?: string | null;
  maxInstallments?: number;
  brandTone?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const showInstallments = (maxInstallments ?? 0) > 1 && Boolean(perInstallment);

  return (
    <div className={`glass-card overflow-hidden ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
            Resumo do pedido
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`text-[var(--ink-50)] transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <title>Alternar resumo</title>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          {originalTotal ? (
            <span className="text-[12px] text-[var(--ink-50)] tabular-nums line-through">
              {originalTotal}
            </span>
          ) : null}
          <span className="font-semibold text-[16px] text-[var(--ink-100)] tabular-nums">
            {total}
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-[var(--hairline)] border-t px-4 py-4">
          <div className="flex items-start gap-3">
            {coverImageUrl ? (
              <img
                src={coverImageUrl}
                alt={productName}
                className="h-14 w-14 shrink-0 rounded-2xl object-cover"
              />
            ) : (
              <span
                className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl font-semibold text-[16px] text-white"
                style={{
                  background:
                    brandTone ?? 'linear-gradient(135deg, var(--dop-400) 0%, var(--dop-600) 100%)',
                }}
              >
                {(productName[0] ?? '·').toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-[14px] text-[var(--ink-100)] leading-tight">
                {productName}
              </p>
              <p className="mt-1 text-[12px] text-[var(--ink-50)]">Quantidade: 1</p>
            </div>
            <p className="flex shrink-0 flex-col items-end gap-0.5">
              {originalTotal ? (
                <span className="text-[11px] text-[var(--ink-50)] tabular-nums line-through">
                  {originalTotal}
                </span>
              ) : null}
              <span className="font-semibold text-[14px] text-[var(--ink-100)] tabular-nums">
                {total}
              </span>
            </p>
          </div>
          {showInstallments ? (
            <p className="mt-3 text-right font-medium text-[12px] text-[var(--dop-600)]">
              até {maxInstallments}× de {perInstallment} sem juros
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
