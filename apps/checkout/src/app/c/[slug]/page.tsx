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
 * Layout: a 3-column responsive grid that mirrors Lizzon's
 * conversion flow:
 *   1. Identificação  (buyer fields, "Continuar" CTA)
 *   2. Pagamento      (method tabs + method-specific fields; locked
 *                     until Identificação is valid)
 *   3. Resumo         (product card + totals; always visible)
 *
 * The right column on mobile collapses below the form so the buyer
 * always sees the price within a thumb-scroll.
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

  const [step, setStep] = useState<'identify' | 'pay'>('identify');
  const [method, setMethod] = useState<Method>('pix');
  const [installments, setInstallments] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [card, setCard] = useState({ number: '', expiry: '', cvc: '' });

  const createOrder = trpc.checkout.createOrder.useMutation();

  const formattedTotal = useMemo(
    () => formatCents(product.priceCents, product.currency),
    [product.priceCents, product.currency],
  );
  const perInstallment = useMemo(() => {
    if (product.maxInstallments < 2) return null;
    return formatCents(
      Math.ceil(product.priceCents / product.maxInstallments),
      product.currency,
    );
  }, [product.maxInstallments, product.currency, product.priceCents]);

  const identifyComplete =
    name.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    doc.replace(/\D+/g, '').length >= 11 &&
    phone.trim().length >= 10;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifyComplete) {
      setStep('identify');
      return;
    }
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
          status={createOrder.data.status}
        />
      </CenteredCard>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg)]">
      {/* Producer header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            {workspace.brandLogoUrl ? (
              // biome-ignore lint/performance/noImgElement: producer logo, remote, no optimization gain.
              <img
                src={workspace.brandLogoUrl}
                alt={workspace.name}
                className="h-9 w-9 rounded-xl object-cover"
              />
            ) : (
              <span
                className="grid h-9 w-9 place-items-center rounded-xl text-[14px] font-semibold text-white"
                style={{ backgroundColor: BRAND_GREEN }}
              >
                {(workspace.name[0] ?? 'p').toUpperCase()}
              </span>
            )}
            <div className="flex flex-col leading-tight">
              <span className="text-[14px] font-semibold text-[var(--color-fg)]">
                {workspace.name}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                Checkout seguro
              </span>
            </div>
          </div>
          <p className="hidden text-[11px] text-[var(--color-fg-subtle)] sm:block">
            🔒 Conexão criptografada · processado por payunivercart
          </p>
        </div>
      </header>

      <form onSubmit={onSubmit} className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {/* ---------- Step 1 — Identificação ---------- */}
          <section
            className={clsx(
              'flex flex-col gap-5 rounded-2xl border bg-[var(--color-surface)] p-5 transition',
              step === 'identify'
                ? 'border-[var(--color-success)] shadow-[0_0_0_3px_rgba(0,135,90,0.08)]'
                : 'border-[var(--color-border)]',
            )}
          >
            <StepHeader number="1" active={step === 'identify'} done={identifyComplete && step !== 'identify'}>
              Identificação
            </StepHeader>

            <div className="flex flex-col gap-4">
              <Field label="Nome completo">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Como aparece no documento"
                  className={inputClass}
                  autoComplete="name"
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@empresa.com"
                  className={inputClass}
                  autoComplete="email"
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
                <Field label="CPF / CNPJ">
                  <input
                    type="text"
                    value={doc}
                    onChange={(e) => setDoc(e.target.value)}
                    placeholder="000.000.000-00"
                    inputMode="numeric"
                    className={inputClass}
                  />
                </Field>
                <Field label="Telefone">
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(11) 91234-5678"
                    inputMode="tel"
                    className={inputClass}
                    autoComplete="tel"
                  />
                </Field>
              </div>
              <p className="-mt-1 text-[11px] leading-[1.5] text-[var(--color-fg-subtle)]">
                Usaremos seu telefone pra mandar o acesso no WhatsApp.
              </p>
            </div>

            {step === 'identify' ? (
              <button
                type="button"
                onClick={() => identifyComplete && setStep('pay')}
                disabled={!identifyComplete}
                className={clsx(
                  'mt-1 inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-[14px] font-semibold transition',
                  identifyComplete
                    ? 'bg-[var(--color-success)] text-white shadow-[0_8px_20px_-12px_rgba(0,135,90,0.55)] hover:brightness-105'
                    : 'cursor-not-allowed bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
                )}
              >
                Ir para o pagamento →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep('identify')}
                className="self-start text-[12px] font-medium text-[var(--color-success)] hover:underline"
              >
                Editar dados
              </button>
            )}
          </section>

          {/* ---------- Step 2 — Pagamento ---------- */}
          <section
            className={clsx(
              'flex flex-col gap-5 rounded-2xl border bg-[var(--color-surface)] p-5 transition',
              step === 'pay'
                ? 'border-[var(--color-success)] shadow-[0_0_0_3px_rgba(0,135,90,0.08)]'
                : 'border-[var(--color-border)]',
            )}
          >
            <StepHeader number="2" active={step === 'pay'} done={false}>
              Pagamento
            </StepHeader>

            {step !== 'pay' ? (
              <p className="text-[13px] leading-[1.55] text-[var(--color-fg-subtle)]">
                Complete seus dados de identificação para continuar.
              </p>
            ) : (
              <>
                <fieldset>
                  <legend className="sr-only">Forma de pagamento</legend>
                  <div className="grid grid-cols-3 gap-2 rounded-xl bg-[var(--color-surface-muted)] p-1">
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

                {method === 'pix' ? (
                  <p className="text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
                    Você vai receber um QR-code para pagar no app do seu banco. Aprovação em
                    segundos.
                  </p>
                ) : null}

                {method === 'boleto' ? (
                  <p className="text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
                    O boleto leva até 2 dias úteis para compensar. Indicado para quem não usa Pix.
                  </p>
                ) : null}

                {method === 'credit_card' ? (
                  <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-4">
                    <Field label="Número do cartão">
                      <input
                        type="text"
                        value={card.number}
                        onChange={(e) => setCard({ ...card, number: e.target.value })}
                        placeholder="0000 0000 0000 0000"
                        inputMode="numeric"
                        autoComplete="cc-number"
                        className={inputClass}
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Validade (MM/AA)">
                        <input
                          type="text"
                          value={card.expiry}
                          onChange={(e) => setCard({ ...card, expiry: e.target.value })}
                          placeholder="12/30"
                          autoComplete="cc-exp"
                          className={inputClass}
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
                        />
                      </Field>
                    </div>
                    {product.maxInstallments > 1 ? (
                      <Field label="Parcelas">
                        <select
                          value={installments}
                          onChange={(e) => setInstallments(Number.parseInt(e.target.value, 10))}
                          className={clsx(inputClass, 'appearance-none')}
                        >
                          {Array.from({ length: product.maxInstallments }, (_, i) => i + 1).map(
                            (n) => (
                              <option key={n} value={n}>
                                {n === 1
                                  ? `1× — ${formattedTotal}`
                                  : `${n}× — ${formatCents(Math.ceil(product.priceCents / n), product.currency)} sem juros`}
                              </option>
                            ),
                          )}
                        </select>
                      </Field>
                    ) : null}
                  </div>
                ) : null}

                {createOrder.error ? (
                  <p className="rounded-xl border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-4 py-3 text-[12px] leading-[1.5] text-[var(--color-danger)]">
                    {createOrder.error.message}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={createOrder.isPending}
                  className="inline-flex w-full items-center justify-center rounded-full bg-[var(--color-success)] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_8px_20px_-12px_rgba(0,135,90,0.55)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createOrder.isPending ? 'Processando…' : METHOD_CTA[method]}
                </button>
              </>
            )}
          </section>

          {/* ---------- Resumo ---------- */}
          <aside className="md:row-span-2">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <p className="text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                Resumo do pedido
              </p>

              <div className="mt-4 flex items-start gap-3 border-y border-[var(--color-border)] py-4">
                {product.coverImageUrl ? (
                  // biome-ignore lint/performance/noImgElement: producer-supplied URL.
                  <img
                    src={product.coverImageUrl}
                    alt={product.name}
                    className="h-16 w-16 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <span
                    className="grid h-16 w-16 shrink-0 place-items-center rounded-xl text-[18px] font-semibold text-white"
                    style={{ backgroundColor: BRAND_GREEN }}
                  >
                    {(product.name[0] ?? '·').toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold leading-tight text-[var(--color-fg)]">
                    {product.name}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">Quantidade: 1</p>
                </div>
                <p className="shrink-0 text-[13px] font-semibold text-[var(--color-fg)]">
                  {formattedTotal}
                </p>
              </div>

              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--color-fg-muted)]">Subtotal (1 produto)</dt>
                  <dd className="font-medium text-[var(--color-fg)]">{formattedTotal}</dd>
                </div>
                {product.type === 'physical' ? (
                  <div className="flex items-baseline justify-between">
                    <dt className="text-[var(--color-fg-muted)]">Frete</dt>
                    <dd className="italic text-[var(--color-fg-muted)]">a calcular</dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-4 flex items-baseline justify-between border-t border-[var(--color-border)] pt-4">
                <span className="text-[12px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                  Total
                </span>
                <div className="flex flex-col items-end">
                  <span className="display text-[24px] font-semibold leading-none text-[var(--color-fg)]">
                    {formattedTotal}
                  </span>
                  {product.maxInstallments > 1 && perInstallment ? (
                    <span className="mt-1 text-[11px] text-[var(--color-success)]">
                      até {product.maxInstallments}× de {perInstallment} sem juros
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[11px] text-[var(--color-fg-subtle)]">
              <div className="flex items-center gap-2">
                <span>🔒</span>
                <span>
                  Seus dados trafegam por HTTPS e ficam armazenados em servidores no Brasil.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-[var(--color-fg-muted)]">Formas aceitas:</span>
                <PaymentBadge>Pix</PaymentBadge>
                <PaymentBadge>Visa</PaymentBadge>
                <PaymentBadge>MC</PaymentBadge>
                <PaymentBadge>Amex</PaymentBadge>
                <PaymentBadge>Elo</PaymentBadge>
                <PaymentBadge>Boleto</PaymentBadge>
              </div>
            </div>
          </aside>
        </div>
      </form>

      <footer className="mt-8 border-t border-[var(--color-border)] bg-[var(--color-surface)]/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-1 px-4 py-5 text-center text-[11px] text-[var(--color-fg-subtle)] sm:px-6">
          <p>
            Pagamento processado por <strong>payunivercart</strong>. Ao confirmar, você concorda
            com os termos e a política de privacidade do produtor.
          </p>
          <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Presentational primitives                                                  */
/* -------------------------------------------------------------------------- */

const BRAND_GREEN = '#00875a';

function StepHeader({
  number,
  active,
  done,
  children,
}: {
  number: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  const tone = done
    ? 'bg-[var(--color-success)] text-white'
    : active
    ? 'bg-[var(--color-success)] text-white'
    : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]';
  return (
    <div className="flex items-center gap-3">
      <span
        className={clsx(
          'grid h-7 w-7 place-items-center rounded-full text-[12px] font-semibold transition',
          tone,
        )}
      >
        {done ? '✓' : number}
      </span>
      <h2
        className={clsx(
          'text-[15px] font-semibold',
          active || done ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        {children}
      </h2>
    </div>
  );
}

function PaymentBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function CenteredCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <div
        className={clsx(
          'w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm',
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
  status,
}: {
  reference: string;
  methodLabel: string;
  formattedTotal: string;
  buyerEmail: string;
  pixQrCodeImage: string | null;
  pixCopyPaste: string | null;
  pixExpiresAt: Date | string | null;
  gatewayConfigured: boolean;
  status: string;
}) {
  const isPaid = status === 'paid';
  const hasPix = !!(pixQrCodeImage || pixCopyPaste);
  const kicker = isPaid ? 'Pagamento aprovado' : hasPix ? 'Pix gerado' : 'Pedido criado';
  const headline = isPaid
    ? 'Compra confirmada!'
    : hasPix
    ? 'Pague com Pix em segundos.'
    : 'Recebemos sua compra.';
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-success)]">
        {kicker}
      </p>
      <h1 className="display mt-3 text-[26px] font-semibold text-[var(--color-fg)]">
        {headline}
      </h1>

      {isPaid ? (
        <p className="mt-3 text-[14px] leading-[1.55] text-[var(--color-fg-muted)]">
          Pagamento aprovado pelo {methodLabel.toLowerCase()}. Em alguns minutos você recebe os
          dados de acesso em <strong>{buyerEmail}</strong> e no seu WhatsApp.
        </p>
      ) : hasPix ? (
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

/* -------------------------------------------------------------------------- */
/* Field + input shared classes                                               */
/* -------------------------------------------------------------------------- */

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
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-3.5 py-2.5 text-[14px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-success)] focus:ring-4 focus:ring-[rgba(0,135,90,0.12)]';
