'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import clsx from 'clsx';
import { use, useMemo, useState } from 'react';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

type CheckoutData = inferRouterOutputs<AppRouter>['checkout']['getBySlug'];

/**
 * Public checkout — `/c/<slug>`.
 *
 * Layout: single column, centered card on light background. Mirrors
 * the Stripe / Apple Pay / Shopify Pay pattern that buyers are
 * trained on. Brand color (when the workspace has one set) tints the
 * primary CTA so the producer's identity shows without overpowering
 * trust signals.
 *
 * Submission posts to tRPC `checkout.createOrder`. On success we
 * render an "order received" state with the public reference. Real
 * Pix/cartão/boleto payloads land with Block 22's gateway wire-up.
 */

type Method = 'pix' | 'credit_card' | 'boleto';

const METHOD_LABELS: Record<Method, string> = {
  pix: 'Pix',
  credit_card: 'Cartão',
  boleto: 'Boleto',
};

const METHOD_CTA: Record<Method, string> = {
  pix: 'Gerar QR-code Pix',
  credit_card: 'Pagar com cartão',
  boleto: 'Gerar boleto',
};

export default function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const product = trpc.checkout.getBySlug.useQuery({ slug });

  if (product.isPending) {
    return <CenteredCard><Skeleton /></CenteredCard>;
  }
  if (product.error) {
    return (
      <CenteredCard>
        <ErrorView
          title="Produto indisponível."
          body={
            product.error.data?.code === 'NOT_FOUND'
              ? 'Este link de checkout não está mais ativo. Verifique com o produtor se a oferta segue de pé.'
              : 'Não conseguimos carregar o checkout. Tenta novamente em alguns instantes.'
          }
        />
      </CenteredCard>
    );
  }

  return <CheckoutView slug={slug} data={product.data} />;
}

function CheckoutView({ slug, data }: { slug: string; data: CheckoutData }) {
  const { product, workspace } = data;
  const brand = workspace.brandPrimaryColor ?? '#f97316';

  const [method, setMethod] = useState<Method>('pix');
  const [installments, setInstallments] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [card, setCard] = useState({ number: '', expiry: '', cvc: '' });

  const createOrder = trpc.checkout.createOrder.useMutation();

  const ctaLabel = METHOD_CTA[method];

  const formattedTotal = useMemo(
    () => formatCents(product.priceCents, product.currency),
    [product.priceCents, product.currency],
  );

  // Per-installment price preview (no interest in the stub; real
  // installment math lands with the gateway in Block 22).
  const perInstallment = useMemo(() => {
    if (method !== 'credit_card' || installments <= 1) return null;
    return formatCents(Math.ceil(product.priceCents / installments), product.currency);
  }, [installments, method, product.currency, product.priceCents]);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createOrder.mutate({
      slug,
      method,
      installments: method === 'credit_card' ? installments : undefined,
      buyer: {
        name: name.trim(),
        email: email.trim(),
        document: doc,
        phone,
      },
      card:
        method === 'credit_card'
          ? {
              number: card.number,
              expiry: card.expiry,
              cvc: card.cvc,
              holderName: name.trim() || 'APRO',
            }
          : undefined,
    });
  };

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          reference={createOrder.data.publicReference}
          methodLabel={METHOD_LABELS[createOrder.data.method as Method]}
          formattedTotal={formattedTotal}
          buyerEmail={email.trim()}
          pixQrCodeImage={createOrder.data.pixQrCodeImage}
          pixCopyPaste={createOrder.data.pixCopyPaste}
          pixExpiresAt={createOrder.data.pixExpiresAt}
          gatewayConfigured={createOrder.data.gatewayConfigured}
        />
      </CenteredCard>
    );
  }

  return (
    <main className="min-h-screen px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {/* Producer header */}
        <header className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-3">
            {workspace.brandLogoUrl ? (
              // Producer-supplied logo. We do NOT render arbitrary HTML
              // and the URL goes through the api's content-validated
              // brand_logo_url column — safe to embed.
              // biome-ignore lint/performance/noImgElement: producer logos are tiny + remote, optimization adds friction.
              <img
                src={workspace.brandLogoUrl}
                alt={workspace.name}
                className="h-9 w-9 rounded-xl object-cover"
              />
            ) : (
              <span
                className="grid h-9 w-9 place-items-center rounded-xl text-[14px] font-semibold text-white"
                style={{ backgroundColor: brand }}
              >
                {(workspace.name[0] ?? 'p').toUpperCase()}
              </span>
            )}
            <div className="flex flex-col leading-tight">
              <span className="text-[14px] font-semibold text-[var(--color-fg)]">
                {workspace.name}
              </span>
              <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                Checkout seguro
              </span>
            </div>
          </div>
          <p className="hidden text-[11px] text-[var(--color-fg-subtle)] sm:block">
            🔒 Conexão criptografada · payunivercart
          </p>
        </header>

        {/* Product summary */}
        <section className="surface px-6 py-7">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-brand-600)]">
            Resumo do pedido
          </p>
          <h1 className="display mt-3 text-[26px] font-semibold leading-tight text-[var(--color-fg)] sm:text-[30px]">
            {product.name}
          </h1>
          {product.description ? (
            <p className="mt-3 text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
              {product.description}
            </p>
          ) : null}
          <div className="mt-6 flex items-baseline gap-3 border-t border-[var(--color-border)] pt-5">
            <span className="display text-[34px] font-semibold leading-none text-[var(--color-fg)]">
              {formattedTotal}
            </span>
            {product.maxInstallments > 1 ? (
              <span className="text-[13px] text-[var(--color-fg-subtle)]">
                em até {product.maxInstallments}× no cartão
              </span>
            ) : (
              <span className="text-[13px] text-[var(--color-fg-subtle)]">à vista</span>
            )}
          </div>
        </section>

        {/* Form */}
        <form className="surface px-6 py-7" onSubmit={onSubmit}>
          {/* Method tabs */}
          <fieldset>
            <legend className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
              Forma de pagamento
            </legend>
            <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-[var(--color-surface-muted)] p-1">
              {(['pix', 'credit_card', 'boleto'] as Method[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={clsx(
                    'rounded-lg px-3 py-2 text-[13px] font-medium transition',
                    method === m
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                  )}
                >
                  {METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Buyer fields */}
          <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nome completo" className="sm:col-span-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como aparece no documento"
                className={inputClass}
                autoComplete="name"
                required
              />
            </Field>
            <Field label="Email" className="sm:col-span-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@empresa.com"
                className={inputClass}
                autoComplete="email"
                required
              />
            </Field>
            <Field label="CPF ou CNPJ">
              <input
                type="text"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                placeholder="000.000.000-00"
                inputMode="numeric"
                className={inputClass}
                required
              />
            </Field>
            <Field label="Telefone (WhatsApp)">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(11) 91234-5678"
                inputMode="tel"
                className={inputClass}
                autoComplete="tel"
                required
              />
            </Field>
          </div>

          {/* Method-specific extras */}
          {method === 'credit_card' ? (
            <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                Dados do cartão
              </p>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Número do cartão" className="sm:col-span-2">
                  <input
                    type="text"
                    value={card.number}
                    onChange={(e) => setCard({ ...card, number: e.target.value })}
                    placeholder="0000 0000 0000 0000"
                    inputMode="numeric"
                    autoComplete="cc-number"
                    className={inputClass}
                    required
                  />
                </Field>
                <Field label="Validade (MM/AA)">
                  <input
                    type="text"
                    value={card.expiry}
                    onChange={(e) => setCard({ ...card, expiry: e.target.value })}
                    placeholder="12/30"
                    autoComplete="cc-exp"
                    className={inputClass}
                    required
                  />
                </Field>
                <Field label="CVV">
                  <input
                    type="text"
                    value={card.cvc}
                    onChange={(e) => setCard({ ...card, cvc: e.target.value })}
                    placeholder="000"
                    inputMode="numeric"
                    autoComplete="cc-csc"
                    className={inputClass}
                    required
                  />
                </Field>
              </div>
              {product.maxInstallments > 1 ? (
                <Field label="Parcelas" className="mt-4">
                  <select
                    value={installments}
                    onChange={(e) => setInstallments(Number.parseInt(e.target.value, 10))}
                    className={clsx(inputClass, 'appearance-none')}
                  >
                    {Array.from({ length: product.maxInstallments }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n === 1
                          ? `1× (à vista) — ${formattedTotal}`
                          : `${n}× — ${formatCents(Math.ceil(product.priceCents / n), product.currency)}/parcela`}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {perInstallment ? (
                <p className="mt-2 text-[12px] text-[var(--color-fg-subtle)]">
                  Sem juros pela plataforma. Confirme as taxas com a operadora do seu cartão.
                </p>
              ) : null}
            </div>
          ) : null}

          {createOrder.error ? (
            <p className="mt-4 rounded-xl border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)]">
              {createOrder.error.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={createOrder.isPending}
            className="mt-6 w-full rounded-full px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_20px_-12px_rgba(234,88,12,0.55)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: brand }}
          >
            {createOrder.isPending ? 'Processando…' : ctaLabel}
          </button>
        </form>

        <p className="px-1 text-center text-[11px] leading-[1.5] text-[var(--color-fg-subtle)]">
          Pagamento processado por <strong>payunivercart</strong>. Ao confirmar, você concorda com
          os termos e a política de privacidade do produtor.
        </p>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tiny presentational helpers                                                */
/* -------------------------------------------------------------------------- */

function CenteredCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <div
        className={clsx(
          'surface w-full',
          wide ? 'max-w-xl px-6 py-10' : 'max-w-md px-6 py-10',
        )}
      >
        {children}
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3">
      <div className="h-3 w-20 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="h-8 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="h-3 w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="h-32 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
    </div>
  );
}

function ErrorView({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-danger)]">
        Erro
      </p>
      <h1 className="display mt-3 text-[24px] font-semibold text-[var(--color-fg)]">{title}</h1>
      <p className="mt-3 text-[14px] leading-[1.55] text-[var(--color-fg-muted)]">{body}</p>
    </div>
  );
}

function SuccessView({
  reference,
  methodLabel,
  formattedTotal,
  buyerEmail,
  pixQrCodeImage,
  pixCopyPaste,
  pixExpiresAt,
  gatewayConfigured,
}: {
  reference: string;
  methodLabel: string;
  formattedTotal: string;
  buyerEmail: string;
  pixQrCodeImage: string | null;
  pixCopyPaste: string | null;
  pixExpiresAt: Date | string | null;
  gatewayConfigured: boolean;
}) {
  const hasPix = !!(pixQrCodeImage || pixCopyPaste);
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-success)]">
        {hasPix ? 'Pix gerado' : 'Pedido criado'}
      </p>
      <h1 className="display mt-3 text-[26px] font-semibold text-[var(--color-fg)]">
        {hasPix ? 'Pague com Pix em segundos.' : 'Recebemos sua compra.'}
      </h1>

      {hasPix ? (
        <>
          <p className="mt-3 text-[14px] leading-[1.55] text-[var(--color-fg-muted)]">
            Escaneie o QR-code com o app do seu banco ou copie o código abaixo. Assim que a gente
            receber a confirmação do Pix, mandamos o acesso em <strong>{buyerEmail}</strong> e no
            seu WhatsApp.
          </p>

          {pixQrCodeImage ? (
            <div className="mt-6 flex justify-center">
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm">
                {/** biome-ignore lint/performance/noImgElement: data URI base64 from gateway. */}
                <img
                  src={`data:image/png;base64,${pixQrCodeImage}`}
                  alt="QR-code Pix"
                  className="h-56 w-56"
                />
              </div>
            </div>
          ) : null}

          {pixCopyPaste ? <PixCopyButton code={pixCopyPaste} /> : null}

          {pixExpiresAt ? (
            <p className="mt-4 text-center text-[12px] text-[var(--color-fg-subtle)]">
              Pague até {formatExpiresAt(pixExpiresAt)} para garantir o pedido.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-[14px] leading-[1.55] text-[var(--color-fg-muted)]">
          {gatewayConfigured
            ? `Estamos gerando seu ${methodLabel.toLowerCase()} agora. Em alguns instantes você receberá as instruções em ${buyerEmail} e no seu WhatsApp.`
            : `Seu pedido foi registrado. O produtor está finalizando a integração com o gateway de pagamento — você receberá as instruções de pagamento em ${buyerEmail} assim que a configuração concluir.`}
        </p>
      )}

      <dl className="mt-6 space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-5 text-[13px]">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-fg-subtle)]">Código do pedido</dt>
          <dd className="font-mono font-medium text-[var(--color-fg)]">{reference}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-fg-subtle)]">Método</dt>
          <dd className="font-medium text-[var(--color-fg)]">{methodLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-fg-subtle)]">Valor</dt>
          <dd className="font-semibold text-[var(--color-fg)]">{formattedTotal}</dd>
        </div>
      </dl>

      <p className="mt-6 text-center text-[11px] text-[var(--color-fg-subtle)]">
        Guarde o código do pedido — você pode usá-lo para tirar dúvidas com o produtor.
      </p>
    </div>
  );
}

function PixCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (insecure context or denied) — fall
      // back to a manual select via a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };
  return (
    <div className="mt-5 flex flex-col gap-2">
      <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        Pix copia e cola
      </span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-hidden truncate rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3 text-[12px] font-mono text-[var(--color-fg-muted)]">
          {code}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-xl bg-[var(--color-fg)] px-5 text-[13px] font-semibold text-white transition hover:bg-black"
        >
          {copied ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function formatExpiresAt(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={clsx('flex flex-col gap-2', className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';
