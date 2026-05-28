'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { TrackingScripts, useFireEvent } from '../../../components/TrackingScripts';
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

  // Subscription products use a dedicated plan picker + recurring
  // card flow. The view itself branches on workspace.checkoutTemplate:
  //  - `express`  → 3-col Lizzon layout (Plano | Identificação+Cartão | Resumo)
  //  - `stepper`  → 3-step accordion (Plano → Identificação → Cartão)
  //  - `single`   → 2-col single-page (default)
  const pixels = product.data.pixels ?? [];
  if (product.data.product.isSubscription) {
    return (
      <>
        <TrackingScripts pixels={pixels} />
        <SubscriptionCheckoutView slug={slug} data={product.data} />
      </>
    );
  }
  const tpl = product.data.workspace.checkoutTemplate;
  if (tpl === 'express') {
    return (
      <>
        <TrackingScripts pixels={pixels} />
        <ExpressCheckoutView slug={slug} data={product.data} />
      </>
    );
  }
  if (tpl === 'stepper') {
    return (
      <>
        <TrackingScripts pixels={pixels} />
        <StepperCheckoutView slug={slug} data={product.data} />
      </>
    );
  }
  return (
    <>
      <TrackingScripts pixels={pixels} />
      <CheckoutView slug={slug} data={product.data} />
    </>
  );
}

/**
 * Marketplace + UTM passthrough. Reads `mlid` (marketplace listing id)
 * + `utm_*` from URL search params. Threaded into checkout.submit so
 * the marketplace rollup worker can attribute the eventual paid
 * order back to its exact source click row (no 24h IP heuristic).
 */
function useMarketplaceMeta(): {
  marketplaceListingId: string | undefined;
  utm: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
  };
} {
  const searchParams = useSearchParams();
  return useMemo(() => {
    const mlid = searchParams.get('mlid') ?? undefined;
    const isUuid =
      !!mlid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mlid);
    const utm = {
      source: searchParams.get('utm_source') ?? undefined,
      medium: searchParams.get('utm_medium') ?? undefined,
      campaign: searchParams.get('utm_campaign') ?? undefined,
      content: searchParams.get('utm_content') ?? undefined,
      term: searchParams.get('utm_term') ?? undefined,
    };
    return {
      marketplaceListingId: isUuid ? mlid : undefined,
      utm,
    };
  }, [searchParams]);
}

/**
 * Server-side tracking click-id capture. Reads:
 *   - `_fbp`, `_fbc` from cookies (Meta first-party cookie set by the
 *     browser pixel; falls back to a synthesised fbc when only `fbclid`
 *     URL param is present, per Meta CAPI spec)
 *   - `gclid`  from URL search params (Google Ads click id)
 *   - `ttclid` from URL search params (TikTok click id)
 *
 * Stored in a ref so a re-render between the user identifying and
 * paying doesn't lose the values. Refreshed on mount + on URL change.
 */
function useTrackingClickIds(): {
  fbp?: string;
  fbc?: string;
  gclid?: string;
  ttclid?: string;
} {
  const ref = useRef<{ fbp?: string; fbc?: string; gclid?: string; ttclid?: string }>({});
  const searchParams = useSearchParams();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cookies = Object.fromEntries(
      document.cookie.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k ?? '', decodeURIComponent(v.join('=') ?? '')];
      }),
    );
    const fbp = cookies._fbp || undefined;
    const cookieFbc = cookies._fbc;
    const fbclid = searchParams.get('fbclid');
    // Meta spec: when only fbclid is present, synthesise fbc as
    //   fb.1.{unix_ms}.{fbclid}
    const fbc = cookieFbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined) || undefined;
    ref.current = {
      fbp,
      fbc,
      gclid: searchParams.get('gclid') ?? undefined,
      ttclid: searchParams.get('ttclid') ?? undefined,
    };
  }, [searchParams]);
  return ref.current;
}

function CheckoutView({ slug, data }: { slug: string; data: CheckoutData }) {
  const { product, workspace } = data;
  const clickIds = useTrackingClickIds();
  const marketplaceMeta = useMarketplaceMeta();

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

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifyComplete) {
      setStep('identify');
      return;
    }

    // PCI scope: when the workspace's default gateway is MP and a
    // publishable key is available, tokenize the card in the browser
    // via MP.js v2 so the raw PAN never reaches our server. Falls back
    // to the legacy RAW envelope when MP isn't available or the SDK
    // hiccups.
    const cardPayload =
      method === 'credit_card'
        ? await (async () => {
            const { prepareCardPayload } = await import('../../../lib/mp-tokenize');
            return prepareCardPayload({
              mpPublicKey: data.gateway?.mpPublicKey ?? null,
              cardNumber,
              cardExpiry,
              cardCvc,
              cardHolderName: trimmedHolder,
              documentNumber: doc,
            });
          })()
        : undefined;

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
      card: cardPayload,
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
      clickIds,
      marketplaceListingId: marketplaceMeta.marketplaceListingId,
      utm: marketplaceMeta.utm,
    });
  };

  // Card declined by gateway — show explicit error + retry, NOT success.
  if (
    createOrder.data &&
    createOrder.data.method === 'credit_card' &&
    createOrder.data.status === 'declined'
  ) {
    return (
      <CenteredCard>
        <DeclinedView
          gatewayStatus={createOrder.data.gatewayStatus ?? undefined}
          onRetry={() => createOrder.reset()}
        />
      </CenteredCard>
    );
  }

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          orderId={createOrder.data.orderId}
          viewToken={createOrder.data.viewToken}
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

  /**
   * Per-plan deep link. Producers can share `/c/<slug>?plan=<planId>`
   * so the buyer lands directly on a pre-selected plan and (for
   * stepper template) skips straight to the identification step. The
   * id is validated against the product's actual plans — a stale or
   * tampered id silently falls back to the default highlighted plan.
   */
  const searchParams = useSearchParams();
  const requestedPlanId = searchParams.get('plan');
  const initialPlan = (() => {
    if (requestedPlanId) {
      const match = product.plans.find((p) => p.id === requestedPlanId);
      if (match) return match;
    }
    return product.plans.find((p) => p.isHighlighted) ?? product.plans[0] ?? null;
  })();
  const planPrelocked = !!(requestedPlanId && initialPlan && initialPlan.id === requestedPlanId);
  /**
   * Locked-solo state — the buyer has no real choice on the plan
   * column, either because:
   *   1. there is only ONE active plan, or
   *   2. the producer shared a deep link (`?plan=<id>`) targeting a
   *      specific plan they want pushed.
   *
   * In both cases we render a read-only summary card instead of the
   * picker buttons, so the buyer doesn't see a fake "selecionar" toggle
   * for a plan they can't switch. Express + single + stepper templates
   * all honour the flag.
   */
  const singlePlanLocked = product.plans.length === 1 || planPrelocked;

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(initialPlan?.id ?? null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  // Stepper template walks the buyer through 3 cards sequentially:
  // Plano → Identificação → Cartão. When a deep link pre-selects the
  // plan, jump straight to identification so the buyer doesn't re-pick.
  const [stepperStep, setStepperStep] = useState<'plan' | 'identify' | 'pay'>(
    planPrelocked ? 'identify' : 'plan',
  );

  const subscribe = trpc.subscriptions.subscribe.useMutation();
  const subscribePix = trpc.subscriptions.subscribePix.useMutation();

  const selectedPlan = useMemo(
    () => product.plans.find((p) => p.id === selectedPlanId) ?? null,
    [selectedPlanId, product.plans],
  );

  /**
   * Active payment method for the selected plan. When the plan only
   * supports one method we lock to it; when it supports both, the buyer
   * picks via the Cartão | PIX tabs.
   */
  const planPaymentMethod = selectedPlan?.paymentMethod ?? 'card';
  const [subMethod, setSubMethod] = useState<'card' | 'pix'>(
    planPaymentMethod === 'pix' ? 'pix' : 'card',
  );
  // Sync sub-method when the buyer flips between plans with different
  // payment-method capabilities — e.g. "Mensal (cartão)" vs "Anual (both)".
  useEffect(() => {
    if (planPaymentMethod === 'pix') setSubMethod('pix');
    else if (planPaymentMethod === 'card') setSubMethod('card');
    // 'both' keeps the buyer's previous pick.
  }, [planPaymentMethod]);

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
  const submitting = subscribe.isPending || subscribePix.isPending;
  // PIX requires only identification (no card fields). Card requires both.
  const methodComplete = subMethod === 'pix' ? true : cardComplete;
  const canSubmit = !!selectedPlan && identifyComplete && methodComplete && !submitting;

  /**
   * Step machine for the express template when the plan is locked
   * (single plan OR deep-link `?plan=`). With no plan picker, col 1
   * becomes Identificação; the buyer fills it then taps "Continuar"
   * to unlock col 2 (Cartão). Until that, col 2 renders `pending` /
   * dimmed so focus stays on col 1.
   *
   * When the plan picker IS visible (multi-plan, no deep link), this
   * state is ignored — both cols are simultaneously available, as
   * before.
   */
  const [expressStep, setExpressStep] = useState<'identify' | 'pay'>('identify');
  // If the buyer edits identity later we keep them in 'pay' state
  // when fields stay complete (deliberate jump-back via "Alterar"
  // collapses to 'identify' explicitly).

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPlan) return;

    // PIX path — short-circuits to a different mutation that bypasses
    // the card-token flow and returns a QR + copy-paste payload.
    if (subMethod === 'pix') {
      subscribePix.mutate({
        slug,
        planId: selectedPlan.id,
        buyer: {
          name: name.trim(),
          email: email.trim(),
          document: doc,
          phone,
        },
      });
      return;
    }

    // Card path — production preference is browser-side tokenization
    // via MP.js v2 (the raw PAN never touches our server, PCI scope
    // drops to SAQ-A). When the workspace doesn't have a Mercado Pago
    // publishable key available (other gateways, legacy producers) we
    // fall back to the RAW:<pan>:<mm>:<yy>:<cvv> envelope and the
    // server-side tokenizer in the MP adapter handles it.
    const [mm, yyRaw] = cardExpiry.split('/');
    if (!mm || !yyRaw) return;
    const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    let cardToken: string;
    const mpPublicKey = data.gateway?.mpPublicKey ?? null;
    if (mpPublicKey) {
      try {
        const { tokenizeCard } = await import('../../../lib/mp-tokenize');
        cardToken = await tokenizeCard({
          publishableKey: mpPublicKey,
          cardNumber: cardDigits,
          cardHolderName: trimmedHolder,
          expirationMonth: mm,
          expirationYear: yy,
          securityCode: cardCvc,
          documentNumber: doc,
        });
      } catch (cause) {
        // Fall through to RAW; the server-side tokenizer still works
        // and we surface a structured error to Sentry via the toast.
        // eslint-disable-next-line no-console
        console.warn('mp-tokenize.failed; falling back to RAW', cause);
        cardToken = `RAW:${cardDigits}:${mm}:${yy}:${cardCvc}`;
      }
    } else {
      cardToken = `RAW:${cardDigits}:${mm}:${yy}:${cardCvc}`;
    }
    subscribe.mutate({
      slug,
      planId: selectedPlan.id,
      buyer: {
        name: name.trim(),
        email: email.trim(),
        document: doc,
        phone,
      },
      cardToken,
      cardHolderName: trimmedHolder,
    });
  };

  if (subscribePix.data) {
    return (
      <CenteredCard wide>
        <SubscriptionPixSuccess
          subscriptionId={subscribePix.data.subscriptionId}
          publicReference={subscribePix.data.publicReference}
          pixQrCodeImage={subscribePix.data.pixQrCodeImage}
          pixCopyPaste={subscribePix.data.pixCopyPaste}
          pixExpiresAt={subscribePix.data.pixExpiresAt}
          planName={selectedPlan?.name ?? '—'}
          amountCents={selectedPlan?.amountCents ?? 0}
          billingPeriod={selectedPlan?.billingPeriod ?? 'monthly'}
          buyerEmail={email.trim()}
        />
      </CenteredCard>
    );
  }

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

  // Express 3-column variant for subscriptions. Mirrors the
  // ExpressCheckoutView shape (Plano | Identificação+Cartão | Resumo)
  // but tailored to the recurring flow: only credit card, plan picker
  // gates the payment column instead of an identification step.
  if (workspace.checkoutTemplate === 'express') {
    const planChosen = !!selectedPlan;
    const planState: 'active' | 'done' = planChosen ? 'done' : 'active';
    const payState: 'active' | 'pending' = planChosen ? 'active' : 'pending';
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

        <form
          onSubmit={onSubmit}
          className="container-x mx-auto w-full max-w-[1400px] py-6 sm:py-10"
        >
          {/* Always 3 cols. When the plan is locked, col 1 swaps from
              "Plano picker" to "Identificação" so the buyer's eyes go
              straight to the data they need to fill in. Col 2 then
              holds the card form alone instead of (id + card) stacked. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr_0.9fr]">
            {/* ===== Col 1 — Plano (picker) OR Identificação (locked) ===== */}
            {singlePlanLocked ? (
              <ExpressCard
                stepNum={1}
                label="Identificação"
                state={expressStep === 'identify' ? 'active' : 'done'}
                onEdit={expressStep === 'pay' ? () => setExpressStep('identify') : undefined}
              >
                {expressStep === 'identify' ? (
                  <div className="flex flex-col gap-4">
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                    <button
                      type="button"
                      onClick={() => identifyComplete && setExpressStep('pay')}
                      disabled={!identifyComplete}
                      className="btn btn-primary mt-2 inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                    >
                      Continuar →
                    </button>
                  </div>
                ) : (
                  // Readonly summary once identity is captured. Producer
                  // gets a clean visual of what they typed and an
                  // "Alterar" button on the header to jump back.
                  <dl className="flex flex-col gap-3 text-[13px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="font-medium text-[var(--ink-70)]">Nome</dt>
                      <dd className="truncate text-right font-semibold text-[var(--ink-100)]">
                        {name.trim()}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="font-medium text-[var(--ink-70)]">Email</dt>
                      <dd className="truncate text-right font-semibold text-[var(--ink-100)]">
                        {email.trim()}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="font-medium text-[var(--ink-70)]">CPF / CNPJ</dt>
                      <dd className="text-right font-semibold text-[var(--ink-100)] tabular-nums">
                        {doc}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="font-medium text-[var(--ink-70)]">Telefone</dt>
                      <dd className="text-right font-semibold text-[var(--ink-100)] tabular-nums">
                        {phone}
                      </dd>
                    </div>
                  </dl>
                )}
              </ExpressCard>
            ) : (
              <ExpressCard stepNum={1} label="Plano" state={planState}>
                {product.plans.length === 0 ? (
                  <p className="rounded-xl border border-[var(--hairline)] border-dashed p-4 text-[13px] text-[var(--ink-50)]">
                    Nenhum plano ativo. Avise o produtor.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {product.plans.map((p) => (
                      <PlanPickCard
                        key={p.id}
                        plan={p}
                        selected={p.id === selectedPlanId}
                        onPick={() => setSelectedPlanId(p.id)}
                        annualSavings={
                          p.billingPeriod === 'yearly' && annualSavingsPct > 0
                            ? annualSavingsPct
                            : 0
                        }
                      />
                    ))}
                  </div>
                )}
              </ExpressCard>
            )}

            {/* ===== Col 2 — Identificação + Cartão ===== */}
            <ExpressCard
              stepNum={2}
              label={singlePlanLocked ? 'Cartão de crédito' : 'Pagamento'}
              state={singlePlanLocked ? (expressStep === 'pay' ? 'active' : 'pending') : payState}
            >
              {/* Locked + still on identify step → show a hint instead
                  of the card form so the buyer's eye stays on col 1. */}
              {singlePlanLocked && expressStep === 'identify' ? (
                <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                  Preencha seus dados ao lado para liberar o pagamento.
                </p>
              ) : !planChosen ? (
                <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                  Escolha um plano ao lado para continuar.
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  {/* Identificação fields only render in col 2 when the
                      plan picker is showing in col 1. When locked, col
                      1 already owns the identification form — rendering
                      it here too would duplicate every input. */}
                  {!singlePlanLocked ? (
                    <div className="flex flex-col gap-4">
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
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-1)] p-4">
                    <SubMethodTabs
                      planPaymentMethod={planPaymentMethod}
                      value={subMethod}
                      onChange={setSubMethod}
                    />
                    {subMethod === 'card' ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[13px] text-[var(--ink-100)]">
                            Cartão de crédito
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ink-50)]">
                            <ShieldIcon size={11} /> Renovação automática
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
                      </>
                    ) : (
                      <PixSubscriptionInfo
                        amountCents={selectedPlan?.amountCents ?? 0}
                        currency={selectedPlan?.currency ?? 'BRL'}
                        billingPeriod={selectedPlan?.billingPeriod ?? 'monthly'}
                      />
                    )}
                  </div>

                  {subscribe.error || subscribePix.error ? (
                    <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger-text)] leading-[1.5]">
                      {(subscribe.error ?? subscribePix.error)?.message}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="btn btn-primary inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                  >
                    <LockIcon size={14} />{' '}
                    {submitting
                      ? subMethod === 'pix'
                        ? 'Gerando PIX…'
                        : 'Confirmando assinatura…'
                      : selectedPlan
                        ? subMethod === 'pix'
                          ? `Gerar PIX · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                          : `Assinar · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                        : 'Escolha um plano'}
                  </button>
                  <p className="text-center text-[11px] text-[var(--ink-50)] leading-[1.5]">
                    Cobrança automática. Cancele quando quiser.
                  </p>
                </div>
              )}
            </ExpressCard>

            {/* ===== Col 3 — Resumo + trust ===== */}
            <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
              <div className="glass-card p-5">
                <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.18em]">
                  Sua assinatura
                </p>
                <div className="mt-4 flex items-start gap-3 border-[var(--hairline)] border-b pb-4">
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
                    <p className="font-semibold text-[13px] text-[var(--ink-100)] leading-tight">
                      {product.name}
                    </p>
                    {selectedPlan ? (
                      <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--dop-soft)] px-2 py-0.5 font-semibold text-[10px] text-[var(--dop-600)] uppercase tracking-[0.12em]">
                        {selectedPlan.name}
                      </span>
                    ) : (
                      <p className="mt-1 text-[12px] text-[var(--ink-50)]">Selecione um plano</p>
                    )}
                  </div>
                </div>

                <dl className="mt-4 space-y-2 text-[13px]">
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

                <div className="mt-4 flex items-end justify-between border-[var(--hairline)] border-t pt-4">
                  <span className="font-semibold text-[12px] text-[var(--ink-70)] uppercase tracking-[0.14em]">
                    {selectedPlan?.billingPeriod === 'yearly' ? 'Por ano' : 'Por mês'}
                  </span>
                  <div className="text-right">
                    <span className="font-semibold text-[26px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
                      {selectedPlan
                        ? formatCents(selectedPlan.amountCents, selectedPlan.currency)
                        : '—'}
                    </span>
                    {selectedPlan?.billingPeriod === 'yearly' && annualSavingsPct > 0 ? (
                      <p className="mt-1 font-semibold text-[11px] text-[var(--dop-600)]">
                        economiza {annualSavingsPct}%
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              <ul className="flex flex-col gap-2.5 rounded-2xl border border-[var(--hairline)] bg-[var(--bg-elev-1)] p-4 text-[12px] text-[var(--ink-70)]">
                <TrustItem>Renovação automática segura</TrustItem>
                <TrustItem>Cancele quando quiser</TrustItem>
                <TrustItem>Suporte humano por WhatsApp</TrustItem>
              </ul>
            </aside>
          </div>
        </form>

        <footer className="mt-6 border-[var(--hairline)] border-t bg-[var(--bg-elev-1)]/60">
          <div className="container-x mx-auto flex w-full max-w-[1400px] flex-col items-center gap-1 py-5 text-center text-[11px] text-[var(--ink-50)]">
            <p className="inline-flex flex-wrap items-center justify-center gap-1.5">
              Pagamento processado por{' '}
              <img
                src="/payunivercart-logo.png"
                alt="payunivercart"
                className="inline-block h-[14px] w-auto opacity-80"
              />
              . Ao confirmar, você concorda com os termos do produtor.
            </p>
            <p>🇧🇷 Essa compra está sendo feita no Brasil.</p>
          </div>
        </footer>
      </main>
    );
  }

  // Stepper template — 3-step Plano → Identificação → Cartão flow,
  // mirrors StepperCheckoutView but tailored to recurring (no Pix/boleto).
  if (workspace.checkoutTemplate === 'stepper') {
    const planState: 'active' | 'done' | 'pending' =
      stepperStep === 'plan' ? 'active' : selectedPlan ? 'done' : 'pending';
    const identifyState: 'active' | 'done' | 'pending' =
      stepperStep === 'identify'
        ? 'active'
        : stepperStep === 'pay' && identifyComplete
          ? 'done'
          : 'pending';
    const payState: 'active' | 'done' | 'pending' = stepperStep === 'pay' ? 'active' : 'pending';
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

        <form
          onSubmit={onSubmit}
          className="container-x mx-auto w-full max-w-[1180px] py-6 sm:py-10"
        >
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">
            <div className="flex flex-col gap-5">
              {/* Plano step is hidden completely when the buyer has no
                  choice (single plan OR producer deep-linked). Right
                  sidebar still shows the plan; rendering a redundant
                  step would just slow the buyer down. */}
              {!singlePlanLocked ? (
                <StitchStepCard
                  n={1}
                  label="Escolha seu plano"
                  state={planState}
                  onEdit={stepperStep !== 'plan' ? () => setStepperStep('plan') : undefined}
                >
                  {stepperStep === 'plan' ? (
                    <div className="flex flex-col gap-5">
                      {product.plans.length === 0 ? (
                        <p className="rounded-xl border border-[var(--hairline)] border-dashed p-4 text-[13px] text-[var(--ink-50)]">
                          Nenhum plano ativo. Avise o produtor.
                        </p>
                      ) : (
                        <div
                          className={clsx(
                            'grid gap-4',
                            product.plans.length === 1 && 'grid-cols-1',
                            product.plans.length === 2 && 'grid-cols-1 sm:grid-cols-2',
                            product.plans.length >= 3 &&
                              'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                          )}
                        >
                          {product.plans.map((p) => (
                            <PlanPickCard
                              key={p.id}
                              plan={p}
                              selected={p.id === selectedPlanId}
                              onPick={() => setSelectedPlanId(p.id)}
                              annualSavings={
                                p.billingPeriod === 'yearly' && annualSavingsPct > 0
                                  ? annualSavingsPct
                                  : 0
                              }
                            />
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => selectedPlan && setStepperStep('identify')}
                        disabled={!selectedPlan}
                        className="btn btn-primary mt-1 inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                      >
                        Continuar →
                      </button>
                    </div>
                  ) : (
                    <StitchSummaryGrid
                      items={[
                        { label: 'PLANO', value: selectedPlan?.name ?? '—' },
                        {
                          label: 'PREÇO',
                          value: selectedPlan
                            ? `${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                            : '—',
                        },
                      ]}
                    />
                  )}
                </StitchStepCard>
              ) : null}

              <StitchStepCard
                n={singlePlanLocked ? 1 : 2}
                label="Identificação"
                state={identifyState}
                onEdit={
                  stepperStep === 'pay' && identifyComplete
                    ? () => setStepperStep('identify')
                    : undefined
                }
              >
                {stepperStep === 'identify' ? (
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
                      onClick={() => identifyComplete && setStepperStep('pay')}
                      disabled={!identifyComplete}
                      className="btn btn-primary mt-1 inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                    >
                      Continuar →
                    </button>
                  </div>
                ) : stepperStep === 'pay' ? (
                  <StitchSummaryGrid
                    items={[
                      { label: 'NOME COMPLETO', value: name },
                      { label: 'E-MAIL', value: email },
                      { label: 'CPF / CNPJ', value: doc },
                      { label: 'TELEFONE', value: phone },
                    ]}
                  />
                ) : (
                  <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                    Escolha um plano para continuar.
                  </p>
                )}
              </StitchStepCard>

              <StitchStepCard
                n={singlePlanLocked ? 2 : 3}
                label={subMethod === 'pix' ? 'Pagamento via PIX' : 'Cartão de crédito'}
                state={payState}
              >
                {stepperStep !== 'pay' ? (
                  <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                    Complete os passos acima para escolher o pagamento.
                  </p>
                ) : (
                  <div className="flex flex-col gap-5">
                    <SubMethodTabs
                      planPaymentMethod={planPaymentMethod}
                      value={subMethod}
                      onChange={setSubMethod}
                    />

                    {subMethod === 'card' ? (
                      <>
                        <div className="flex items-center justify-between">
                          <p className="text-[13px] text-[var(--ink-70)] leading-[1.55]">
                            Assinatura recorrente — cobrança automática no cartão.
                          </p>
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ink-50)]">
                            <ShieldIcon size={11} /> Tokenizado
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
                      </>
                    ) : (
                      <PixSubscriptionInfo
                        amountCents={selectedPlan?.amountCents ?? 0}
                        currency={selectedPlan?.currency ?? 'BRL'}
                        billingPeriod={selectedPlan?.billingPeriod ?? 'monthly'}
                      />
                    )}

                    {subscribe.error || subscribePix.error ? (
                      <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger-text)] leading-[1.5]">
                        {(subscribe.error ?? subscribePix.error)?.message}
                      </p>
                    ) : null}

                    <button
                      type="submit"
                      disabled={!canSubmit}
                      className="btn btn-primary inline-flex w-full items-center justify-center gap-3 py-4 text-[16px]"
                    >
                      {submitting
                        ? subMethod === 'pix'
                          ? 'Gerando PIX…'
                          : 'Confirmando assinatura…'
                        : selectedPlan
                          ? subMethod === 'pix'
                            ? `Gerar PIX · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                            : `Assinar · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                          : 'Escolha um plano'}
                    </button>
                    <p className="text-center text-[11px] text-[var(--ink-50)] leading-[1.5]">
                      {subMethod === 'pix'
                        ? 'Cada renovação gera um novo PIX. Avisamos com 3 dias.'
                        : 'Cobrança automática. Cancele quando quiser.'}
                    </p>
                  </div>
                )}
              </StitchStepCard>
            </div>

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
                    {selectedPlan ? (
                      <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--dop-soft)] px-2 py-0.5 font-semibold text-[10px] text-[var(--dop-600)] uppercase tracking-[0.12em]">
                        {selectedPlan.name}
                      </span>
                    ) : (
                      <p className="mt-1 text-[12px] text-[var(--ink-50)]">Selecione um plano</p>
                    )}
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
            {/* Plan section is hidden entirely when the buyer has no
                real choice. Right sidebar already shows the locked
                plan, so the section would be pure noise. */}
            {!singlePlanLocked ? (
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
                  <div
                    className={clsx(
                      'mt-6 grid gap-4',
                      product.plans.length === 1 && 'grid-cols-1',
                      product.plans.length === 2 && 'grid-cols-1 sm:grid-cols-2',
                      product.plans.length >= 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                    )}
                  >
                    {product.plans.map((p) => (
                      <PlanPickCard
                        key={p.id}
                        plan={p}
                        selected={p.id === selectedPlanId}
                        onPick={() => setSelectedPlanId(p.id)}
                        annualSavings={
                          p.billingPeriod === 'yearly' && annualSavingsPct > 0
                            ? annualSavingsPct
                            : 0
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}

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
              {/* Tabs Cartão | PIX — only when the plan accepts both. When
                  the plan is card-only or pix-only we lock the corresponding
                  body without rendering the tabs. */}
              <SubMethodTabs
                planPaymentMethod={planPaymentMethod}
                value={subMethod}
                onChange={setSubMethod}
              />

              {subMethod === 'card' ? (
                <>
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
                </>
              ) : (
                <PixSubscriptionInfo
                  amountCents={selectedPlan?.amountCents ?? 0}
                  currency={selectedPlan?.currency ?? 'BRL'}
                  billingPeriod={selectedPlan?.billingPeriod ?? 'monthly'}
                />
              )}

              {subscribe.error || subscribePix.error ? (
                <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger-text)] leading-[1.5]">
                  {(subscribe.error ?? subscribePix.error)?.message}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!canSubmit}
                className="btn btn-primary inline-flex w-full items-center justify-center gap-3 py-4 text-[16px]"
              >
                {submitting
                  ? subMethod === 'pix'
                    ? 'Gerando PIX…'
                    : 'Confirmando assinatura…'
                  : selectedPlan
                    ? subMethod === 'pix'
                      ? `Gerar PIX · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                      : `Assinar · ${formatCents(selectedPlan.amountCents, selectedPlan.currency)}/${selectedPlan.billingPeriod === 'yearly' ? 'ano' : 'mês'}`
                    : 'Escolha um plano acima'}
              </button>
              <p className="text-center text-[11px] text-[var(--ink-50)] leading-[1.5]">
                {subMethod === 'pix'
                  ? 'Cada renovação gera um novo PIX. Avisamos por WhatsApp + email com 3 dias de antecedência.'
                  : 'Cobrança automática. Cancele quando quiser na sua conta ou pedindo pro produtor.'}
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
                  {selectedPlan ? (
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--dop-soft)] px-2 py-0.5 font-semibold text-[10px] text-[var(--dop-600)] uppercase tracking-[0.12em]">
                      {selectedPlan.name}
                    </span>
                  ) : (
                    <p className="mt-1 text-[12px] text-[var(--ink-50)]">Selecione um plano</p>
                  )}
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
 * Plan card — compact pricing tile sized to live inside narrow grid
 * columns (including Express Col-1 ~340px). Header row carries the
 * period pill, optional "Top" highlight badge, and selection check.
 * Body stacks plan name → price (tabular-nums, capped at 22px so it
 * never overflows) → meta (monthly equivalent, savings, trial). No
 * floating badges, no translate-y — the card stays inside its grid
 * cell at every breakpoint.
 */
// LockedPlanSummary removed — the locked-plan UX now lives in the
// right sidebar badge below the product name. Express col 1 holds
// the Identificação form instead of a redundant plan card.

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
        'group relative flex flex-col items-stretch overflow-hidden rounded-2xl border bg-[var(--surface-1)] p-4 text-left transition-all duration-200 sm:p-5',
        selected
          ? 'border-[var(--dop-500)] bg-[var(--dop-soft)] shadow-[0_8px_24px_-12px_var(--dop-glow)]'
          : plan.isHighlighted
            ? 'border-[var(--dop-hairline)] shadow-[var(--sh-sm)] hover:border-[var(--dop-500)]'
            : 'border-[var(--hairline)] hover:border-[var(--hairline-strong)] hover:bg-[var(--surface-2)]',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={clsx(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-[0.12em]',
              plan.billingPeriod === 'yearly'
                ? 'bg-[var(--dop-soft)] text-[var(--dop-600)]'
                : 'bg-[var(--surface-2)] text-[var(--ink-70)]',
            )}
          >
            {plan.billingPeriod === 'yearly' ? 'Anual' : 'Mensal'}
          </span>
          {plan.isHighlighted ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--dop-500)] px-2 py-0.5 font-semibold text-[10px] text-white uppercase tracking-[0.12em]">
              ★ Top
            </span>
          ) : null}
        </div>
        <span
          className={clsx(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition',
            selected
              ? 'border-[var(--dop-500)] bg-[var(--dop-500)] text-white'
              : 'border-[var(--hairline-strong)] text-transparent group-hover:border-[var(--ink-50)]',
          )}
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            aria-hidden="true"
            focusable="false"
            className="size-3"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
          </svg>
        </span>
      </header>

      <p className="mt-4 truncate font-semibold text-[13px] text-[var(--ink-100)] capitalize leading-tight tracking-[-0.005em]">
        {plan.name}
      </p>

      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-semibold text-[20px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
          {formatCents(plan.amountCents, plan.currency)}
        </span>
        <span className="text-[11px] text-[var(--ink-50)]">/{perWord}</span>
      </div>

      {monthlyEquivalent !== null || annualSavings > 0 || plan.trialDays > 0 ? (
        <div className="mt-2 flex flex-col gap-0.5 text-[11px] leading-[1.35]">
          {monthlyEquivalent !== null ? (
            <span className="text-[var(--ink-50)] tabular-nums">
              ≈ {formatCents(monthlyEquivalent, plan.currency)}/mês
            </span>
          ) : null}
          {annualSavings > 0 ? (
            <span className="font-semibold text-[var(--dop-600)]">
              economize {annualSavings}% vs mensal
            </span>
          ) : null}
          {plan.trialDays > 0 ? (
            <span className="text-[var(--ink-70)]">{plan.trialDays} dias grátis</span>
          ) : null}
        </div>
      ) : null}
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
  const periodLabel = billingPeriod === 'yearly' ? 'ano' : 'mês';
  const formattedAmount = formatCents(amountCents, 'BRL');

  // Browser-side Purchase fire — pairs with the server-side CAPI
  // dispatch from the gateway webhook. Meta dedupes by event_id; the
  // publicReference is stable across both legs so it serves as the
  // dedup key without a shared UUID generator.
  const fireEvent = useFireEvent();
  useEffect(() => {
    if (!isActive) return;
    fireEvent(
      'Purchase',
      {
        value: amountCents / 100,
        currency: 'BRL',
        content_type: 'subscription',
        content_name: planName,
      },
      publicReference,
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: fireEvent identity is stable per mount; refiring on isActive transition is the intent.
  }, [isActive, amountCents, planName, publicReference]);

  return (
    <div className="-mx-2 sm:-mx-4">
      {/* Hero dopamine — mesmo padrão do SuccessView one-time, adaptado
          pro contexto de recorrência. A diferença emocional principal:
          buyer agora é um *assinante* da marca, não um comprador único.
          A microcopy abaixo reforça isso (acesso contínuo, próxima
          cobrança visível desde o segundo 1). */}
      <div className="relative overflow-hidden rounded-3xl border border-[var(--dop-hairline)] bg-gradient-to-br from-[var(--dop-soft)] via-transparent to-transparent p-7 text-center">
        <div
          className="-translate-x-1/2 pointer-events-none absolute top-0 left-1/2 h-64 w-64 rounded-full bg-[var(--dop-500)] opacity-[0.08] blur-3xl"
          aria-hidden
        />
        <SuccessHeroBadge state={isActive ? 'paid' : 'pending'} />
        <p className="relative mt-5 font-semibold text-[11px] text-[var(--dop-700)] uppercase tracking-[0.22em]">
          {isActive ? 'Assinatura ativa' : 'Assinatura criada · aguardando confirmação'}
        </p>
        <h1 className="relative mt-2 font-semibold text-[28px] text-[var(--ink-100)] leading-[1.15] sm:text-[32px]">
          {isActive ? 'Bem-vindo a bordo! 🎉' : 'Confirmando seu pagamento…'}
        </h1>
        <p className="relative mx-auto mt-3 max-w-md text-[14px] text-[var(--ink-70)] leading-[1.55]">
          {isActive ? (
            <>
              Acesso completo liberado em{' '}
              <strong className="text-[var(--ink-100)]">{buyerEmail}</strong> e WhatsApp. Você verá
              tudo em segundos.
            </>
          ) : (
            <>
              Estamos validando o pagamento com o seu banco. Assim que aprovar, mandamos o acesso
              pra <strong className="text-[var(--ink-100)]">{buyerEmail}</strong>.
            </>
          )}
        </p>
        <div className="relative mt-5 inline-flex items-baseline gap-2 rounded-full bg-[var(--surface-1)] px-5 py-2.5 shadow-[var(--sh-sm)]">
          <span className="font-bold text-[22px] text-[var(--ink-100)] tabular-nums">
            {formattedAmount}
          </span>
          <span className="font-medium text-[13px] text-[var(--ink-50)]">/{periodLabel}</span>
        </div>
      </div>

      {/* Card de detalhes da assinatura — visual elevado, hierarchy clara.
          Próxima cobrança é o dado mais importante (anti-churn) → primeiro. */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--dop-hairline)] bg-gradient-to-br from-[var(--dop-soft)] to-transparent p-5">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--dop-500)] text-white">
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <title>Ativa</title>
              <path
                d="M3 8.5l3 3 7-7"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <p className="font-semibold text-[12px] text-[var(--dop-700)] uppercase tracking-[0.16em]">
            Sua assinatura
          </p>
        </div>
        <dl className="mt-4 space-y-3 text-[13px]">
          <Row
            label="Plano"
            value={<strong className="text-[var(--ink-100)]">{planName}</strong>}
          />
          <Row
            label="Cobrança"
            value={
              <span className="text-[var(--ink-100)]">
                {formattedAmount}
                <span className="text-[var(--ink-50)]"> /{periodLabel}</span>
              </span>
            }
          />
          <Row
            label="Próxima cobrança"
            value={
              <span className="text-[var(--ink-100)]">
                {nextChargeAt ? formatExpiresAt(nextChargeAt) : `Daqui a 1 ${periodLabel}`}
              </span>
            }
          />
          <Row label="Código" value={<ReferenceWithCopy reference={publicReference} />} />
        </dl>
      </div>

      {/* Next steps card — reduz ansiedade do "o que faço agora?" e
          posiciona o produto como uma jornada, não uma transação. */}
      <div className="mt-6 rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-5">
        <p className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
          Próximos passos
        </p>
        <ol className="mt-3 space-y-3 text-[13px] text-[var(--ink-90)]">
          {[
            'Confira seu email — link de acesso já está chegando.',
            'No WhatsApp você recebe o link rápido (até 1 minuto).',
            'Antes da próxima cobrança você recebe um lembrete por email.',
          ].map((step, i) => (
            <li key={step} className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--dop-soft)] font-semibold text-[10px] text-[var(--dop-700)]">
                {i + 1}
              </span>
              <span className="leading-[1.55]">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Cancel hint — visível mas não destacado. Transparência reduz
          fricção de subscription, sem virar gatilho de churn. */}
      <p className="mt-6 text-center text-[12px] text-[var(--ink-50)] leading-[1.55]">
        Quer cancelar? Responda o próximo email da cobrança ou fale com o produtor.
      </p>

      {/* Confidence footer — reaproveita os mesmos selos do SuccessView. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-[var(--ink-50)]">
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="lock" /> Pagamento criptografado
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="shield" /> Cancele a qualquer momento
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="chat" /> Suporte por WhatsApp
        </span>
      </div>
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
  const clickIds = useTrackingClickIds();
  const marketplaceMeta = useMarketplaceMeta();

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

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifyComplete) {
      setStep('identify');
      return;
    }

    // PCI scope: when the workspace's default gateway is MP and a
    // publishable key is available, tokenize the card in the browser
    // via MP.js v2 so the raw PAN never reaches our server. Falls back
    // to the legacy RAW envelope when MP isn't available or the SDK
    // hiccups.
    const cardPayload =
      method === 'credit_card'
        ? await (async () => {
            const { prepareCardPayload } = await import('../../../lib/mp-tokenize');
            return prepareCardPayload({
              mpPublicKey: data.gateway?.mpPublicKey ?? null,
              cardNumber,
              cardExpiry,
              cardCvc,
              cardHolderName: trimmedHolder,
              documentNumber: doc,
            });
          })()
        : undefined;

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
      card: cardPayload,
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
      clickIds,
      marketplaceListingId: marketplaceMeta.marketplaceListingId,
      utm: marketplaceMeta.utm,
    });
  };

  // Card declined by gateway — show explicit error + retry, NOT success.
  if (
    createOrder.data &&
    createOrder.data.method === 'credit_card' &&
    createOrder.data.status === 'declined'
  ) {
    return (
      <CenteredCard>
        <DeclinedView
          gatewayStatus={createOrder.data.gatewayStatus ?? undefined}
          onRetry={() => createOrder.reset()}
        />
      </CenteredCard>
    );
  }

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          orderId={createOrder.data.orderId}
          viewToken={createOrder.data.viewToken}
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
    <motion.section
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{
        opacity: state === 'pending' ? 0.7 : 1,
        y: 0,
      }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      className={clsx(
        'glass-card relative overflow-hidden p-6',
        state === 'active' &&
          'shadow-[0_4px_30px_-6px_rgba(15,23,42,0.10)] ring-1 ring-[var(--dop-hairline)]',
      )}
    >
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 360, damping: 26 }}
            className={clsx(
              'flex h-9 w-9 items-center justify-center rounded-full font-bold text-[14px]',
              state === 'done' && 'bg-[var(--dop-500)] text-white',
              state === 'active' && 'bg-[var(--dop-500)] text-white',
              state === 'pending' &&
                'border border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink-50)]',
            )}
          >
            <AnimatePresence mode="wait">
              {state === 'done' ? (
                <motion.span
                  key="done"
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  exit={{ scale: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                >
                  <CheckIcon />
                </motion.span>
              ) : (
                <motion.span
                  key={`n-${n}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  {n}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
          <h2 className="font-semibold text-[18px] text-[var(--ink-100)] tracking-tight">
            {label}
          </h2>
        </div>
        {onEdit && state === 'done' ? (
          <motion.button
            type="button"
            onClick={onEdit}
            whileTap={{ scale: 0.94 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="cursor-pointer font-semibold text-[13px] text-[var(--dop-600)] hover:underline"
          >
            Editar
          </motion.button>
        ) : null}
      </header>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          className={state === 'done' ? 'pl-12' : undefined}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.section>
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

/* -------------------------------------------------------------------------- */
/* ExpressCheckoutView — Lizzon-style 3-column layout                         */
/*                                                                            */
/* Identificação | Pagamento | Resumo side-by-side on desktop. All 3 cards    */
/* visible from the first frame so the buyer sees the entire flow up front —  */
/* highest-converting layout for one-page checkouts with strong product       */
/* fit (Lizzon, Eduzz, Hotmart). On tablet collapses to 2-col (form left +    */
/* summary right), on mobile stacks vertically.                               */
/*                                                                            */
/* State model is intentionally identical to CheckoutView — only the outer    */
/* composition differs. Helpers (Field, MethodTabs, SuccessView, ...) are     */
/* reused as-is.                                                              */
/* -------------------------------------------------------------------------- */

function ExpressCheckoutView({ slug, data }: { slug: string; data: CheckoutData }) {
  const { product, workspace } = data;
  const clickIds = useTrackingClickIds();
  const marketplaceMeta = useMarketplaceMeta();

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

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifyComplete) {
      setStep('identify');
      return;
    }

    // PCI scope: when the workspace's default gateway is MP and a
    // publishable key is available, tokenize the card in the browser
    // via MP.js v2 so the raw PAN never reaches our server. Falls back
    // to the legacy RAW envelope when MP isn't available or the SDK
    // hiccups.
    const cardPayload =
      method === 'credit_card'
        ? await (async () => {
            const { prepareCardPayload } = await import('../../../lib/mp-tokenize');
            return prepareCardPayload({
              mpPublicKey: data.gateway?.mpPublicKey ?? null,
              cardNumber,
              cardExpiry,
              cardCvc,
              cardHolderName: trimmedHolder,
              documentNumber: doc,
            });
          })()
        : undefined;

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
      card: cardPayload,
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
      clickIds,
      marketplaceListingId: marketplaceMeta.marketplaceListingId,
      utm: marketplaceMeta.utm,
    });
  };

  // Card declined by gateway — show explicit error + retry, NOT success.
  if (
    createOrder.data &&
    createOrder.data.method === 'credit_card' &&
    createOrder.data.status === 'declined'
  ) {
    return (
      <CenteredCard>
        <DeclinedView
          gatewayStatus={createOrder.data.gatewayStatus ?? undefined}
          onRetry={() => createOrder.reset()}
        />
      </CenteredCard>
    );
  }

  if (createOrder.data) {
    return (
      <CenteredCard wide>
        <SuccessView
          orderId={createOrder.data.orderId}
          viewToken={createOrder.data.viewToken}
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
  const identifyDone = step === 'pay' && identifyComplete;
  const payActive = step === 'pay';

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

      <form onSubmit={onSubmit} className="container-x mx-auto w-full max-w-[1400px] py-6 sm:py-10">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr_0.9fr]">
          {/* ===== Col 1 — Identificação ===== */}
          <ExpressCard
            stepNum={1}
            label="Identificação"
            state={identifyDone ? 'done' : 'active'}
            onEdit={identifyDone ? () => setStep('identify') : undefined}
          >
            {step === 'identify' ? (
              <div className="flex flex-col gap-4">
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                  onClick={() => identifyComplete && setStep('pay')}
                  disabled={!identifyComplete}
                  className="btn btn-primary mt-1 w-full text-[15px]"
                >
                  Ir para o pagamento →
                </button>
              </div>
            ) : (
              <div className="space-y-3 text-[13px]">
                <div>
                  <p className="font-semibold text-[10px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
                    Dados pessoais
                  </p>
                  <p className="mt-1 font-semibold text-[var(--ink-100)]">{name}</p>
                  <p className="text-[var(--ink-70)]">{email}</p>
                </div>
                <div className="border-[var(--hairline)] border-t pt-3">
                  <p className="text-[var(--ink-70)]">
                    {doc} · {phone}
                  </p>
                </div>
              </div>
            )}
          </ExpressCard>

          {/* ===== Col 2 — Pagamento ===== */}
          <ExpressCard stepNum={2} label="Pagamento" state={payActive ? 'active' : 'pending'}>
            {!payActive ? (
              <p className="text-[13px] text-[var(--ink-50)] leading-[1.55]">
                Complete seus dados de identificação para continuar.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
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
                      O boleto leva até 2 dias úteis. Endereço de cobrança é exigência bancária.
                    </p>
                    <div className="grid grid-cols-[140px_1fr] gap-3">
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
                              ? 'CEP não encontrado'
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
                    <div className="grid grid-cols-[100px_1fr] gap-3">
                      <Field label="Número">
                        <input
                          type="text"
                          value={addrNumber}
                          onChange={(e) => setAddrNumber(e.target.value)}
                          placeholder="123"
                          inputMode="numeric"
                        />
                      </Field>
                      <Field label="Complemento (opcional)">
                        <input
                          type="text"
                          value={addrComplement}
                          onChange={(e) => setAddrComplement(e.target.value)}
                          placeholder="Sala 7…"
                          maxLength={80}
                        />
                      </Field>
                    </div>
                    <div className="grid grid-cols-[1.4fr_1fr_60px] gap-3">
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
                  className="btn btn-primary mt-1 inline-flex w-full items-center justify-center gap-2 py-3 text-[15px]"
                >
                  <LockIcon size={14} />{' '}
                  {createOrder.isPending ? 'Processando…' : `Finalizar pedido · ${formattedTotal}`}
                </button>
                <SecurityLine />
              </div>
            )}
          </ExpressCard>

          {/* ===== Col 3 — Resumo + trust ===== */}
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
                  <p className="font-semibold text-[13px] text-[var(--ink-100)] leading-tight">
                    {product.name}
                  </p>
                  <p className="mt-1 text-[12px] text-[var(--ink-50)]">Quantidade: 1</p>
                </div>
                <p className="shrink-0 font-semibold text-[13px] text-[var(--ink-100)] tabular-nums">
                  {formattedTotal}
                </p>
              </div>

              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--ink-70)]">Subtotal</dt>
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
                <span className="font-semibold text-[12px] text-[var(--ink-70)] uppercase tracking-[0.14em]">
                  Total
                </span>
                <div className="text-right">
                  <span className="font-semibold text-[26px] text-[var(--ink-100)] tabular-nums leading-none tracking-tight">
                    {formattedTotal}
                  </span>
                  {product.maxInstallments > 1 && perInstallment ? (
                    <p className="mt-1 font-semibold text-[11px] text-[var(--dop-600)]">
                      até {product.maxInstallments}× de {perInstallment} sem juros
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <ul className="flex flex-col gap-2.5 rounded-2xl border border-[var(--hairline)] bg-[var(--bg-elev-1)] p-4 text-[12px] text-[var(--ink-70)]">
              <TrustItem>Compra 100% segura e criptografada</TrustItem>
              <TrustItem>Produto entregue por email + WhatsApp</TrustItem>
              <TrustItem>Suporte humano por WhatsApp</TrustItem>
            </ul>
          </aside>
        </div>
      </form>

      <footer className="mt-6 border-[var(--hairline)] border-t bg-[var(--bg-elev-1)]/60">
        <div className="container-x mx-auto flex w-full max-w-[1400px] flex-col items-center gap-1 py-5 text-center text-[11px] text-[var(--ink-50)]">
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
 * Express layout card — single-column inside a 3-col grid. Header is
 * Lizzon-style: "1. Identificação ✓" / "2. Pagamento" with an
 * "ALTERAR" link on done cards.
 */
function ExpressCard({
  stepNum,
  label,
  state,
  children,
  onEdit,
}: {
  stepNum: number;
  label: string;
  state: 'active' | 'done' | 'pending';
  children: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <section
      className={clsx(
        'glass-card relative overflow-hidden p-5 transition',
        state === 'active' && 'ring-1 ring-[var(--dop-hairline)]',
        state === 'pending' && 'opacity-60',
      )}
    >
      <header
        className={clsx(
          'mb-5 flex items-center justify-between border-[var(--hairline)] border-b pb-4',
          state === 'active' && 'text-[var(--dop-600)]',
        )}
      >
        <span className="flex items-center gap-2 font-semibold text-[14px]">
          <span className="font-bold">{stepNum}.</span>
          <span className={state === 'pending' ? 'text-[var(--ink-50)]' : ''}>{label}</span>
          {state === 'done' ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--dop-500)] text-white">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                aria-hidden="true"
                className="size-3"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
              </svg>
            </span>
          ) : null}
        </span>
        {onEdit && state === 'done' ? (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 font-semibold text-[11px] text-[var(--ink-70)] uppercase tracking-[0.14em] hover:text-[var(--ink-100)]"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
              className="size-3"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.5 13.5L5 13l8-8-2.5-2.5-8 8z"
              />
            </svg>
            Alterar
          </button>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function TrustItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--dop-500)] text-white">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          aria-hidden="true"
          className="size-2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}

function LockIcon({ size = 14 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

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
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-[var(--ink-50)] sm:inline">
            🔒 Conexão criptografada · payunivercart
          </span>
          <ThemeToggle compact />
        </div>
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

/**
 * DeclinedView — surfaced when the gateway explicitly rejects a card
 * charge (status `failed` / `cancelled` / `expired`). The previous UX
 * showed the SuccessView for any non-error response, so buyers saw
 * "Compra recebida!" even when their card was refused. The retry
 * button calls `mutation.reset()` so the form re-mounts with the
 * data still typed in.
 */
function DeclinedView({
  gatewayStatus,
  onRetry,
}: {
  gatewayStatus?: string;
  onRetry: () => void;
}) {
  return (
    <div className="text-center">
      <p className="font-semibold text-[11px] text-[var(--danger-text)] uppercase tracking-[0.18em]">
        Pagamento recusado
      </p>
      <h1 className="mt-3 font-semibold text-[24px] text-[var(--ink-100)]">
        Seu cartão foi recusado pela operadora.
      </h1>
      <p className="mt-3 text-[14px] text-[var(--ink-70)] leading-[1.55]">
        Verifique os dados (número, validade, CVV), o limite disponível ou tente outro cartão. Se o
        problema persistir, contate o emissor.
      </p>
      {gatewayStatus ? (
        <p className="mt-2 font-mono text-[11px] text-[var(--ink-50)]">
          Status do gateway: {gatewayStatus}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex items-center justify-center rounded-xl bg-[var(--dop-500)] px-6 py-3 font-semibold text-white shadow-[0_4px_12px_rgba(34,197,94,0.25)] transition hover:bg-[var(--dop-600)]"
      >
        Tentar outro cartão
      </button>
    </div>
  );
}

function SuccessView({
  orderId,
  viewToken,
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
  viewToken: string;
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
    { orderId, viewToken },
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

  // Browser-side Purchase fire — pairs with the server-side CAPI
  // dispatch from the gateway webhook. Meta dedupes by event_id;
  // `reference` is the public order reference, stable across both legs.
  // Value omitted because orderStatus doesn't return totalCents (and
  // the server CAPI fire already carries the canonical amount).
  const fireEvent = useFireEvent();
  useEffect(() => {
    if (!isPaid) return;
    fireEvent('Purchase', { currency: 'BRL', content_type: 'product' }, reference);
    // biome-ignore lint/correctness/useExhaustiveDependencies: fireEvent identity is stable per mount; refiring intentional on paid transition.
  }, [isPaid, reference]);

  return (
    <div className="-mx-2 sm:-mx-4">
      {/* Hero — gradient dopamine, ícone pulsante, headline editorial.
          O hero é o ponto de respiro emocional do checkout: chega aqui
          depois de digitar cartão + esperar gateway, então o primeiro
          frame precisa entregar dopamina + clareza imediata. */}
      <div className="relative overflow-hidden rounded-3xl border border-[var(--dop-hairline)] bg-gradient-to-br from-[var(--dop-soft)] via-transparent to-transparent p-7 text-center">
        <div
          className="-translate-x-1/2 pointer-events-none absolute top-0 left-1/2 h-64 w-64 rounded-full bg-[var(--dop-500)] opacity-[0.08] blur-3xl"
          aria-hidden
        />
        <SuccessHeroBadge
          state={isPaid ? 'paid' : hasPix ? 'pix' : hasBoleto ? 'boleto' : 'pending'}
        />
        <p className="relative mt-5 font-semibold text-[11px] text-[var(--dop-700)] uppercase tracking-[0.22em]">
          {isPaid
            ? 'Pagamento aprovado'
            : hasPix
              ? 'Pix gerado · aguardando pagamento'
              : hasBoleto
                ? 'Boleto pronto · aguardando pagamento'
                : 'Pedido criado'}
        </p>
        <h1 className="relative mt-2 font-semibold text-[28px] text-[var(--ink-100)] leading-[1.15] sm:text-[32px]">
          {isPaid
            ? 'Bem-vindo a bordo! 🎉'
            : hasPix
              ? 'Pague em segundos no seu banco'
              : hasBoleto
                ? 'Pronto. Pague no banco ou app.'
                : 'Recebemos sua compra.'}
        </h1>
        <p className="relative mx-auto mt-3 max-w-md text-[14px] text-[var(--ink-70)] leading-[1.55]">
          {isPaid ? (
            <>
              Confirmação enviada para{' '}
              <strong className="text-[var(--ink-100)]">{buyerEmail}</strong> e WhatsApp. Acesso
              liberado imediatamente.
            </>
          ) : hasPix ? (
            <>
              Após o Pix cair (~10 segundos), liberamos o acesso em{' '}
              <strong className="text-[var(--ink-100)]">{buyerEmail}</strong> e WhatsApp.
            </>
          ) : hasBoleto ? (
            <>
              Boleto compensa em até 2 dias úteis. Acesso vai pra{' '}
              <strong className="text-[var(--ink-100)]">{buyerEmail}</strong> assim que cair.
            </>
          ) : gatewayConfigured ? (
            `Estamos gerando seu ${methodLabel.toLowerCase()}. Em instantes mandamos as instruções pra ${buyerEmail}.`
          ) : (
            `Seu pedido está registrado. O produtor está finalizando o gateway — você receberá as instruções em ${buyerEmail}.`
          )}
        </p>
        <div className="relative mt-5 inline-flex items-baseline gap-2 rounded-full bg-[var(--surface-1)] px-4 py-2 shadow-[var(--sh-sm)]">
          <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
            Valor
          </span>
          <span className="font-bold text-[20px] text-[var(--ink-100)] tabular-nums">
            {formattedTotal}
          </span>
        </div>
      </div>

      {/* Estado-específico — fica fora do hero pra cada método ter
          espaço pra respirar e instruções claras. */}
      {isPaid ? (
        <PaidAccessCard deliveryUrl={deliveryUrl} deliveryInstructions={deliveryInstructions} />
      ) : hasPix ? (
        <PixActionCard
          qrCodeImage={pixQrCodeImage}
          copyPaste={pixCopyPaste}
          expiresAt={pixExpiresAt}
        />
      ) : hasBoleto ? (
        <BoletoActionCard url={boletoUrl} barcode={boletoBarcode} />
      ) : null}

      {/* Detalhes do pedido — compact, sem dominar a tela. */}
      <dl className="mt-6 space-y-3 rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-5 text-[13px]">
        <Row label="Código do pedido" value={<ReferenceWithCopy reference={reference} />} />
        <Row label="Método" value={methodLabel} />
        <Row label="Email" value={<span className="truncate">{buyerEmail}</span>} />
      </dl>

      {/* Confidence footer — selos sutis pra reforçar segurança sem
          virar fricção visual. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-[var(--ink-50)]">
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="lock" /> Pagamento criptografado
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="shield" /> Dados protegidos
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SuccessIcon name="chat" /> Suporte por WhatsApp
        </span>
      </div>
    </div>
  );
}

// ─── Hero badge — anel pulsante quando aguardando, check sólido quando pago.

function SuccessHeroBadge({ state }: { state: 'paid' | 'pix' | 'boleto' | 'pending' }) {
  if (state === 'paid') {
    return (
      <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
        <span
          className="absolute inset-0 animate-ping rounded-full bg-[var(--dop-500)] opacity-30"
          aria-hidden
        />
        <span
          className="absolute inset-0 rounded-full bg-[var(--dop-500)] opacity-20"
          aria-hidden
        />
        <span className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[var(--dop-400)] via-[var(--dop-500)] to-[var(--dop-600)] shadow-[0_8px_24px_-8px_var(--dop-glow)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-white" aria-hidden>
            <title>Pagamento confirmado</title>
            <path
              d="M5 12.5l4 4L19 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
    );
  }
  if (state === 'pix') {
    return (
      <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[var(--dop-400)] via-[var(--dop-500)] to-[var(--dop-600)] shadow-[0_8px_24px_-8px_var(--dop-glow)]">
        <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-white" aria-hidden>
          <title>Pix</title>
          <path
            d="M5.5 12L12 5.5l6.5 6.5-6.5 6.5L5.5 12z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            fill="rgba(255,255,255,0.12)"
          />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
      </div>
    );
  }
  if (state === 'boleto') {
    return (
      <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[var(--dop-400)] via-[var(--dop-500)] to-[var(--dop-600)] shadow-[0_8px_24px_-8px_var(--dop-glow)]">
        <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-white" aria-hidden>
          <title>Boleto bancário</title>
          <path
            d="M4 6v12M7 6v12M10 6v12M13 6v12M16 6v12M19 6v12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }
  return (
    <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-full border-2 border-[var(--dop-500)] bg-[var(--surface-1)]">
      <span className="h-3 w-3 animate-pulse rounded-full bg-[var(--dop-500)]" />
    </div>
  );
}

// ─── Cards específicos por estado

function PaidAccessCard({
  deliveryUrl,
  deliveryInstructions,
}: {
  deliveryUrl: string | null;
  deliveryInstructions: string | null;
}) {
  if (!deliveryUrl && !deliveryInstructions) {
    return (
      <div className="mt-6 rounded-2xl border border-[var(--dop-hairline)] bg-[var(--dop-soft)] p-5 text-center">
        <p className="font-semibold text-[13px] text-[var(--dop-700)]">Acesso a caminho 🚀</p>
        <p className="mt-2 text-[13px] text-[var(--ink-70)] leading-[1.55]">
          Em segundos você recebe o link de acesso por email e WhatsApp.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--dop-hairline)] bg-gradient-to-br from-[var(--dop-soft)] to-transparent p-5">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--dop-500)] text-white">
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <title>Acesso liberado</title>
            <path
              d="M3 8.5l3 3 7-7"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <p className="font-semibold text-[12px] text-[var(--dop-700)] uppercase tracking-[0.16em]">
          Seu acesso está pronto
        </p>
      </div>
      {deliveryUrl ? (
        <a
          href={deliveryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary mt-4 inline-flex w-full items-center justify-center gap-2 text-[15px]"
        >
          Abrir agora
          <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden>
            <title>Abrir em nova aba</title>
            <path
              d="M5 11l6-6M11 5H6M11 5v5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      ) : null}
      {deliveryInstructions ? (
        <p className="mt-4 whitespace-pre-wrap text-[13px] text-[var(--ink-90)] leading-[1.6]">
          {deliveryInstructions}
        </p>
      ) : null}
    </div>
  );
}

function PixActionCard({
  qrCodeImage,
  copyPaste,
  expiresAt,
}: {
  qrCodeImage: string | null;
  copyPaste: string | null;
  expiresAt: Date | string | null;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-5">
      {qrCodeImage ? (
        <div className="flex justify-center">
          <div className="relative rounded-2xl border border-[var(--dop-hairline)] bg-white p-3 shadow-[0_8px_32px_-12px_var(--dop-glow)]">
            <span
              className="-z-10 absolute inset-0 rounded-2xl bg-[var(--dop-500)] opacity-10 blur-2xl"
              aria-hidden
            />
            <img
              src={`data:image/png;base64,${qrCodeImage}`}
              alt="QR-code Pix"
              className="h-56 w-56"
            />
          </div>
        </div>
      ) : null}
      {/* 3-step micro guide — reduz ansiedade do buyer que nunca pagou
          Pix num checkout terceiro. */}
      <ol className="mt-5 grid grid-cols-3 gap-2 text-center text-[11px] text-[var(--ink-70)]">
        {[
          { n: 1, label: 'Abra o app\ndo seu banco' },
          { n: 2, label: 'Escaneie\no QR-code' },
          { n: 3, label: 'Confirme\no pagamento' },
        ].map((step) => (
          <li
            key={step.n}
            className="flex flex-col items-center gap-1.5 rounded-xl bg-[var(--surface-2)] px-2 py-3"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--dop-500)] font-semibold text-[11px] text-white">
              {step.n}
            </span>
            <span className="whitespace-pre-line leading-tight">{step.label}</span>
          </li>
        ))}
      </ol>
      {copyPaste ? <PixCopyButton code={copyPaste} /> : null}
      {expiresAt ? (
        <p className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-center text-[12px] text-[var(--ink-70)]">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            className="h-3.5 w-3.5 text-[var(--ink-50)]"
            aria-hidden
          >
            <title>Validade</title>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 5v3l2 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Pague até <strong className="ml-1">{formatExpiresAt(expiresAt)}</strong>
        </p>
      ) : null}
    </div>
  );
}

function BoletoActionCard({ url, barcode }: { url: string | null; barcode: string | null }) {
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-5">
      <ol className="grid grid-cols-3 gap-2 text-center text-[11px] text-[var(--ink-70)]">
        {[
          { n: 1, label: 'Abra o boleto\nou copie o código' },
          { n: 2, label: 'Pague no app\ndo banco' },
          { n: 3, label: 'Aguarde\ncompensação' },
        ].map((step) => (
          <li
            key={step.n}
            className="flex flex-col items-center gap-1.5 rounded-xl bg-[var(--surface-2)] px-2 py-3"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--dop-500)] font-semibold text-[11px] text-white">
              {step.n}
            </span>
            <span className="whitespace-pre-line leading-tight">{step.label}</span>
          </li>
        ))}
      </ol>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary mt-5 inline-flex w-full items-center justify-center gap-2 text-[15px]"
        >
          Abrir boleto em nova aba
          <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden>
            <title>Abrir em nova aba</title>
            <path
              d="M5 11l6-6M11 5H6M11 5v5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      ) : null}
      {barcode ? <BoletoCopyButton code={barcode} /> : null}
    </div>
  );
}

// ─── Order ref code com botão copy inline

function ReferenceWithCopy({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex items-center gap-1.5 rounded-md font-mono text-[var(--ink-100)] transition hover:text-[var(--dop-600)]"
      title="Copiar código do pedido"
    >
      {reference}
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        className="h-3 w-3 text-[var(--ink-50)] opacity-0 transition group-hover:opacity-100"
        aria-hidden
      >
        <title>Copiar</title>
        {copied ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
        ) : (
          <>
            <rect x="4" y="4" width="9" height="9" rx="1.5" />
            <path d="M11 4V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
          </>
        )}
      </svg>
      {copied ? <span className="text-[11px] text-[var(--dop-600)]">Copiado!</span> : null}
    </button>
  );
}

// ─── Ícones do confidence row

function SuccessIcon({ name }: { name: 'lock' | 'shield' | 'chat' }) {
  const common = 'h-3.5 w-3.5 text-[var(--ink-50)]';
  if (name === 'lock') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={common} aria-hidden>
        <title>Cadeado</title>
        <rect x="3.5" y="7" width="9" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (name === 'shield') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={common} aria-hidden>
        <title>Escudo</title>
        <path
          d="M8 2l5 2v5c0 3-2 5-5 5s-5-2-5-5V4l5-2z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className={common} aria-hidden>
      <title>WhatsApp</title>
      <path
        d="M3 13l1-3a5 5 0 113 3l-4 .5.5-.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
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

/* -------------------------------------------------------------------------- */
/* SubMethodTabs — Cartão | PIX selector for subscription checkout.            */
/*                                                                            */
/* Renders the two-tab control when the plan accepts BOTH methods. When the   */
/* plan locks to a single method we still render a quiet badge so the buyer   */
/* knows what they're paying with — without a non-clickable tab strip.        */
/* -------------------------------------------------------------------------- */
function SubMethodTabs({
  planPaymentMethod,
  value,
  onChange,
}: {
  planPaymentMethod: 'card' | 'pix' | 'both';
  value: 'card' | 'pix';
  onChange: (next: 'card' | 'pix') => void;
}) {
  if (planPaymentMethod !== 'both') {
    return (
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-[11px] text-[var(--ink-50)]">
        <span aria-hidden>{planPaymentMethod === 'pix' ? '⚡' : '💳'}</span>
        <span className="font-semibold uppercase tracking-[0.14em]">
          {planPaymentMethod === 'pix' ? 'Pagamento via PIX' : 'Pagamento no cartão'}
        </span>
      </div>
    );
  }
  return (
    <div
      role="tablist"
      aria-label="Método de pagamento"
      className="inline-flex w-full rounded-2xl border border-[var(--hairline)] bg-[var(--surface-2)] p-1"
    >
      {(['card', 'pix'] as const).map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m)}
            className={
              active
                ? 'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--surface-1)] px-4 py-2.5 font-semibold text-[14px] text-[var(--ink-100)] shadow-[var(--sh-sm)] transition'
                : 'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-medium text-[14px] text-[var(--ink-70)] transition hover:text-[var(--ink-100)]'
            }
          >
            <span aria-hidden>{m === 'pix' ? '⚡' : '💳'}</span>
            {m === 'pix' ? 'PIX' : 'Cartão de crédito'}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PixSubscriptionInfo — informational block shown when the buyer picked PIX. */
/*                                                                            */
/* Recurring PIX doesn't tokenize anything client-side — the buyer simply     */
/* taps "Gerar PIX" and the server returns a QR + copy-paste in the success   */
/* view. This block sets the right expectation BEFORE submit so they're not   */
/* surprised by the QR screen.                                                */
/* -------------------------------------------------------------------------- */
function PixSubscriptionInfo({
  amountCents,
  currency,
  billingPeriod,
}: {
  amountCents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  billingPeriod: 'monthly' | 'yearly';
}) {
  const periodLabel = billingPeriod === 'yearly' ? 'ano' : 'mês';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[18px] text-[var(--ink-100)] tracking-tight">
          Pagar com PIX
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--dop-soft)] px-2.5 py-1 text-[11px] text-[var(--dop-700)]">
          0% tarifa
        </span>
      </div>
      <ul className="flex flex-col gap-2.5 text-[13px] text-[var(--ink-70)] leading-[1.55]">
        <li className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 text-[var(--dop-600)]">
            ⚡
          </span>
          <span>
            QR Code gerado na próxima tela.{' '}
            <span className="font-semibold text-[var(--ink-100)]">
              {formatCents(amountCents, currency)}/{periodLabel}
            </span>
            .
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 text-[var(--dop-600)]">
            ⏱
          </span>
          <span>Pagamento cai em segundos. Acesso liberado na hora.</span>
        </li>
        <li className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 text-[var(--dop-600)]">
            🔁
          </span>
          <span>
            A cada {billingPeriod === 'yearly' ? 'ano' : 'mês'} geramos um novo PIX — você recebe
            por WhatsApp + email com 3 dias de antecedência.
          </span>
        </li>
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* SubscriptionPixSuccess — post-submit QR display for PIX-recurring.         */
/*                                                                            */
/* Polls `subscriptions.status` so the moment the gateway webhook flips the   */
/* row to `active` we collapse the QR and surface the success state. 3s       */
/* cadence matches the one-time PIX flow.                                     */
/* -------------------------------------------------------------------------- */
function SubscriptionPixSuccess({
  subscriptionId,
  publicReference,
  pixQrCodeImage,
  pixCopyPaste,
  pixExpiresAt,
  planName,
  amountCents,
  billingPeriod,
  buyerEmail,
}: {
  subscriptionId: string;
  publicReference: string;
  pixQrCodeImage: string | null;
  pixCopyPaste: string | null;
  pixExpiresAt: Date | string | null;
  planName: string;
  amountCents: number;
  billingPeriod: 'monthly' | 'yearly';
  buyerEmail: string;
}) {
  const live = trpc.subscriptions.status.useQuery(
    { subscriptionId },
    {
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        if (s === 'active' || s === 'cancelled' || s === 'expired') return false;
        return 3_000;
      },
      refetchOnWindowFocus: true,
    },
  );
  const status = live.data?.status ?? 'pending';
  const isActive = status === 'active';

  // Browser-side Purchase fire — pairs with server-side CAPI via
  // publicReference as dedup key.
  const fireEvent = useFireEvent();
  useEffect(() => {
    if (!isActive) return;
    fireEvent(
      'Purchase',
      {
        value: amountCents / 100,
        currency: 'BRL',
        content_type: 'subscription',
        content_name: planName,
      },
      publicReference,
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: fireEvent identity is stable per mount; refiring intentional on active transition.
  }, [isActive, amountCents, planName, publicReference]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!pixCopyPaste) return;
    try {
      await navigator.clipboard.writeText(pixCopyPaste);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can fail in older browsers / insecure contexts;
      // the textarea fallback would show in that case. Silent here.
    }
  };

  const periodLabel = billingPeriod === 'yearly' ? 'ano' : 'mês';
  const expiresLabel = (() => {
    if (!pixExpiresAt) return null;
    const d = new Date(pixExpiresAt);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  })();

  if (isActive) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="grid size-16 place-items-center rounded-full bg-[var(--dop-soft)] text-[var(--dop-600)]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="size-8"
          >
            <title>Confirmado</title>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="font-semibold text-[11px] text-[var(--dop-700)] uppercase tracking-[0.22em]">
          Assinatura ativada
        </p>
        <h1 className="font-semibold text-[28px] text-[var(--ink-100)] leading-[1.15]">
          Bem-vindo a bordo! 🎉
        </h1>
        <p className="max-w-md text-[14px] text-[var(--ink-70)] leading-[1.55]">
          Confirmação enviada para <strong>{buyerEmail}</strong> e WhatsApp. Acesso liberado.
        </p>
        <div className="inline-flex items-baseline gap-2 rounded-full bg-[var(--surface-2)] px-4 py-2">
          <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
            Referência
          </span>
          <span className="font-mono text-[14px] text-[var(--ink-100)]">{publicReference}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col items-center gap-2 text-center">
        <span aria-hidden className="text-[32px]">
          ⚡
        </span>
        <p className="font-semibold text-[11px] text-[var(--dop-700)] uppercase tracking-[0.22em]">
          PIX gerado · aguardando pagamento
        </p>
        <h1 className="font-semibold text-[26px] text-[var(--ink-100)] leading-[1.15]">
          Pague em segundos no seu banco
        </h1>
        <p className="max-w-md text-[13px] text-[var(--ink-70)] leading-[1.55]">
          {planName} · {formatCents(amountCents, 'BRL')}/{periodLabel}
        </p>
      </header>

      {pixQrCodeImage ? (
        <div className="mx-auto flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-5 shadow-[var(--sh-sm)]">
          <img
            src={
              pixQrCodeImage.startsWith('data:') || pixQrCodeImage.startsWith('http')
                ? pixQrCodeImage
                : `data:image/png;base64,${pixQrCodeImage}`
            }
            alt="QR Code PIX"
            className="size-56 rounded-md"
          />
          <p className="text-center text-[11px] text-[var(--ink-50)] leading-[1.4]">
            Abra o app do seu banco, escolha PIX → Ler QR Code e aponte para a imagem.
          </p>
        </div>
      ) : null}

      {pixCopyPaste ? (
        <div className="flex flex-col gap-2">
          <span className="font-semibold text-[11px] text-[var(--ink-50)] uppercase tracking-[0.14em]">
            Ou cole o código PIX
          </span>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={pixCopyPaste}
              className="flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2.5 font-mono text-[12px] text-[var(--ink-100)]"
            />
            <button
              type="button"
              onClick={copy}
              className="btn btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-[13px]"
            >
              {copied ? '✓ Copiado' : 'Copiar'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-3 text-[12px] text-[var(--ink-70)]">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--dop-500)]" />
          <span>Aguardando o PIX cair…</span>
        </div>
        {expiresLabel ? (
          <span className="font-mono text-[11px] text-[var(--ink-50)]">expira {expiresLabel}</span>
        ) : null}
      </div>

      <p className="text-center text-[11px] text-[var(--ink-50)]">
        Assim que o pagamento cair, liberamos o acesso por email e WhatsApp.
      </p>
    </div>
  );
}
