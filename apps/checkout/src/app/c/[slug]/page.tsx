'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import clsx from 'clsx';
import { use, useMemo, useState } from 'react';
import {
  maskBrPhone,
  maskCardExpiry,
  maskCardNumber,
  maskCpfCnpj,
  maskDigits,
  unmaskDigits,
} from '../../../lib/masks';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

type CheckoutData = inferRouterOutputs<AppRouter>['checkout']['getBySlug'];

/**
 * Public checkout — `/c/<slug>`.
 *
 * Lizzon-tier 2-step glass UI. Identificação → Pagamento, with a
 * permanent order summary on the right. Dopamine green accent
 * (--dop-*) for active state, glass-card surfaces, masked inputs.
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
    return (
      <CenteredCard>
        <Skeleton />
      </CenteredCard>
    );
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
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  /**
   * Cardholder name shown on the card. BR-default convention is to
   * collect this explicitly rather than reuse the identification name —
   * many buyers pay with a card issued in someone else's name (a
   * parent's, a partner's, the company's). Defaults to the identification
   * name so the buyer doesn't have to retype when both match.
   */
  const [cardHolder, setCardHolder] = useState('');

  const createOrder = trpc.checkout.createOrder.useMutation();

  const formattedTotal = useMemo(
    () => formatCents(product.priceCents, product.currency),
    [product.priceCents, product.currency],
  );

  const perInstallment = useMemo(() => {
    if (product.maxInstallments < 2) return null;
    return formatCents(Math.ceil(product.priceCents / product.maxInstallments), product.currency);
  }, [product.maxInstallments, product.currency, product.priceCents]);

  const docDigits = unmaskDigits(doc);
  const phoneDigits = unmaskDigits(phone);
  const cardDigits = unmaskDigits(cardNumber);
  const expiryDigits = unmaskDigits(cardExpiry);

  const identifyComplete =
    name.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (docDigits.length === 11 || docDigits.length === 14) &&
    phoneDigits.length >= 10;

  const trimmedHolder = cardHolder.trim() || name.trim();
  const cardComplete =
    method !== 'credit_card' ||
    (cardDigits.length >= 13 &&
      expiryDigits.length === 4 &&
      cardCvc.length >= 3 &&
      trimmedHolder.length >= 2);

  const submitDisabled = !identifyComplete || !cardComplete || createOrder.isPending;

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
              number: cardNumber,
              expiry: cardExpiry,
              cvc: cardCvc,
              holderName: trimmedHolder || 'APRO',
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

  const brandTone = workspace.brandPrimaryColor;

  // When the producer set a brand color in Configurações → Marca,
  // override the dopamine palette so every CTA, focus ring, and pill
  // picks up their identity. We override the THREE stops the checkout
  // CSS uses (-400 -500 -600) — `derivedFromBrand` darkens the user
  // hex by ~10% for the gradient endpoint and lightens by ~10% for the
  // start, keeping the "premium dopamine gradient" feel.
  const brandPalette = brandTone ? deriveBrandPalette(brandTone) : null;

  return (
    <main
      className="min-h-screen"
      style={
        brandPalette
          ? ({
              '--dop-400': brandPalette.light,
              '--dop-500': brandPalette.mid,
              '--dop-600': brandPalette.dark,
              '--dop-soft': `${brandPalette.mid}10`,
              '--dop-glow': `${brandPalette.mid}38`,
              '--dop-hairline': `${brandPalette.mid}38`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <ProducerHeader workspace={workspace} brandTone={brandTone} />

      <form onSubmit={onSubmit} className="container-x mx-auto w-full max-w-[1180px] py-6 sm:py-10">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr] lg:gap-7">
          {/* ---------- Left column: steps ---------- */}
          <div className="flex flex-col gap-4">
            <StepCard
              num={1}
              label="Identificação"
              active={step === 'identify'}
              done={step === 'pay' && identifyComplete}
              onEdit={step === 'pay' ? () => setStep('identify') : undefined}
            >
              {step === 'identify' ? (
                <div className="flex flex-col gap-3">
                  <Field label="Nome completo">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Como aparece no documento"
                      autoComplete="name"
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="voce@empresa.com"
                      autoComplete="email"
                      inputMode="email"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="CPF / CNPJ">
                      <input
                        type="text"
                        value={doc}
                        onChange={(e) => setDoc(maskCpfCnpj(e.target.value))}
                        placeholder="000.000.000-00"
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label="Telefone">
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(maskBrPhone(e.target.value))}
                        placeholder="(11) 91234-5678"
                        inputMode="tel"
                        autoComplete="tel"
                      />
                    </Field>
                  </div>
                  <p className="text-[11px] text-[var(--ink-50)] leading-[1.45]">
                    Usaremos seu telefone para enviar o acesso por WhatsApp.
                  </p>
                  <button
                    type="button"
                    onClick={() => identifyComplete && setStep('pay')}
                    disabled={!identifyComplete}
                    className="btn btn-primary mt-2 w-full text-[15px]"
                  >
                    Ir para o pagamento →
                  </button>
                </div>
              ) : (
                <div className="space-y-1 text-[13px] text-[var(--ink-70)]">
                  <p className="text-[var(--ink-90)]">{name}</p>
                  <p>{email}</p>
                  <p>
                    {doc} · {phone}
                  </p>
                </div>
              )}
            </StepCard>

            <StepCard
              num={2}
              label="Pagamento"
              active={step === 'pay'}
              done={false}
              locked={step !== 'pay'}
            >
              {step !== 'pay' ? (
                <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                  Complete seus dados de identificação para continuar.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  <MethodTabs current={method} onChange={setMethod} />

                  {method === 'pix' ? (
                    <p className="text-[13px] text-[var(--ink-70)] leading-[1.55]">
                      Você vai receber um QR-code para pagar no app do seu banco. Aprovação em
                      segundos.
                    </p>
                  ) : null}

                  {method === 'boleto' ? (
                    <p className="text-[13px] text-[var(--ink-70)] leading-[1.55]">
                      O boleto leva até 2 dias úteis para compensar. Indicado para quem não usa Pix.
                    </p>
                  ) : null}

                  {method === 'credit_card' ? (
                    <div className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-1)] p-4">
                      <Field label="Nome impresso no cartão">
                        <input
                          type="text"
                          value={cardHolder}
                          onChange={(e) => setCardHolder(e.target.value.toUpperCase())}
                          placeholder={(name.trim() || 'COMO APARECE NO CARTÃO').toUpperCase()}
                          autoComplete="cc-name"
                          maxLength={60}
                        />
                      </Field>
                      <Field label="Número do cartão">
                        <input
                          type="text"
                          value={cardNumber}
                          onChange={(e) => setCardNumber(maskCardNumber(e.target.value))}
                          placeholder="0000 0000 0000 0000"
                          inputMode="numeric"
                          autoComplete="cc-number"
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Validade (MM/AA)">
                          <input
                            type="text"
                            value={cardExpiry}
                            onChange={(e) => setCardExpiry(maskCardExpiry(e.target.value))}
                            placeholder="12/30"
                            inputMode="numeric"
                            autoComplete="cc-exp"
                          />
                        </Field>
                        <Field label="CVV">
                          <input
                            type="text"
                            value={cardCvc}
                            onChange={(e) => setCardCvc(maskDigits(e.target.value, 4))}
                            placeholder="000"
                            inputMode="numeric"
                            autoComplete="cc-csc"
                          />
                        </Field>
                      </div>
                      {product.maxInstallments > 1 ? (
                        <Field label="Parcelas">
                          <select
                            value={installments}
                            onChange={(e) => setInstallments(Number.parseInt(e.target.value, 10))}
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
                    <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger-text)] leading-[1.5]">
                      {createOrder.error.message}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={submitDisabled}
                    className="btn btn-primary mt-1 w-full text-[15px]"
                  >
                    {createOrder.isPending
                      ? 'Processando…'
                      : `${METHOD_CTA[method]} · ${formattedTotal}`}
                  </button>

                  <SecurityLine />
                </div>
              )}
            </StepCard>
          </div>

          {/* ---------- Right column: summary ---------- */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
            <div className="glass-card p-5">
              <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.18em]">
                Resumo do pedido
              </p>

              <div className="mt-4 flex items-start gap-3 border-[var(--hairline)] border-b pb-4">
                {product.coverImageUrl ? (
                  <img
                    src={product.coverImageUrl}
                    alt={product.name}
                    className="h-16 w-16 shrink-0 rounded-2xl object-cover"
                  />
                ) : (
                  <span
                    className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl font-semibold text-[18px] text-white"
                    style={{
                      background:
                        brandTone ??
                        'linear-gradient(135deg, var(--dop-400) 0%, var(--dop-600) 100%)',
                    }}
                  >
                    {(product.name[0] ?? '·').toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[14px] text-[var(--ink-100)] leading-tight">
                    {product.name}
                  </p>
                  <p className="mt-1 text-[12px] text-[var(--ink-50)]">Quantidade: 1</p>
                </div>
                <p className="shrink-0 font-semibold text-[14px] text-[var(--ink-100)] tabular-nums">
                  {formattedTotal}
                </p>
              </div>

              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Subtotal (1 produto)</dt>
                  <dd className="text-[var(--ink-90)] tabular-nums">{formattedTotal}</dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Frete</dt>
                  <dd className="font-medium text-[var(--dop-600)]">
                    {product.type === 'physical' ? 'a calcular' : 'Grátis'}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 flex items-end justify-between border-[var(--hairline)] border-t pt-4">
                <span className="text-[13px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
                  Total
                </span>
                <span className="font-semibold text-[28px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
                  {formattedTotal}
                </span>
              </div>
              {product.maxInstallments > 1 && perInstallment ? (
                <p className="mt-1 text-right font-medium text-[12px] text-[var(--dop-600)]">
                  até {product.maxInstallments}× de {perInstallment} sem juros
                </p>
              ) : null}
            </div>

            <div className="glass-card flex flex-col gap-3 p-5 text-[12px] text-[var(--ink-70)]">
              <div className="flex items-start gap-2">
                <ShieldIcon />
                <span>
                  Seus dados trafegam em HTTPS e ficam armazenados em servidores brasileiros.
                  Pagamento processado por Mercado Pago.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-[11px] text-[var(--ink-50)]">Aceitamos:</span>
                {['Pix', 'Visa', 'Master', 'Amex', 'Elo', 'Boleto'].map((b) => (
                  <PaymentBadge key={b}>{b}</PaymentBadge>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </form>

      <footer className="mt-6 border-[var(--hairline)] border-t bg-[var(--bg-elev-1)]/60">
        <div className="container-x mx-auto flex w-full max-w-[1180px] flex-col items-center gap-1 py-5 text-center text-[11px] text-[var(--ink-50)]">
          <p>
            Pagamento processado por <strong className="text-[var(--ink-70)]">payunivercart</strong>
            . Ao confirmar, você concorda com os termos e a política de privacidade do produtor.
          </p>
          <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function ProducerHeader({
  workspace,
  brandTone,
}: {
  workspace: CheckoutData['workspace'];
  brandTone: string | null;
}) {
  return (
    <header className="border-[var(--hairline)] border-b bg-[var(--bg-elev-1)]/70 backdrop-blur">
      <div className="container-x mx-auto flex w-full max-w-[1180px] items-center justify-between py-4">
        <div className="flex items-center gap-3">
          {workspace.brandLogoUrl ? (
            <img
              src={workspace.brandLogoUrl}
              alt={workspace.displayName}
              className="h-9 w-9 rounded-xl object-cover"
            />
          ) : (
            <span
              className="grid h-9 w-9 place-items-center rounded-xl font-semibold text-[14px] text-white"
              style={{
                background:
                  brandTone ?? 'linear-gradient(135deg, var(--dop-400) 0%, var(--dop-600) 100%)',
              }}
            >
              {(workspace.displayName[0] ?? 'p').toUpperCase()}
            </span>
          )}
          <div className="flex flex-col leading-tight">
            <span className="font-semibold text-[14px] text-[var(--ink-100)]">
              {workspace.displayName}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
              <ShieldIcon size={10} /> Checkout seguro
            </span>
          </div>
        </div>
        <span className="hidden text-[11px] text-[var(--ink-50)] sm:inline">
          🔒 Conexão criptografada · payunivercart
        </span>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Step + Method primitives                                                   */
/* -------------------------------------------------------------------------- */

function StepCard({
  num,
  label,
  active,
  done,
  locked,
  onEdit,
  children,
}: {
  num: number;
  label: string;
  active?: boolean;
  done?: boolean;
  locked?: boolean;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={clsx('glass-card p-5 transition', active && 'dop-glow', locked && 'opacity-90')}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              'grid h-7 w-7 place-items-center rounded-full font-semibold text-[13px] transition',
              done
                ? 'bg-[var(--dop-500)] text-white'
                : active
                  ? 'bg-[var(--dop-500)] text-white shadow-[0_4px_14px_var(--dop-glow)]'
                  : 'bg-[var(--surface-2)] text-[var(--ink-50)]',
            )}
          >
            {done ? '✓' : num}
          </span>
          <h2
            className={clsx(
              'font-semibold text-[15px]',
              active || done ? 'text-[var(--ink-100)]' : 'text-[var(--ink-70)]',
            )}
          >
            {label}
          </h2>
        </div>
        {done && onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="font-medium text-[12px] text-[var(--dop-600)] hover:text-[var(--dop-700)]"
          >
            Editar
          </button>
        ) : null}
        {done && !onEdit ? (
          <span className="font-semibold text-[10px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
            Concluído
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function MethodTabs({ current, onChange }: { current: Method; onChange: (m: Method) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-full bg-[var(--surface-2)] p-1">
      {(['pix', 'credit_card', 'boleto'] as Method[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={clsx(
            'rounded-full px-3 py-2 font-medium text-[13px] transition',
            current === m
              ? 'bg-white text-[var(--ink-100)] shadow-[0_1px_3px_rgba(15,23,42,0.10)]'
              : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]',
          )}
        >
          {METHOD_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; biome can't trace into children, but HTML label semantics still focus the first descendant control on click.
    <label className="field-glass block cursor-text">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SecurityLine() {
  return (
    <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-[var(--ink-50)]">
      <ShieldIcon size={11} /> Pagamento criptografado · seus dados não são armazenados aqui
    </p>
  );
}

function PaymentBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--hairline)] bg-[var(--surface-1)] px-2 py-0.5 font-semibold text-[10px] text-[var(--ink-70)] uppercase tracking-wider">
      {children}
    </span>
  );
}

function ShieldIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--dop-500)]"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading / error / success                                                  */
/* -------------------------------------------------------------------------- */

function CenteredCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <div className={clsx('glass-card w-full p-8', wide ? 'max-w-xl' : 'max-w-md')}>
        {children}
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3">
      <div className="h-3 w-20 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-8 w-2/3 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-3 w-full animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-32 animate-pulse rounded-xl bg-[var(--surface-2)]" />
    </div>
  );
}

function ErrorView({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center">
      <p className="font-semibold text-[11px] text-[var(--danger-text)] uppercase tracking-[0.18em]">
        Erro
      </p>
      <h1 className="mt-3 font-semibold text-[24px] text-[var(--ink-100)]">{title}</h1>
      <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">{body}</p>
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
      ? 'Pague em segundos.'
      : 'Recebemos sua compra.';
  return (
    <div>
      <p className="font-semibold text-[11px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
        {kicker}
      </p>
      <h1 className="mt-3 font-semibold text-[26px] text-[var(--ink-100)]">{headline}</h1>

      {isPaid ? (
        <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
          Pagamento aprovado pelo {methodLabel.toLowerCase()}. Em alguns minutos você recebe os
          dados de acesso em <strong>{buyerEmail}</strong> e no seu WhatsApp.
        </p>
      ) : hasPix ? (
        <>
          <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
            Escaneie o QR-code com o app do seu banco ou copie o código abaixo. Quando recebermos a
            confirmação do Pix, mandamos o acesso em <strong>{buyerEmail}</strong> e no seu
            WhatsApp.
          </p>
          {pixQrCodeImage ? (
            <div className="mt-6 flex justify-center">
              <div className="rounded-2xl border border-[var(--hairline)] bg-white p-3 shadow-[var(--sh-sm)]">
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
            <p className="mt-4 text-center text-[12px] text-[var(--ink-50)]">
              Pague até {formatExpiresAt(pixExpiresAt)} para garantir o pedido.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
          {gatewayConfigured
            ? `Estamos gerando seu ${methodLabel.toLowerCase()} agora. Em instantes você recebe as instruções em ${buyerEmail} e no seu WhatsApp.`
            : `Seu pedido foi registrado. O produtor está finalizando a integração do gateway de pagamento — você receberá as instruções em ${buyerEmail} assim que estiver pronto.`}
        </p>
      )}

      <dl className="mt-6 space-y-3 rounded-2xl bg-[var(--surface-1)] p-5 text-[13px]">
        <Row label="Código do pedido" value={<span className="font-mono">{reference}</span>} />
        <Row label="Método" value={methodLabel} />
        <Row label="Valor" value={<strong>{formattedTotal}</strong>} />
      </dl>

      <p className="mt-6 text-center text-[11px] text-[var(--ink-50)]">
        Guarde o código — use-o para tirar dúvidas com o produtor.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--ink-50)]">{label}</dt>
      <dd className="text-[var(--ink-100)]">{value}</dd>
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
      <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
        Pix copia e cola
      </span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-hidden truncate rounded-xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-3 font-mono text-[12px] text-[var(--ink-70)]">
          {code}
        </code>
        <button type="button" onClick={copy} className="btn btn-primary px-5 text-[13px]">
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

/**
 * Derive a light / mid / dark triple from the producer's brand hex.
 * The checkout's dopamine gradient uses three stops; we map the
 * producer's single chosen color onto that scale so the gradient
 * keeps its premium feel while picking up their identity.
 */
function deriveBrandPalette(hex: string): { light: string; mid: string; dark: string } {
  const normalized = hex.startsWith('#') ? hex : `#${hex}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    // Bad input — fall back to a no-op palette caller can detect via
    // identical stops (still valid CSS, just no gradient depth).
    return { light: normalized, mid: normalized, dark: normalized };
  }
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const lighten = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.18));
  const darken = (c: number) => Math.max(0, Math.round(c * 0.82));
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return {
    light: `#${toHex(lighten(r))}${toHex(lighten(g))}${toHex(lighten(b))}`,
    mid: normalized,
    dark: `#${toHex(darken(r))}${toHex(darken(g))}${toHex(darken(b))}`,
  };
}
