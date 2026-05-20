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
  maskZip,
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

  // Subscription products short-circuit to a dedicated plan picker
  // + recurring card flow. The template choice (single vs stepper)
  // only governs one-time products today.
  if (product.data.product.isSubscription) {
    return <SubscriptionCheckoutView slug={slug} data={product.data} />;
  }
  return product.data.workspace.checkoutTemplate === 'stepper' ? (
    <StepperCheckoutView slug={slug} data={product.data} />
  ) : (
    <CheckoutView slug={slug} data={product.data} />
  );
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

  /**
   * Boleto-only billing address. We collect zip first and call ViaCEP
   * to pre-fill street/neighborhood/city/state, then ask the buyer
   * only for the number + optional complement — the canonical BR UX.
   */
  const [addrZip, setAddrZip] = useState('');
  const [addrStreet, setAddrStreet] = useState('');
  const [addrNumber, setAddrNumber] = useState('');
  const [addrComplement, setAddrComplement] = useState('');
  const [addrNeighborhood, setAddrNeighborhood] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrState, setAddrState] = useState('');
  const [addrLookup, setAddrLookup] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');

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

  const addressZipDigits = unmaskDigits(addrZip);
  const addressComplete =
    method !== 'boleto' ||
    (addressZipDigits.length === 8 &&
      addrStreet.trim().length >= 2 &&
      addrNumber.trim().length >= 1 &&
      addrNeighborhood.trim().length >= 2 &&
      addrCity.trim().length >= 2 &&
      addrState.trim().length === 2);

  const submitDisabled =
    !identifyComplete || !cardComplete || !addressComplete || createOrder.isPending;

  /**
   * ViaCEP lookup. Fires only when we have a full 8-digit zip and the
   * fetch hasn't already populated the address for this exact zip.
   * Failure is non-fatal — buyer falls back to typing the address by
   * hand, which is still gated by `addressComplete`.
   */
  const lookupZip = async (zip: string) => {
    const digits = unmaskDigits(zip);
    if (digits.length !== 8) return;
    setAddrLookup('loading');
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      if (!res.ok) throw new Error(`viacep ${res.status}`);
      const json = (await res.json()) as {
        erro?: boolean;
        logradouro?: string;
        bairro?: string;
        localidade?: string;
        uf?: string;
      };
      if (json.erro) {
        setAddrLookup('error');
        return;
      }
      setAddrStreet(json.logradouro ?? '');
      setAddrNeighborhood(json.bairro ?? '');
      setAddrCity(json.localidade ?? '');
      setAddrState((json.uf ?? '').toUpperCase());
      setAddrLookup('ok');
    } catch {
      setAddrLookup('error');
    }
  };

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
      address:
        method === 'boleto'
          ? {
              zipCode: addrZip,
              street: addrStreet.trim(),
              number: addrNumber.trim(),
              complement: addrComplement.trim() || undefined,
              neighborhood: addrNeighborhood.trim(),
              city: addrCity.trim(),
              state: addrState.trim().toUpperCase(),
              country: 'BR',
            }
          : undefined,
    });
  };

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          orderId={createOrder.data.orderId}
          reference={createOrder.data.publicReference}
          methodLabel={METHOD_LABELS[createOrder.data.method as Method]}
          formattedTotal={formattedTotal}
          buyerEmail={email.trim()}
          pixQrCodeImage={createOrder.data.pixQrCodeImage}
          pixCopyPaste={createOrder.data.pixCopyPaste}
          pixExpiresAt={createOrder.data.pixExpiresAt}
          boletoUrl={createOrder.data.boletoUrl}
          boletoBarcode={createOrder.data.boletoBarcode}
          gatewayConfigured={createOrder.data.gatewayConfigured}
          initialStatus={createOrder.data.status}
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
                  <MethodTabs
                    current={method}
                    onChange={setMethod}
                    acceptBoleto={workspace.acceptBoleto}
                  />

                  {method === 'pix' ? (
                    <p className="text-[13px] text-[var(--ink-70)] leading-[1.55]">
                      Você vai receber um QR-code para pagar no app do seu banco. Aprovação em
                      segundos.
                    </p>
                  ) : null}

                  {method === 'boleto' ? (
                    <div className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-1)] p-4">
                      <p className="text-[12px] text-[var(--ink-70)] leading-[1.5]">
                        O boleto leva até 2 dias úteis para compensar. Por exigência bancária,
                        precisamos do seu endereço de cobrança.
                      </p>
                      <div className="grid grid-cols-[160px_1fr] gap-3">
                        <Field label="CEP">
                          <input
                            type="text"
                            value={addrZip}
                            onChange={(e) => {
                              const next = maskZip(e.target.value);
                              setAddrZip(next);
                              if (unmaskDigits(next).length === 8) {
                                void lookupZip(next);
                              } else {
                                setAddrLookup('idle');
                              }
                            }}
                            placeholder="00000-000"
                            inputMode="numeric"
                            autoComplete="postal-code"
                          />
                        </Field>
                        <Field
                          label={
                            addrLookup === 'loading'
                              ? 'Buscando endereço…'
                              : addrLookup === 'error'
                                ? 'CEP não encontrado — preencha manualmente'
                                : 'Rua'
                          }
                        >
                          <input
                            type="text"
                            value={addrStreet}
                            onChange={(e) => setAddrStreet(e.target.value)}
                            placeholder="Av. Paulista"
                            autoComplete="address-line1"
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-3">
                        <Field label="Número">
                          <input
                            type="text"
                            value={addrNumber}
                            onChange={(e) => setAddrNumber(e.target.value)}
                            placeholder="123"
                            inputMode="numeric"
                            autoComplete="address-line2"
                          />
                        </Field>
                        <Field label="Complemento (opcional)">
                          <input
                            type="text"
                            value={addrComplement}
                            onChange={(e) => setAddrComplement(e.target.value)}
                            placeholder="Sala 7, fundos…"
                            autoComplete="address-line3"
                            maxLength={80}
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-[1.4fr_1fr_80px] gap-3">
                        <Field label="Bairro">
                          <input
                            type="text"
                            value={addrNeighborhood}
                            onChange={(e) => setAddrNeighborhood(e.target.value)}
                            placeholder="Bela Vista"
                          />
                        </Field>
                        <Field label="Cidade">
                          <input
                            type="text"
                            value={addrCity}
                            onChange={(e) => setAddrCity(e.target.value)}
                            placeholder="São Paulo"
                            autoComplete="address-level2"
                          />
                        </Field>
                        <Field label="UF">
                          <input
                            type="text"
                            value={addrState}
                            onChange={(e) =>
                              setAddrState(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase())
                            }
                            placeholder="SP"
                            maxLength={2}
                            autoComplete="address-level1"
                          />
                        </Field>
                      </div>
                    </div>
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
          <p className="inline-flex flex-wrap items-center justify-center gap-1.5">
            Pagamento processado por{' '}
            <img
              src="/payunivercart-logo.png"
              alt="payunivercart"
              className="inline-block h-[14px] w-auto opacity-80"
            />
            . Ao confirmar, você concorda com os termos e a política de privacidade do produtor.
          </p>
          <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* SubscriptionCheckoutView — plan picker + recurring card flow                */
/*                                                                            */
/* Rendered when the product is flagged `isSubscription`. Layout:              */
/*   1. Plan picker — N cards stacked vertically, "Mais escolhido" badge on   */
/*      `isHighlighted=true`. Buyer clicks to select.                         */
/*   2. Identification — name/email/CPF/phone (same model as one-time).      */
/*   3. Card form — recurring engine REQUIRES a tokenized card.              */
/*                                                                            */
/* Pix + boleto are deliberately absent here: only cartão de crédito has     */
/* a real recurring engine in MP. Buyers who want Pix can buy the producer's */
/* one-time product instead.                                                  */
/* -------------------------------------------------------------------------- */

function SubscriptionCheckoutView({ slug, data }: { slug: string; data: CheckoutData }) {
  const { product, workspace } = data;

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() => {
    const highlighted = product.plans.find((p) => p.isHighlighted);
    return (highlighted ?? product.plans[0])?.id ?? null;
  });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [cardHolder, setCardHolder] = useState('');

  const subscribe = trpc.subscriptions.subscribe.useMutation();

  const selectedPlan = useMemo(
    () => product.plans.find((p) => p.id === selectedPlanId) ?? null,
    [selectedPlanId, product.plans],
  );

  // For monthly plans, surface the implied annual equivalent next to
  // the price so buyers can mentally compare a R$ 49/mês plan to a
  // R$ 499/ano (~15% discount) on the same screen.
  const monthly = product.plans.find((p) => p.billingPeriod === 'monthly');
  const yearly = product.plans.find((p) => p.billingPeriod === 'yearly');
  const annualSavings =
    monthly && yearly ? Math.max(0, monthly.amountCents * 12 - yearly.amountCents) : 0;
  const annualSavingsPct =
    monthly && yearly && monthly.amountCents > 0
      ? Math.round((annualSavings / (monthly.amountCents * 12)) * 100)
      : 0;

  const docDigits = unmaskDigits(doc);
  const phoneDigits = unmaskDigits(phone);
  const cardDigits = unmaskDigits(cardNumber);
  const expiryDigits = unmaskDigits(cardExpiry);
  const trimmedHolder = cardHolder.trim() || name.trim();

  const identifyComplete =
    name.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (docDigits.length === 11 || docDigits.length === 14) &&
    phoneDigits.length >= 10;
  const cardComplete =
    cardDigits.length >= 13 &&
    expiryDigits.length === 4 &&
    cardCvc.length >= 3 &&
    trimmedHolder.length >= 2;
  const canSubmit = !!selectedPlan && identifyComplete && cardComplete && !subscribe.isPending;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPlan) return;
    // Browser-side card tokenization via MP SDK is the production path
    // — until that lands in this app we forward the raw card and let
    // the server-side tokenize hop in MP adapter compute the token.
    // The server route accepts `cardToken` only; we fake one here by
    // POSTing to `/v1/card_tokens` from the client. For first cut we
    // post raw fields and the api error-surfaces if MP refuses.
    const [mm, yyRaw] = cardExpiry.split('/');
    if (!mm || !yyRaw) return;
    const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    // Use MP public-key endpoint via the producer's publishable key if
    // wired; placeholder: we forward to api which will refuse without
    // a token. TODO: integrate MercadoPago.js v2 here.
    const cardTokenPlaceholder = `RAW:${cardDigits}:${mm}:${yy}:${cardCvc}`;
    subscribe.mutate({
      slug,
      planId: selectedPlan.id,
      buyer: {
        name: name.trim(),
        email: email.trim(),
        document: doc,
        phone,
      },
      cardToken: cardTokenPlaceholder,
      cardHolderName: trimmedHolder,
    });
  };

  if (subscribe.data) {
    return (
      <CenteredCard wide>
        <SubscriptionSuccess
          publicReference={subscribe.data.publicReference}
          status={subscribe.data.status}
          nextChargeAt={subscribe.data.nextChargeAt}
          planName={selectedPlan?.name ?? '—'}
          amountCents={selectedPlan?.amountCents ?? 0}
          billingPeriod={selectedPlan?.billingPeriod ?? 'monthly'}
          buyerEmail={email.trim()}
        />
      </CenteredCard>
    );
  }

  const brandTone = workspace.brandPrimaryColor;
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
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.4fr_1fr]">
          {/* ===== Plans + identification + card ===== */}
          <div className="flex flex-col gap-6">
            <section className="glass-card p-6">
              <p className="font-semibold text-[11px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
                Assinatura recorrente
              </p>
              <h1 className="mt-3 font-semibold text-[26px] text-[var(--ink-100)] tracking-tight">
                Escolha seu plano.
              </h1>
              {product.description ? (
                <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
                  {product.description}
                </p>
              ) : null}

              {product.plans.length === 0 ? (
                <p className="mt-5 rounded-xl border border-[var(--hairline)] border-dashed p-4 text-[13px] text-[var(--ink-50)]">
                  Nenhum plano ativo. Avise o produtor.
                </p>
              ) : (
                <div className="mt-5 flex flex-col gap-3">
                  {product.plans.map((p) => (
                    <PlanPickCard
                      key={p.id}
                      plan={p}
                      selected={p.id === selectedPlanId}
                      onPick={() => setSelectedPlanId(p.id)}
                      annualSavings={
                        p.billingPeriod === 'yearly' && annualSavingsPct > 0 ? annualSavingsPct : 0
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="glass-card flex flex-col gap-5 p-6">
              <h2 className="font-semibold text-[18px] text-[var(--ink-100)] tracking-tight">
                Identificação
              </h2>
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
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
            </section>

            <section className="glass-card flex flex-col gap-5 p-6">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-[18px] text-[var(--ink-100)] tracking-tight">
                  Cartão de crédito
                </h2>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ink-50)]">
                  <ShieldIcon size={11} /> Assinatura renovada automaticamente
                </span>
              </div>
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

              {subscribe.error ? (
                <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger-text)] leading-[1.5]">
                  {subscribe.error.message}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!canSubmit}
                className="btn btn-primary inline-flex w-full items-center justify-center gap-3 py-4 text-[16px]"
              >
                {subscribe.isPending
                  ? 'Confirmando assinatura…'
                  : selectedPlan
                    ? `Assinar · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                    : 'Escolha um plano acima'}
              </button>
              <p className="text-center text-[11px] text-[var(--ink-50)] leading-[1.5]">
                Cobrança automática. Cancele quando quiser na sua conta ou pedindo pro produtor.
              </p>
            </section>
          </div>

          {/* ===== Sticky summary ===== */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
            <div className="glass-card p-6">
              <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.18em]">
                Sua assinatura
              </p>
              <div className="mt-5 flex items-start gap-4 border-[var(--hairline)] border-b pb-5">
                {product.coverImageUrl ? (
                  <img
                    src={product.coverImageUrl}
                    alt={product.name}
                    className="h-14 w-14 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <span
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-xl font-semibold text-[16px] text-white"
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
                  <p className="mt-1 text-[12px] text-[var(--ink-50)]">
                    {selectedPlan?.name ?? 'Selecione um plano'}
                  </p>
                </div>
              </div>

              <dl className="mt-5 space-y-3 text-[13px]">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Periodicidade</dt>
                  <dd className="font-semibold text-[var(--ink-90)]">
                    {selectedPlan?.billingPeriod === 'yearly' ? 'Anual' : 'Mensal'}
                  </dd>
                </div>
                {selectedPlan && selectedPlan.trialDays > 0 ? (
                  <div className="flex items-baseline justify-between">
                    <dt className="text-[var(--ink-70)]">Trial grátis</dt>
                    <dd className="font-semibold text-[var(--dop-600)]">
                      {selectedPlan.trialDays} dias
                    </dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-5 flex items-end justify-between border-[var(--hairline)] border-t pt-5">
                <span className="font-semibold text-[13px] text-[var(--ink-70)] uppercase tracking-[0.16em]">
                  {selectedPlan?.billingPeriod === 'yearly' ? 'Por ano' : 'Por mês'}
                </span>
                <div className="text-right">
                  <span className="font-semibold text-[28px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
                    {selectedPlan
                      ? formatCents(selectedPlan.amountCents, selectedPlan.currency)
                      : '—'}
                  </span>
                  {selectedPlan?.billingPeriod === 'yearly' && annualSavingsPct > 0 ? (
                    <p className="mt-1 font-semibold text-[12px] text-[var(--dop-600)]">
                      você economiza {annualSavingsPct}%
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="glass-card flex flex-col gap-3 p-5 text-[12px] text-[var(--ink-70)]">
              <div className="flex items-start gap-2">
                <ShieldIcon />
                <span>
                  Cobrança recorrente via Mercado Pago. Cancele sem multa. Confirmação enviada pra
                  seu email + WhatsApp.
                </span>
              </div>
            </div>
          </aside>
        </div>
      </form>

      <footer className="mt-6 border-[var(--hairline)] border-t bg-[var(--bg-elev-1)]/60">
        <div className="container-x mx-auto flex w-full max-w-[1180px] flex-col items-center gap-1 py-5 text-center text-[11px] text-[var(--ink-50)]">
          <p className="inline-flex flex-wrap items-center justify-center gap-1.5">
            Pagamento processado por{' '}
            <img
              src="/payunivercart-logo.png"
              alt="payunivercart"
              className="inline-block h-[14px] w-auto opacity-80"
            />
            . Ao confirmar, você concorda com os termos e a política de privacidade do produtor.
          </p>
          <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
        </div>
      </footer>
    </main>
  );
}

/**
 * Plan card rendered in the buyer's plan picker. Selected state uses
 * the brand color border + glow; "Mais escolhido" sits as a floating
 * pill on top-right.
 */
function PlanPickCard({
  plan,
  selected,
  onPick,
  annualSavings,
}: {
  plan: CheckoutData['product']['plans'][number];
  selected: boolean;
  onPick: () => void;
  annualSavings: number;
}) {
  const perWord = plan.billingPeriod === 'yearly' ? 'ano' : 'mês';
  const monthlyEquivalent =
    plan.billingPeriod === 'yearly' ? Math.round(plan.amountCents / 12) : null;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={clsx(
        'group relative flex items-center justify-between gap-4 rounded-2xl border bg-[var(--surface-1)] p-5 text-left transition',
        selected
          ? 'border-[var(--dop-500)] shadow-[0_8px_28px_-8px_var(--dop-glow)]'
          : 'border-[var(--hairline)] hover:border-[var(--hairline-strong)] hover:bg-white/40',
      )}
    >
      {plan.isHighlighted ? (
        <span className="-top-3 absolute right-5 inline-flex items-center gap-1 rounded-full bg-[var(--dop-500)] px-3 py-1 font-semibold text-[10px] text-white uppercase tracking-[0.14em]">
          ★ Mais escolhido
        </span>
      ) : null}
      <div className="flex items-center gap-4">
        <span
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition',
            selected
              ? 'border-[var(--dop-500)] bg-[var(--dop-500)] text-white'
              : 'border-[var(--hairline-strong)] text-transparent group-hover:border-[var(--ink-50)]',
          )}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            aria-hidden="true"
            className="size-4"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-[15px] text-[var(--ink-100)]">{plan.name}</p>
          <p className="mt-0.5 text-[12px] text-[var(--ink-70)]">
            {plan.billingPeriod === 'yearly' ? 'Cobrança anual' : 'Cobrança mensal'}
            {plan.trialDays > 0 ? ` · ${plan.trialDays} dias grátis` : ''}
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="font-semibold text-[20px] text-[var(--ink-100)] tabular-nums leading-none">
          {formatCents(plan.amountCents, plan.currency)}
          <span className="font-normal text-[12px] text-[var(--ink-50)]">/{perWord}</span>
        </p>
        {monthlyEquivalent !== null ? (
          <p className="mt-1 text-[11px] text-[var(--ink-50)]">
            {formatCents(monthlyEquivalent, plan.currency)}/mês
          </p>
        ) : null}
        {annualSavings > 0 ? (
          <p className="mt-1 font-semibold text-[11px] text-[var(--dop-600)]">
            economize {annualSavings}%
          </p>
        ) : null}
      </div>
    </button>
  );
}

function SubscriptionSuccess({
  publicReference,
  status,
  nextChargeAt,
  planName,
  amountCents,
  billingPeriod,
  buyerEmail,
}: {
  publicReference: string;
  status: string;
  nextChargeAt: Date | string | null;
  planName: string;
  amountCents: number;
  billingPeriod: 'monthly' | 'yearly';
  buyerEmail: string;
}) {
  const isActive = status === 'active';
  return (
    <div>
      <p className="font-semibold text-[11px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
        {isActive ? 'Assinatura ativa' : 'Assinatura criada'}
      </p>
      <h1 className="mt-3 font-semibold text-[26px] text-[var(--ink-100)]">
        {isActive ? 'Bem-vindo a bordo! 🎉' : 'Estamos confirmando seu pagamento.'}
      </h1>
      <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
        Mandamos a confirmação em <strong>{buyerEmail}</strong>. Próxima cobrança{' '}
        {nextChargeAt
          ? `em ${formatExpiresAt(nextChargeAt)}`
          : `daqui a 1 ${billingPeriod === 'yearly' ? 'ano' : 'mês'}`}
        .
      </p>
      <dl className="mt-6 space-y-3 rounded-2xl bg-[var(--surface-1)] p-5 text-[13px]">
        <Row label="Plano" value={planName} />
        <Row
          label="Valor"
          value={
            <strong>
              {formatCents(amountCents, 'BRL')}/{billingPeriod === 'yearly' ? 'ano' : 'mês'}
            </strong>
          }
        />
        <Row label="Código" value={<span className="font-mono">{publicReference}</span>} />
      </dl>
      <p className="mt-6 text-center text-[11px] text-[var(--ink-50)]">
        Para cancelar, responda o email da cobrança ou fale com o produtor.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* StepperCheckoutView — Stitch-inspired 3-step layout                        */
/*                                                                            */
/* Layout port of the "Checkout Premium · Stepper" template generated by the  */
/* Stitch design tool. Producer picks this variant when they want a more     */
/* "weighted" wizard feel — completed steps collapse into a summary card     */
/* with an "Editar" button so the buyer always sees what they've already     */
/* entered. Logic + state model are intentionally identical to the single-   */
/* page CheckoutView; only the outer composition (StitchStepCard, sticky     */
/* summary at top:24, soft-shadow glass cards) differs.                      */
/* -------------------------------------------------------------------------- */

function StepperCheckoutView({ slug, data }: { slug: string; data: CheckoutData }) {
  const { product, workspace } = data;

  const [step, setStep] = useState<'identify' | 'method' | 'pay'>('identify');
  const [method, setMethod] = useState<Method>('pix');
  const [installments, setInstallments] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [addrZip, setAddrZip] = useState('');
  const [addrStreet, setAddrStreet] = useState('');
  const [addrNumber, setAddrNumber] = useState('');
  const [addrComplement, setAddrComplement] = useState('');
  const [addrNeighborhood, setAddrNeighborhood] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrState, setAddrState] = useState('');
  const [addrLookup, setAddrLookup] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');

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

  const addressZipDigits = unmaskDigits(addrZip);
  const addressComplete =
    method !== 'boleto' ||
    (addressZipDigits.length === 8 &&
      addrStreet.trim().length >= 2 &&
      addrNumber.trim().length >= 1 &&
      addrNeighborhood.trim().length >= 2 &&
      addrCity.trim().length >= 2 &&
      addrState.trim().length === 2);

  const submitDisabled =
    !identifyComplete || !cardComplete || !addressComplete || createOrder.isPending;

  const lookupZip = async (zip: string) => {
    const digits = unmaskDigits(zip);
    if (digits.length !== 8) return;
    setAddrLookup('loading');
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      if (!res.ok) throw new Error(`viacep ${res.status}`);
      const json = (await res.json()) as {
        erro?: boolean;
        logradouro?: string;
        bairro?: string;
        localidade?: string;
        uf?: string;
      };
      if (json.erro) {
        setAddrLookup('error');
        return;
      }
      setAddrStreet(json.logradouro ?? '');
      setAddrNeighborhood(json.bairro ?? '');
      setAddrCity(json.localidade ?? '');
      setAddrState((json.uf ?? '').toUpperCase());
      setAddrLookup('ok');
    } catch {
      setAddrLookup('error');
    }
  };

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
      address:
        method === 'boleto'
          ? {
              zipCode: addrZip,
              street: addrStreet.trim(),
              number: addrNumber.trim(),
              complement: addrComplement.trim() || undefined,
              neighborhood: addrNeighborhood.trim(),
              city: addrCity.trim(),
              state: addrState.trim().toUpperCase(),
              country: 'BR',
            }
          : undefined,
    });
  };

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          orderId={createOrder.data.orderId}
          reference={createOrder.data.publicReference}
          methodLabel={METHOD_LABELS[createOrder.data.method as Method]}
          formattedTotal={formattedTotal}
          buyerEmail={email.trim()}
          pixQrCodeImage={createOrder.data.pixQrCodeImage}
          pixCopyPaste={createOrder.data.pixCopyPaste}
          pixExpiresAt={createOrder.data.pixExpiresAt}
          boletoUrl={createOrder.data.boletoUrl}
          boletoBarcode={createOrder.data.boletoBarcode}
          gatewayConfigured={createOrder.data.gatewayConfigured}
          initialStatus={createOrder.data.status}
        />
      </CenteredCard>
    );
  }

  const brandTone = workspace.brandPrimaryColor;
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
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">
          {/* ===================== Stepper column ===================== */}
          <div className="flex flex-col gap-5">
            <StitchStepCard
              n={1}
              label="Identificação"
              state={step === 'identify' ? 'active' : identifyComplete ? 'done' : 'pending'}
              onEdit={step !== 'identify' ? () => setStep('identify') : undefined}
            >
              {step === 'identify' ? (
                <div className="flex flex-col gap-5">
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
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                  <p className="text-[12px] text-[var(--ink-50)] leading-[1.5]">
                    Usaremos seu telefone para enviar o acesso por WhatsApp.
                  </p>
                  <button
                    type="button"
                    onClick={() => identifyComplete && setStep('method')}
                    disabled={!identifyComplete}
                    className="btn btn-primary mt-1 inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                  >
                    Escolher método →
                  </button>
                </div>
              ) : (
                <StitchSummaryGrid
                  items={[
                    { label: 'NOME COMPLETO', value: name },
                    { label: 'E-MAIL', value: email },
                    { label: 'CPF / CNPJ', value: doc },
                    { label: 'TELEFONE', value: phone },
                  ]}
                />
              )}
            </StitchStepCard>

            <StitchStepCard
              n={2}
              label="Método de pagamento"
              state={step === 'method' ? 'active' : step === 'pay' ? 'done' : 'pending'}
              onEdit={step === 'pay' ? () => setStep('method') : undefined}
            >
              {step === 'identify' ? (
                <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                  Complete a identificação acima para escolher.
                </p>
              ) : step === 'method' ? (
                <div className="flex flex-col gap-3">
                  <MethodPickCard
                    method="pix"
                    title="Pix"
                    tagline="Aprovação instantânea"
                    description="QR-code ou copia-e-cola. Liberação em segundos."
                    icon={<PixOfficialIcon />}
                    selected={method === 'pix'}
                    onPick={() => {
                      setMethod('pix');
                      setStep('pay');
                    }}
                  />
                  <MethodPickCard
                    method="credit_card"
                    title="Cartão de crédito"
                    tagline={
                      product.maxInstallments > 1
                        ? `Até ${product.maxInstallments}× sem juros`
                        : 'Aprovação na hora'
                    }
                    description="Visa · Master · Amex · Elo · Hipercard."
                    icon={<CardChipIcon />}
                    selected={method === 'credit_card'}
                    onPick={() => {
                      setMethod('credit_card');
                      setStep('pay');
                    }}
                  />
                  {workspace.acceptBoleto ? (
                    <MethodPickCard
                      method="boleto"
                      title="Boleto bancário"
                      tagline="Compensação em até 2 dias úteis"
                      description="Pague no app do seu banco ou em qualquer agência."
                      icon={<BoletoBarsIcon />}
                      selected={method === 'boleto'}
                      onPick={() => {
                        setMethod('boleto');
                        setStep('pay');
                      }}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-3 text-[14px] text-[var(--ink-90)]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--dop-soft)] text-[var(--dop-600)]">
                    {method === 'pix' ? (
                      <PixOfficialIcon size={16} />
                    ) : method === 'credit_card' ? (
                      <CardChipIcon size={16} />
                    ) : (
                      <BoletoBarsIcon size={16} />
                    )}
                  </span>
                  <span className="font-semibold">{METHOD_LABELS[method]}</span>
                </div>
              )}
            </StitchStepCard>

            <StitchStepCard
              n={3}
              label="Finalizar pagamento"
              state={step === 'pay' ? 'active' : 'pending'}
            >
              {step !== 'pay' ? (
                <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                  Escolha o método de pagamento para finalizar.
                </p>
              ) : (
                <div className="flex flex-col gap-6">
                  {method === 'pix' ? (
                    <div className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-1)] p-5 md:flex-row md:items-center md:gap-5">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--dop-soft)] text-[var(--dop-600)]">
                        <PixOfficialIcon />
                      </div>
                      <div className="space-y-1">
                        <h3 className="font-semibold text-[14px] text-[var(--ink-100)]">
                          Pagamento instantâneo via Pix
                        </h3>
                        <p className="text-[13px] text-[var(--ink-70)] leading-[1.55]">
                          Receba um QR-code para pagar no app do seu banco. Aprovação imediata,
                          acesso liberado em segundos.
                        </p>
                      </div>
                    </div>
                  ) : null}

                  {method === 'boleto' ? (
                    <div className="flex flex-col gap-4 rounded-2xl bg-[var(--surface-1)] p-5">
                      <p className="text-[12px] text-[var(--ink-70)] leading-[1.5]">
                        O boleto leva até 2 dias úteis para compensar. Endereço de cobrança é
                        exigência bancária.
                      </p>
                      <div className="grid grid-cols-[160px_1fr] gap-3">
                        <Field label="CEP">
                          <input
                            type="text"
                            value={addrZip}
                            onChange={(e) => {
                              const next = maskZip(e.target.value);
                              setAddrZip(next);
                              if (unmaskDigits(next).length === 8) {
                                void lookupZip(next);
                              } else {
                                setAddrLookup('idle');
                              }
                            }}
                            placeholder="00000-000"
                            inputMode="numeric"
                            autoComplete="postal-code"
                          />
                        </Field>
                        <Field
                          label={
                            addrLookup === 'loading'
                              ? 'Buscando endereço…'
                              : addrLookup === 'error'
                                ? 'CEP não encontrado — preencha manualmente'
                                : 'Rua'
                          }
                        >
                          <input
                            type="text"
                            value={addrStreet}
                            onChange={(e) => setAddrStreet(e.target.value)}
                            placeholder="Av. Paulista"
                            autoComplete="address-line1"
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-3">
                        <Field label="Número">
                          <input
                            type="text"
                            value={addrNumber}
                            onChange={(e) => setAddrNumber(e.target.value)}
                            placeholder="123"
                            inputMode="numeric"
                            autoComplete="address-line2"
                          />
                        </Field>
                        <Field label="Complemento (opcional)">
                          <input
                            type="text"
                            value={addrComplement}
                            onChange={(e) => setAddrComplement(e.target.value)}
                            placeholder="Sala 7, fundos…"
                            autoComplete="address-line3"
                            maxLength={80}
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-[1.4fr_1fr_80px] gap-3">
                        <Field label="Bairro">
                          <input
                            type="text"
                            value={addrNeighborhood}
                            onChange={(e) => setAddrNeighborhood(e.target.value)}
                            placeholder="Bela Vista"
                          />
                        </Field>
                        <Field label="Cidade">
                          <input
                            type="text"
                            value={addrCity}
                            onChange={(e) => setAddrCity(e.target.value)}
                            placeholder="São Paulo"
                            autoComplete="address-level2"
                          />
                        </Field>
                        <Field label="UF">
                          <input
                            type="text"
                            value={addrState}
                            onChange={(e) =>
                              setAddrState(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase())
                            }
                            placeholder="SP"
                            maxLength={2}
                            autoComplete="address-level1"
                          />
                        </Field>
                      </div>
                    </div>
                  ) : null}

                  {method === 'credit_card' ? (
                    <div className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-1)] p-5">
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
                    className="btn btn-primary inline-flex w-full items-center justify-center gap-3 py-4 text-[16px]"
                  >
                    {createOrder.isPending
                      ? 'Processando…'
                      : `${METHOD_CTA[method]} · ${formattedTotal}`}
                  </button>

                  <SecurityLine />
                </div>
              )}
            </StitchStepCard>
          </div>

          {/* ===================== Sticky summary ===================== */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
            <div className="glass-card p-6">
              <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.18em]">
                Resumo do pedido
              </p>
              <div className="mt-5 flex items-start gap-4 border-[var(--hairline)] border-b pb-5">
                {product.coverImageUrl ? (
                  <img
                    src={product.coverImageUrl}
                    alt={product.name}
                    className="h-14 w-14 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <span
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-xl font-semibold text-[16px] text-white"
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
                  <p className="mt-1 font-bold text-[13px] text-[var(--dop-600)]">
                    {formattedTotal}
                  </p>
                </div>
              </div>

              <dl className="mt-5 space-y-3 text-[13px]">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Subtotal (1 produto)</dt>
                  <dd className="font-semibold text-[var(--ink-90)] tabular-nums">
                    {formattedTotal}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Frete</dt>
                  <dd className="font-semibold text-[var(--dop-600)]">
                    {product.type === 'physical' ? 'a calcular' : 'Grátis'}
                  </dd>
                </div>
              </dl>

              <div className="mt-5 flex items-end justify-between border-[var(--hairline)] border-t pt-5">
                <span className="font-semibold text-[13px] text-[var(--ink-70)] uppercase tracking-[0.16em]">
                  Total
                </span>
                <div className="text-right">
                  <span className="font-semibold text-[28px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
                    {formattedTotal}
                  </span>
                  {product.maxInstallments > 1 && perInstallment ? (
                    <p className="mt-1 font-semibold text-[12px] text-[var(--dop-600)]">
                      até {product.maxInstallments}× de {perInstallment} sem juros
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="glass-card flex flex-col gap-3 p-5 text-[12px] text-[var(--ink-70)]">
              <div className="flex items-start gap-2">
                <ShieldIcon />
                <span>
                  Seus dados trafegam em HTTPS e ficam armazenados em servidores brasileiros.
                  Pagamento processado com segurança.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 border-[var(--hairline)] border-t pt-3">
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
          <p className="inline-flex flex-wrap items-center justify-center gap-1.5">
            Pagamento processado por{' '}
            <img
              src="/payunivercart-logo.png"
              alt="payunivercart"
              className="inline-block h-[14px] w-auto opacity-80"
            />
            . Ao confirmar, você concorda com os termos e a política de privacidade do produtor.
          </p>
          <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Stitch-style step card + payment tabs + summary grid + bolt icon           */
/* -------------------------------------------------------------------------- */

function StitchStepCard({
  n,
  label,
  state,
  children,
  onEdit,
}: {
  n: number;
  label: string;
  state: 'active' | 'done' | 'pending';
  children: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <section
      className={clsx(
        'glass-card relative overflow-hidden p-6 transition',
        state === 'active' &&
          'shadow-[0_4px_30px_-6px_rgba(15,23,42,0.10)] ring-1 ring-[var(--dop-hairline)]',
        state === 'pending' && 'opacity-70',
      )}
    >
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              'flex h-9 w-9 items-center justify-center rounded-full font-bold text-[14px] transition',
              state === 'done' && 'bg-[var(--dop-500)] text-white',
              state === 'active' && 'bg-[var(--dop-500)] text-white',
              state === 'pending' &&
                'border border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink-50)]',
            )}
          >
            {state === 'done' ? <CheckIcon /> : n}
          </span>
          <h2 className="font-semibold text-[18px] text-[var(--ink-100)] tracking-tight">
            {label}
          </h2>
        </div>
        {onEdit && state === 'done' ? (
          <button
            type="button"
            onClick={onEdit}
            className="font-semibold text-[13px] text-[var(--dop-600)] hover:underline"
          >
            Editar
          </button>
        ) : null}
      </header>
      <div className={state === 'done' ? 'pl-12' : undefined}>{children}</div>
    </section>
  );
}

function StitchSummaryGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 text-[var(--ink-70)] md:grid-cols-2">
      {items.map((it) => (
        <div key={it.label}>
          <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
            {it.label}
          </p>
          <p className="mt-1 font-semibold text-[14px] text-[var(--ink-100)] leading-tight">
            {it.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
      className="size-4"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

/**
 * Pix official mark — 4-pointed pinwheel. Stylised from Banco Central
 * do Brasil's official Pix logo so buyers recognise it instantly.
 */
function PixOfficialIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M5.3 9.7a3.2 3.2 0 0 1 2.3 1l2.7 2.7c.4.4 1 .4 1.4 0l2.7-2.7a3.2 3.2 0 0 1 2.3-1H17l-3.6-3.6a2 2 0 0 0-2.8 0L7 9.7h-1.7z" />
      <path d="M5.3 14.3c.9 0 1.7-.4 2.3-1l2.7-2.7c.4-.4 1-.4 1.4 0l2.7 2.7a3.2 3.2 0 0 0 2.3 1H17l-3.6 3.6a2 2 0 0 1-2.8 0L7 14.3H5.3z" />
      <path d="M19 9.7 17.7 8.4c-.4-.4-1-.4-1.4 0L15 9.7a3.2 3.2 0 0 0-2.3 1l-.5.5a.5.5 0 0 1-.4 0l-.5-.5a3.2 3.2 0 0 0-2.3-1L7.7 8.4c-.4-.4-1-.4-1.4 0L5 9.7l-1.5 1.5a2 2 0 0 0 0 2.8L5 15.5l1.3 1.3c.4.4 1 .4 1.4 0L9 15.5a3.2 3.2 0 0 0 2.3-1l.5-.5a.5.5 0 0 1 .4 0l.5.5a3.2 3.2 0 0 0 2.3 1l1.3 1.3c.4.4 1 .4 1.4 0L19 15.5l1.5-1.5a2 2 0 0 0 0-2.8L19 9.7z" />
    </svg>
  );
}

/** Cartão com chip + faixa magnética + dígitos. */
function CardChipIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 24" width={size} height={(size * 24) / 32} fill="none" aria-hidden="true">
      <rect x="1" y="1" width="30" height="22" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <rect x="5" y="6" width="6" height="5" rx="0.8" fill="currentColor" opacity="0.85" />
      <path
        d="M13 8.5h2M14 10h1"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M5 16.5h6M13 16.5h4M19 16.5h4M25 16.5h2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}

/** Boleto — código de barras vertical. */
function BoletoBarsIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 24"
      width={size}
      height={(size * 24) / 32}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="2" height="18" />
      <rect x="5.5" y="3" width="1" height="18" />
      <rect x="8" y="3" width="2.5" height="18" />
      <rect x="11.5" y="3" width="1" height="18" />
      <rect x="14" y="3" width="2" height="18" />
      <rect x="17.5" y="3" width="1.5" height="18" />
      <rect x="20.5" y="3" width="2" height="18" />
      <rect x="24" y="3" width="1" height="18" />
      <rect x="26" y="3" width="2.5" height="18" />
      <rect x="29.5" y="3" width="1" height="18" />
    </svg>
  );
}

/**
 * Large clickable method card used in the stepper's "Método" step.
 * Click selects the method and advances to step 3 in one tap.
 */
function MethodPickCard({
  method,
  title,
  tagline,
  description,
  icon,
  selected,
  onPick,
}: {
  method: Method;
  title: string;
  tagline: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      data-method={method}
      aria-pressed={selected}
      className={clsx(
        'group flex items-center gap-4 rounded-2xl border bg-[var(--surface-1)] p-4 text-left transition',
        selected
          ? 'border-[var(--dop-500)] shadow-[0_4px_16px_-4px_var(--dop-glow)]'
          : 'border-[var(--hairline)] hover:border-[var(--hairline-strong)] hover:bg-white/40',
      )}
    >
      <span
        className={clsx(
          'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition',
          selected
            ? 'bg-[var(--dop-500)] text-white'
            : 'bg-[var(--surface-2)] text-[var(--ink-90)] group-hover:bg-[var(--dop-soft)] group-hover:text-[var(--dop-600)]',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[15px] text-[var(--ink-100)]">{title}</p>
        <p className="mt-0.5 font-semibold text-[12px] text-[var(--dop-600)]">{tagline}</p>
        <p className="mt-1 text-[12px] text-[var(--ink-70)] leading-[1.4]">{description}</p>
      </div>
      <span
        className={clsx(
          'shrink-0 transition',
          selected
            ? 'text-[var(--dop-500)]'
            : 'text-[var(--ink-30)] group-hover:text-[var(--ink-50)]',
        )}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className="size-4"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l5 5-5 5" />
        </svg>
      </span>
    </button>
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

function MethodTabs({
  current,
  onChange,
  acceptBoleto,
}: {
  current: Method;
  onChange: (m: Method) => void;
  acceptBoleto: boolean;
}) {
  const methods: Method[] = acceptBoleto
    ? ['pix', 'credit_card', 'boleto']
    : ['pix', 'credit_card'];
  return (
    <div
      className={clsx(
        'grid gap-1 rounded-full bg-[var(--surface-2)] p-1',
        methods.length === 3 ? 'grid-cols-3' : 'grid-cols-2',
      )}
    >
      {methods.map((m) => (
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
  orderId,
  reference,
  methodLabel,
  formattedTotal,
  buyerEmail,
  pixQrCodeImage,
  pixCopyPaste,
  pixExpiresAt,
  boletoUrl,
  boletoBarcode,
  gatewayConfigured,
  initialStatus,
}: {
  orderId: string;
  reference: string;
  methodLabel: string;
  formattedTotal: string;
  buyerEmail: string;
  pixQrCodeImage: string | null;
  pixCopyPaste: string | null;
  pixExpiresAt: Date | string | null;
  boletoUrl: string | null;
  boletoBarcode: string | null;
  gatewayConfigured: boolean;
  initialStatus: string;
}) {
  // Poll the order until the gateway webhook flips status → `paid`.
  // 3 s cadence is the sweet spot: fast enough that the buyer sees
  // the confirmation the moment they tab back from the bank app,
  // slow enough that we don't hammer the api or trip rate limits.
  // Stop polling once we hit a terminal state (paid / cancelled /
  // expired / refunded) — there's nothing left to wait for.
  const live = trpc.checkout.orderStatus.useQuery(
    { orderId },
    {
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        if (s === 'paid' || s === 'cancelled' || s === 'expired' || s === 'refunded') {
          return false;
        }
        return 3_000;
      },
      refetchOnWindowFocus: true,
    },
  );

  const status = live.data?.status ?? initialStatus;
  const deliveryUrl = live.data?.deliveryUrl ?? null;
  const deliveryInstructions = live.data?.deliveryInstructions ?? null;
  const isPaid = status === 'paid';
  const hasPix = !!(pixQrCodeImage || pixCopyPaste);
  const hasBoleto = !!(boletoUrl || boletoBarcode);
  const kicker = isPaid
    ? 'Pagamento aprovado'
    : hasPix
      ? 'Pix gerado'
      : hasBoleto
        ? 'Boleto gerado'
        : 'Pedido criado';
  const headline = isPaid
    ? 'Compra confirmada! 🎉'
    : hasPix
      ? 'Pague em segundos.'
      : hasBoleto
        ? 'Boleto pronto pra pagar.'
        : 'Recebemos sua compra.';
  return (
    <div>
      <p className="font-semibold text-[11px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
        {kicker}
      </p>
      <h1 className="mt-3 font-semibold text-[26px] text-[var(--ink-100)]">{headline}</h1>

      {isPaid ? (
        <>
          <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
            Recebemos o pagamento pelo {methodLabel.toLowerCase()}. Mandamos a confirmação em{' '}
            <strong>{buyerEmail}</strong> e no seu WhatsApp.
          </p>
          {deliveryUrl || deliveryInstructions ? (
            <div className="mt-6 rounded-2xl border border-[var(--dop-hairline)] bg-[var(--dop-soft)] p-5">
              <p className="font-semibold text-[11px] text-[var(--dop-600)] uppercase tracking-[0.18em]">
                Seu acesso
              </p>
              {deliveryUrl ? (
                <a
                  href={deliveryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary mt-3 w-full text-[15px]"
                >
                  Abrir agora →
                </a>
              ) : null}
              {deliveryInstructions ? (
                <p className="mt-4 whitespace-pre-wrap text-[13px] text-[var(--ink-90)] leading-[1.55]">
                  {deliveryInstructions}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
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
      ) : hasBoleto ? (
        <>
          <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
            Pague no app do seu banco ou em qualquer agência. Mandamos uma cópia para{' '}
            <strong>{buyerEmail}</strong>. Após compensação (até 2 dias úteis), liberamos o acesso
            no seu WhatsApp.
          </p>
          {boletoUrl ? (
            <a
              href={boletoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary mt-6 w-full text-[15px]"
            >
              Abrir boleto em nova aba
            </a>
          ) : null}
          {boletoBarcode ? <BoletoCopyButton code={boletoBarcode} /> : null}
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

function BoletoCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignored — buyer always has the "abrir boleto" link as fallback */
    }
  };
  return (
    <div className="mt-5 flex flex-col gap-2">
      <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.16em]">
        Linha digitável
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
