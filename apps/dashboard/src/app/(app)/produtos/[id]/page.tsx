'use client';

import {
  CHECKOUT_BANNER_HEIGHT_MAX_PX,
  CHECKOUT_BANNER_HEIGHT_MIN_PX,
} from '@payunivercart/shared/constants';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';
import { CardIcon, PixIcon } from '../../../../components/PaymentMethodIcons';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { API_URL, CHECKOUT_URL } from '../../../../lib/env';
import { formatCents, parseCentsBRL } from '../../../../lib/money';
import { trpc } from '../../../../lib/trpc';
import {
  type BannerMode,
  CheckoutAppearanceSection,
  DEFAULT_BANNER_BG_COLOR,
  DEFAULT_BANNER_TEXT_COLOR,
  DEFAULT_LAST_CHANCE_MESSAGE,
  DEFAULT_TIMER_MESSAGE,
  DEFAULT_TIMER_MINUTES,
  type TimerDiscountType,
  type TimerExpiredBehavior,
} from './CheckoutAppearanceSection';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Floor the effective price at R$ 1,00 when previewing a countdown
 * discount. Mirrors `MIN_CHARGE_CENTS` in `checkout.ts`: a discount that
 * eats the whole price produces `amount: 0`, which every gateway rejects
 * — and it does so AFTER the order row exists, so the buyer sees a
 * failed payment instead of a cheap one. The server clamps for real;
 * this constant only keeps the preview honest about that clamp.
 */
const MIN_CHARGE_CENTS = 100;

/** Same shape the API enforces on both banner colour columns. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Editar produto — `/produtos/[id]`.
 *
 * Same flat layout as `/produtos/novo`. We pre-load the product via
 * `products.byId` and seed the form state once on first render so
 * controlled inputs work the same way users expect on a fresh form.
 *
 * Cover image: the field's `initialPreviewUrl` points at the public
 * api endpoint so the producer sees the current cover before deciding
 * whether to replace it. Picking a new file replaces the bytes on
 * submit; leaving it untouched leaves the column alone (the API patch
 * omits `cover` when `undefined`).
 */
export default function EditarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const product = trpc.products.byId.useQuery({ id });
  const update = trpc.products.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.products.list.invalidate(), utils.products.byId.invalidate({ id })]);
      toast.success('Produto salvo');
      router.push('/produtos');
    },
    onError: (err) => toast.error(err.message),
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [maxInstallments, setMaxInstallments] = useState(12);
  const [isActive, setIsActive] = useState(true);
  const [cover, setCover] = useState<ImageUpload | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [isSubscription, setIsSubscription] = useState(false);
  // Aparência do checkout. Flat hooks like everything else on this page
  // so each control stays a plain `value` / `onChange` pair; the section
  // component owns no state of its own.
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(DEFAULT_TIMER_MINUTES);
  const [timerMessage, setTimerMessage] = useState(DEFAULT_TIMER_MESSAGE);
  const [timerBehavior, setTimerBehavior] = useState<TimerExpiredBehavior>('restart');
  const [timerLastChanceMessage, setTimerLastChanceMessage] = useState(DEFAULT_LAST_CHANCE_MESSAGE);
  const [timerDiscountOn, setTimerDiscountOn] = useState(false);
  const [timerDiscountType, setTimerDiscountType] = useState<TimerDiscountType>('percent');
  const [timerDiscountPercent, setTimerDiscountPercent] = useState(10);
  const [timerDiscountInput, setTimerDiscountInput] = useState('');
  const [bannerEnabled, setBannerEnabled] = useState(false);
  const [bannerMode, setBannerMode] = useState<BannerMode>('image');
  const [bannerText, setBannerText] = useState('');
  const [bannerBgColor, setBannerBgColor] = useState(DEFAULT_BANNER_BG_COLOR);
  const [bannerTextColor, setBannerTextColor] = useState(DEFAULT_BANNER_TEXT_COLOR);
  const [bannerLinkUrl, setBannerLinkUrl] = useState('');
  const [bannerHeightPx, setBannerHeightPx] = useState<number | null>(null);
  const [bannerImage, setBannerImage] = useState<ImageUpload | null>(null);
  const [bannerImageMobile, setBannerImageMobile] = useState<ImageUpload | null>(null);
  /**
   * "The producer pressed Remover on a banner that was already saved."
   * Distinct from `bannerImage === null`, which is also what the upload
   * field emits when nothing was ever picked — only this flag turns into
   * an explicit `null` on the wire, and only an explicit `null` blanks
   * the bytea + MIME pair on the server.
   */
  const [bannerImageRemoved, setBannerImageRemoved] = useState(false);
  const [bannerImageMobileRemoved, setBannerImageMobileRemoved] = useState(false);

  // Hydrate state once the query resolves. We only seed on the leading
  // edge so subsequent refetches from `invalidate()` don't clobber
  // in-flight edits.
  //
  // EVERY hook above must be seeded here. `onSubmit` posts every scalar
  // unconditionally, so a field left at its `useState` default because
  // nobody added a line below doesn't just fail to load — it silently
  // overwrites the producer's saved configuration the next time they
  // press "Salvar alterações" for an unrelated reason.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !product.data) return;
    setName(product.data.name);
    setDescription(product.data.description ?? '');
    setPriceInput((product.data.priceCents / 100).toFixed(2).replace('.', ','));
    setMaxInstallments(product.data.maxInstallments);
    setIsActive(product.data.isActive);
    setDeliveryUrl(product.data.deliveryUrl ?? '');
    setDeliveryInstructions(product.data.deliveryInstructions ?? '');
    setIsSubscription(product.data.isSubscription);
    setTimerEnabled(product.data.checkoutTimerEnabled);
    setTimerMinutes(product.data.checkoutTimerMinutes);
    // The nullable copy columns seed to the same fallback the public
    // checkout renders for NULL, so the form shows what the buyer sees
    // instead of an empty box that looks like a missing setting.
    setTimerMessage(product.data.checkoutTimerMessage ?? DEFAULT_TIMER_MESSAGE);
    setTimerBehavior(product.data.checkoutTimerExpiredBehavior);
    setTimerLastChanceMessage(
      product.data.checkoutTimerExpiredMessage ?? DEFAULT_LAST_CHANCE_MESSAGE,
    );
    // A NULL discount type IS the "no discount" state — the toggle is
    // derived from it rather than stored, so there's no fourth column to
    // keep in sync.
    setTimerDiscountOn(product.data.checkoutTimerDiscountType != null);
    setTimerDiscountType(product.data.checkoutTimerDiscountType ?? 'percent');
    setTimerDiscountPercent(product.data.checkoutTimerDiscountPercent ?? 10);
    setTimerDiscountInput(
      product.data.checkoutTimerDiscountCents != null
        ? (product.data.checkoutTimerDiscountCents / 100).toFixed(2).replace('.', ',')
        : '',
    );
    setBannerEnabled(product.data.checkoutBannerEnabled);
    setBannerMode(product.data.checkoutBannerType);
    setBannerText(product.data.checkoutBannerText ?? '');
    setBannerBgColor(product.data.checkoutBannerBgColor ?? DEFAULT_BANNER_BG_COLOR);
    setBannerTextColor(product.data.checkoutBannerTextColor ?? DEFAULT_BANNER_TEXT_COLOR);
    setBannerLinkUrl(product.data.checkoutBannerLinkUrl ?? '');
    setBannerHeightPx(product.data.checkoutBannerHeightPx ?? null);
    setSeeded(true);
  }, [product.data, seeded]);

  const priceCents = useMemo(() => parseCentsBRL(priceInput), [priceInput]);
  const previewFormatted =
    Number.isFinite(priceCents) && priceCents > 0 ? formatCents(priceCents, 'BRL') : null;

  if (product.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (product.error || !product.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[15px] text-[var(--color-danger)]">Produto não encontrado.</p>
        <Button variant="ghost" onClick={() => router.push('/produtos')}>
          Voltar
        </Button>
      </div>
    );
  }

  const trimmedName = name.trim();
  // NaN while the field is empty or unparseable — the validation branch
  // below is what turns that into a message instead of a bad payload.
  const timerDiscountCents = parseCentsBRL(timerDiscountInput);
  /**
   * Would this product still show its banner if the producer saved now?
   * `hasBanner` is the saved-bytes sentinel from the API; a fresh pick
   * beats it, an explicit "Remover" cancels it.
   */
  const bannerImageResolved = !!bannerImage || (product.data.hasBanner && !bannerImageRemoved);
  /**
   * Preview-only mirror of `computeTimerDiscountCents` in the API. The
   * server recomputes this from the product row on every order and is
   * the only authority on what gets charged; duplicating the shape here
   * is what lets the live preview show the producer the real number
   * instead of a promise. Integer math throughout, same truncation, same
   * floor — a preview that rounds differently from the charge is worse
   * than no preview.
   */
  const previewDiscountCents = (() => {
    if (isSubscription) return 0;
    if (!timerEnabled || timerBehavior !== 'last_chance' || !timerDiscountOn) return 0;
    if (!Number.isFinite(priceCents) || priceCents <= 0) return 0;
    const raw =
      timerDiscountType === 'percent'
        ? Math.floor((priceCents * timerDiscountPercent) / 100)
        : Number.isFinite(timerDiscountCents)
          ? timerDiscountCents
          : 0;
    const maxDiscount = priceCents > MIN_CHARGE_CENTS ? priceCents - MIN_CHARGE_CENTS : 0;
    if (raw <= 0) return 0;
    return raw > maxDiscount ? maxDiscount : raw;
  })();
  const discountedFormatted =
    previewDiscountCents > 0 ? formatCents(priceCents - previewDiscountCents, 'BRL') : null;

  const validationError = (() => {
    if (trimmedName.length === 0) return 'Informe o nome do produto.';
    if (trimmedName.length > 120) return 'Nome muito longo (máx 120 caracteres).';
    if (description.trim().length > 2000) return 'Descrição muito longa (máx 2000 caracteres).';
    // One-time products precisam de preço base. Subscriptions usam plans.
    if (!isSubscription) {
      if (!Number.isFinite(priceCents) || priceCents <= 0) return 'Informe um preço válido.';
      if (priceCents > 10_000_000) return 'Preço acima do limite (R$ 100.000,00).';
    }
    // Aparência do checkout. Every branch is gated on the toggle that
    // renders its control: blocking the save on a field the producer
    // cannot currently see is a dead end, not a validation.
    if (timerEnabled) {
      if (timerMinutes < 1 || timerMinutes > 1440)
        return 'Duração do cronômetro entre 1 e 1440 minutos.';
      if (!timerMessage.trim()) return 'Escreva a mensagem do cronômetro.';
      if (timerBehavior === 'last_chance') {
        if (!timerLastChanceMessage.trim()) return 'Escreva a mensagem de última chance.';
        if (!isSubscription && timerDiscountOn) {
          if (timerDiscountType === 'percent') {
            if (timerDiscountPercent < 1 || timerDiscountPercent > 90)
              return 'Desconto entre 1% e 90%.';
          } else if (
            !Number.isFinite(timerDiscountCents) ||
            timerDiscountCents <= 0 ||
            timerDiscountCents >= priceCents
          ) {
            return 'O desconto precisa ser menor que o preço.';
          }
        }
      }
    }
    if (bannerEnabled) {
      // An image banner with no bytes renders nothing at all on the
      // checkout — no error, no placeholder, just a producer wondering
      // why the feature is broken. Catch it here instead.
      if (bannerMode === 'image' && !bannerImageResolved) return 'Envie a imagem do banner.';
      if (bannerMode === 'text') {
        if (!bannerText.trim()) return 'Escreva o texto do banner.';
        if (!HEX_COLOR.test(bannerBgColor.trim()))
          return 'Cor de fundo do banner no formato #RRGGBB.';
        if (!HEX_COLOR.test(bannerTextColor.trim()))
          return 'Cor do texto do banner no formato #RRGGBB.';
      }
      const link = bannerLinkUrl.trim();
      if (link && !/^https:\/\//i.test(link))
        return 'O link do banner precisa começar com https://.';
      // Height only applies to image banners. Block an out-of-range value
      // with a clear message instead of letting the API reject it with a
      // raw zod error for a field the producer can see right there.
      if (
        bannerMode === 'image' &&
        bannerHeightPx != null &&
        (bannerHeightPx < CHECKOUT_BANNER_HEIGHT_MIN_PX ||
          bannerHeightPx > CHECKOUT_BANNER_HEIGHT_MAX_PX)
      ) {
        return `A altura do banner precisa ficar entre ${CHECKOUT_BANNER_HEIGHT_MIN_PX} e ${CHECKOUT_BANNER_HEIGHT_MAX_PX} px.`;
      }
    }
    return null;
  })();
  const apiError = update.error?.message ?? null;

  /**
   * The minutes input can legitimately sit at 0 while the producer is
   * retyping it. Validation blocks the save for as long as the control
   * is on screen, but a producer who blanks the field and THEN switches
   * the countdown off would otherwise post a 0 the API rejects — for a
   * field they can no longer see. Fall back to the column default.
   */
  const timerMinutesPayload =
    timerMinutes >= 1 && timerMinutes <= 1440 ? timerMinutes : DEFAULT_TIMER_MINUTES;
  /**
   * The discount travels as a triple, never as a partial. The API
   * rejects a type without its magnitude in the same request (it refuses
   * to merge against stored state, precisely so a half-config can't end
   * up advertising a discount `createOrder` won't honour), so the three
   * fields are always written together — and the whole triple clears to
   * NULL the moment the discount is off, the behaviour is `restart`, or
   * the product is a subscription. Those are exactly the cases where the
   * server would ignore a stored discount anyway; leaving one behind
   * would only make the DB disagree with what this form shows.
   */
  const timerDiscountPayload: {
    checkoutTimerDiscountType: TimerDiscountType | null;
    checkoutTimerDiscountPercent: number | null;
    checkoutTimerDiscountCents: number | null;
  } =
    timerEnabled && timerBehavior === 'last_chance' && timerDiscountOn && !isSubscription
      ? timerDiscountType === 'percent'
        ? {
            checkoutTimerDiscountType: 'percent',
            checkoutTimerDiscountPercent: timerDiscountPercent,
            checkoutTimerDiscountCents: null,
          }
        : {
            checkoutTimerDiscountType: 'fixed',
            checkoutTimerDiscountPercent: null,
            checkoutTimerDiscountCents: timerDiscountCents,
          }
      : {
          checkoutTimerDiscountType: null,
          checkoutTimerDiscountPercent: null,
          checkoutTimerDiscountCents: null,
        };

  /**
   * The three validated strings run their `https://` refine and their
   * `#rrggbb` regex BEFORE `.nullable()` on the API, so posting a blank
   * — or a value that went stale behind a collapsed control — is a 400
   * rather than a clear. Normalise instead of trusting the state:
   * anything that doesn't match goes over the wire as an explicit NULL,
   * which IS the API's "no opinion, fall back to the default" value.
   */
  const bannerBgColorPayload = HEX_COLOR.test(bannerBgColor.trim()) ? bannerBgColor.trim() : null;
  const bannerTextColorPayload = HEX_COLOR.test(bannerTextColor.trim())
    ? bannerTextColor.trim()
    : null;
  const bannerLinkUrlPayload = /^https:\/\//i.test(bannerLinkUrl.trim())
    ? bannerLinkUrl.trim()
    : null;
  // Normalise like the strings above: a valid in-range height goes over
  // the wire, anything else (blank, stale, out of range) becomes an
  // explicit NULL — the API's "fall back to the legacy thin banner".
  // Persisted regardless of mode so flipping to Texto and back doesn't
  // silently wipe a configured height.
  const bannerHeightPxPayload =
    bannerHeightPx != null &&
    bannerHeightPx >= CHECKOUT_BANNER_HEIGHT_MIN_PX &&
    bannerHeightPx <= CHECKOUT_BANNER_HEIGHT_MAX_PX
      ? bannerHeightPx
      : null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError) return;
    update.mutate({
      id,
      name: trimmedName,
      description: description.trim() || null,
      // Don't push priceCents on subscription products — plans own
      // pricing; mutating the offer here would shadow them.
      ...(isSubscription ? {} : { priceCents }),
      maxInstallments,
      isActive,
      isSubscription,
      deliveryUrl: deliveryUrl.trim() || null,
      deliveryInstructions: deliveryInstructions.trim() || null,
      ...(cover ? { cover } : {}),
      // Aparência do checkout. Scalars go unconditionally so the saved
      // row always matches the form — which is exactly why the seeding
      // effect above has to cover every one of them, and why the three
      // validated strings arrive pre-normalised from the consts above
      // instead of raw off the input.
      checkoutTimerEnabled: timerEnabled,
      checkoutTimerMinutes: timerMinutesPayload,
      checkoutTimerMessage: timerMessage.trim() || null,
      checkoutTimerExpiredBehavior: timerBehavior,
      checkoutTimerExpiredMessage: timerLastChanceMessage.trim() || null,
      ...timerDiscountPayload,
      checkoutBannerEnabled: bannerEnabled,
      checkoutBannerType: bannerMode,
      checkoutBannerText: bannerText.trim() || null,
      checkoutBannerBgColor: bannerBgColorPayload,
      checkoutBannerTextColor: bannerTextColorPayload,
      checkoutBannerLinkUrl: bannerLinkUrlPayload,
      checkoutBannerHeightPx: bannerHeightPxPayload,
      // Same conditional spread as the cover, plus the clear path the
      // cover never needed: omitted = untouched, object = replace,
      // explicit null = blank the bytes AND the MIME.
      ...(bannerImage
        ? { checkoutBannerImage: bannerImage }
        : bannerImageRemoved
          ? { checkoutBannerImage: null }
          : {}),
      ...(bannerImageMobile
        ? { checkoutBannerImageMobile: bannerImageMobile }
        : bannerImageMobileRemoved
          ? { checkoutBannerImageMobile: null }
          : {}),
    });
  };

  const publicUrl = `${CHECKOUT_URL}/c/${product.data.slug}`;
  // Cache-bust the cover preview so a fresh upload doesn't get masked
  // by the 5-min Cache-Control on the api endpoint.
  const assetVersion = new Date(product.data.updatedAt).getTime();
  const coverPreviewUrl = product.data.hasCover
    ? `${API_URL}/img/product/${product.data.id}/cover?v=${assetVersion}`
    : null;
  // The API exposes only the `hasBanner*` sentinels, not the MIME
  // strings — the bytes live behind their own public routes precisely so
  // the checkout query never has to select a bytea.
  const bannerPreviewUrl = product.data.hasBanner
    ? `${API_URL}/img/product/${product.data.id}/banner?v=${assetVersion}`
    : null;
  const bannerMobilePreviewUrl = product.data.hasBannerMobile
    ? `${API_URL}/img/product/${product.data.id}/banner-mobile?v=${assetVersion}`
    : null;
  /**
   * The banner as it stands right now: a just-picked file wins over the
   * saved bytes (same rule as the cover), an explicit "Remover" beats
   * both. Feeds the live preview AND the upload fields' own
   * `initialPreviewUrl` — the fields are mounted inside an
   * `AnimatePresence` branch, so flipping the banner between Imagem and
   * Texto remounts them, and seeding them from the raw saved URL would
   * resurrect an image the producer had already removed while the
   * pending clear stayed queued for the save.
   */
  const bannerPreviewSrc = bannerImage
    ? `data:${bannerImage.mime};base64,${bannerImage.base64}`
    : bannerImageRemoved
      ? null
      : bannerPreviewUrl;
  const bannerMobilePreviewSrc = bannerImageMobile
    ? `data:${bannerImageMobile.mime};base64,${bannerImageMobile.base64}`
    : bannerImageMobileRemoved
      ? null
      : bannerMobilePreviewUrl;

  return (
    <motion.div
      className="flex flex-col gap-8"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
    >
      <header className="flex flex-col gap-3">
        <Kicker>catálogo · editar produto</Kicker>
        <Heading level={1}>Editar produto.</Heading>
        <PublicLinkChip url={publicUrl} />
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-7">
          <Field label="Nome do produto">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldInputClass}
              maxLength={120}
            />
          </Field>

          <Field label="Descrição" hint="Opcional.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={`${fieldInputClass} resize-none`}
              maxLength={2000}
            />
          </Field>

          <ImageUploadField
            label="Capa do produto"
            hint="1:1, PNG/JPEG/WEBP, até 2 MB. Deixe como está para manter a capa atual."
            initialPreviewUrl={coverPreviewUrl}
            enforceSquare
            onChange={setCover}
          />

          <ProductTypeSegment value={isSubscription} onChange={setIsSubscription} />

          {!isSubscription ? (
            <div className="grid grid-cols-1 gap-7 md:grid-cols-2">
              <Field
                label="Preço"
                hint={
                  previewFormatted
                    ? `Cliente paga ${previewFormatted}.`
                    : 'Use vírgula como separador decimal.'
                }
              >
                <div className="relative">
                  <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 font-medium text-[14px] text-[var(--color-fg-subtle)]">
                    R$
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={priceInput}
                    onChange={(e) => setPriceInput(e.target.value)}
                    className={`${fieldInputClass} pl-10`}
                  />
                </div>
              </Field>

              <Field label="Parcelamento máximo">
                <select
                  value={maxInstallments}
                  onChange={(e) => setMaxInstallments(Number.parseInt(e.target.value, 10))}
                  className={`${fieldInputClass} appearance-none`}
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}×{n === 1 ? ' (à vista)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : (
            <SubscriptionPlansSection productId={id} productSlug={product.data.slug} />
          )}

          <ActiveToggle
            checked={isActive}
            onChange={setIsActive}
            title="Produto ativo"
            subtitle='Quando desativado, o checkout público mostra "produto indisponível".'
          />

          <CheckoutAppearanceSection
            isSubscription={isSubscription}
            timerEnabled={timerEnabled}
            onTimerEnabledChange={setTimerEnabled}
            timerMinutes={timerMinutes}
            onTimerMinutesChange={setTimerMinutes}
            timerMessage={timerMessage}
            onTimerMessageChange={setTimerMessage}
            timerBehavior={timerBehavior}
            onTimerBehaviorChange={setTimerBehavior}
            timerLastChanceMessage={timerLastChanceMessage}
            onTimerLastChanceMessageChange={setTimerLastChanceMessage}
            timerDiscountOn={timerDiscountOn}
            onTimerDiscountOnChange={setTimerDiscountOn}
            timerDiscountType={timerDiscountType}
            onTimerDiscountTypeChange={setTimerDiscountType}
            timerDiscountPercent={timerDiscountPercent}
            onTimerDiscountPercentChange={setTimerDiscountPercent}
            timerDiscountInput={timerDiscountInput}
            onTimerDiscountInputChange={setTimerDiscountInput}
            bannerEnabled={bannerEnabled}
            onBannerEnabledChange={setBannerEnabled}
            bannerMode={bannerMode}
            onBannerModeChange={setBannerMode}
            bannerImagePreviewUrl={bannerPreviewSrc}
            onBannerImageChange={(next) => {
              setBannerImage(next);
              // Picking a file supersedes an earlier "Remover" in the
              // same editing session — otherwise the clear would still
              // be pending behind the upload.
              if (next) setBannerImageRemoved(false);
            }}
            onBannerImageClear={() => {
              setBannerImage(null);
              setBannerImageRemoved(true);
            }}
            bannerImageMobilePreviewUrl={bannerMobilePreviewSrc}
            onBannerImageMobileChange={(next) => {
              setBannerImageMobile(next);
              if (next) setBannerImageMobileRemoved(false);
            }}
            onBannerImageMobileClear={() => {
              setBannerImageMobile(null);
              setBannerImageMobileRemoved(true);
            }}
            bannerText={bannerText}
            onBannerTextChange={setBannerText}
            bannerBgColor={bannerBgColor}
            onBannerBgColorChange={setBannerBgColor}
            bannerTextColor={bannerTextColor}
            onBannerTextColorChange={setBannerTextColor}
            bannerLinkUrl={bannerLinkUrl}
            onBannerLinkUrlChange={setBannerLinkUrl}
            bannerHeightPx={bannerHeightPx}
            onBannerHeightPxChange={setBannerHeightPx}
          />

          <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
            <header className="flex flex-col gap-1">
              <span className="font-medium text-[13px] text-[var(--color-fg)]">
                Entrega pós-compra
              </span>
              <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
                Quando o pagamento for confirmado, mandamos esses dados pro comprador por email e
                WhatsApp. Use o link da área de membros, do grupo, do Drive — o que servir como
                entrega.
              </span>
            </header>
            <Field
              label="Link de entrega"
              hint="Opcional. Pode ser área de membros, Drive, Discord…"
            >
              <input
                type="url"
                value={deliveryUrl}
                onChange={(e) => setDeliveryUrl(e.target.value)}
                className={fieldInputClass}
                placeholder="https://"
                maxLength={500}
                inputMode="url"
              />
            </Field>
            <Field
              label="Instruções"
              hint="Opcional. Texto curto que aparece junto ao link no email + WhatsApp."
            >
              <textarea
                value={deliveryInstructions}
                onChange={(e) => setDeliveryInstructions(e.target.value)}
                rows={3}
                className={`${fieldInputClass} resize-none`}
                placeholder="Ex.: acesse com o mesmo email que você usou na compra…"
                maxLength={1000}
              />
            </Field>
          </section>

          {validationError ? (
            <p className="text-[13px] text-[var(--color-danger)]">{validationError}</p>
          ) : null}
          {apiError ? <p className="text-[13px] text-[var(--color-danger)]">{apiError}</p> : null}

          <div className="flex items-center gap-3 border-[var(--color-border)] border-t pt-6">
            <PrimaryCta type="submit" disabled={!!validationError || update.isPending}>
              {update.isPending ? 'Salvando…' : 'Salvar alterações'}
            </PrimaryCta>
            <Button type="button" variant="ghost" onClick={() => router.push('/produtos')}>
              Cancelar
            </Button>
          </div>
        </form>
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <EditLivePreview
              name={trimmedName}
              description={description.trim()}
              coverPreviewUrl={coverPreviewUrl}
              coverOverride={cover}
              isSubscription={isSubscription}
              priceFormatted={previewFormatted}
              discountedPriceFormatted={discountedFormatted}
              isActive={isActive}
              banner={{
                enabled: bannerEnabled,
                mode: bannerMode,
                imageSrc: bannerPreviewSrc,
                text: bannerText,
                bgColor: bannerBgColor,
                textColor: bannerTextColor,
              }}
              timer={{
                enabled: timerEnabled,
                minutes: timerMinutes,
                message: timerMessage,
                behavior: timerBehavior,
                lastChanceMessage: timerLastChanceMessage,
              }}
            />
          </div>
        </aside>
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Public link chip                                                           */
/* -------------------------------------------------------------------------- */

function PublicLinkChip({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="inline-flex w-fit items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <span className="font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
        Link público
      </span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="max-w-[260px] truncate font-mono text-[12px] text-[var(--color-fg)] hover:text-[var(--color-brand-600)] sm:max-w-none"
      >
        {url.replace(/^https?:\/\//, '')}
      </a>
      <motion.button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          } catch {
            toast.error('Não foi possível copiar');
          }
        }}
        whileTap={{ scale: 0.92 }}
        className="grid size-7 cursor-pointer place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-brand-50)] hover:text-[var(--color-brand-700)]"
        aria-label={copied ? 'Copiado' : 'Copiar link'}
      >
        <AnimatePresence mode="wait">
          {copied ? (
            <motion.svg
              key="check"
              initial={{ scale: 0.5, rotate: -20, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 360, damping: 22 }}
              viewBox="0 0 16 16"
              fill="none"
              className="size-3.5 text-[var(--color-brand-700)]"
            >
              <title>Copiado</title>
              <path
                d="M3 8.5l3 3 7-7"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </motion.svg>
          ) : (
            <motion.svg
              key="copy"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              viewBox="0 0 16 16"
              fill="none"
              className="size-3.5"
            >
              <title>Copiar</title>
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M3 11V4a1 1 0 011-1h7"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </motion.svg>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Live preview                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two appearance slices the preview mocks. Named aliases rather than
 * the inline literals the rest of this file uses, because each one is
 * referenced by both `EditLivePreview` and its child — three copies of
 * a six-field literal is exactly how a preview drifts from the form.
 */
type PreviewBanner = {
  enabled: boolean;
  mode: BannerMode;
  /** Base64 of a just-picked file, the saved bytes' public URL, or NULL
   *  when neither exists (the producer removed it, or never uploaded). */
  imageSrc: string | null;
  text: string;
  bgColor: string;
  textColor: string;
};

type PreviewTimer = {
  enabled: boolean;
  minutes: number;
  message: string;
  behavior: TimerExpiredBehavior;
  lastChanceMessage: string;
};

function EditLivePreview({
  name,
  description,
  coverPreviewUrl,
  coverOverride,
  isSubscription,
  priceFormatted,
  discountedPriceFormatted,
  isActive,
  banner,
  timer,
}: {
  name: string;
  description: string;
  coverPreviewUrl: string | null;
  coverOverride: ImageUpload | null;
  isSubscription: boolean;
  priceFormatted: string | null;
  /** NULL unless a last-chance discount is configured AND honourable.
   *  When set, the list price renders struck through beside it — the
   *  same treatment the checkout gives the expired state. */
  discountedPriceFormatted: string | null;
  isActive: boolean;
  /** Mocked full-bleed, above the card body, because on the real page
   *  the banner sits above the producer's brand header — anything less
   *  would preview a layout the buyer never sees. */
  banner: PreviewBanner;
  timer: PreviewTimer;
}) {
  const coverSrc = coverOverride
    ? `data:${coverOverride.mime};base64,${coverOverride.base64}`
    : coverPreviewUrl;
  return (
    <motion.div
      className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_56px_-16px_rgba(0,0,0,0.25)]"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <div className="border-[var(--color-border)] border-b bg-gradient-to-br from-[var(--color-brand-50)] via-[var(--color-surface)] to-transparent px-4 py-3">
        <p className="font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-[0.14em]">
          Pré-visualização ao vivo
        </p>
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          {isActive ? 'Comprador vê assim agora.' : '⚠ Inativo — checkout mostra indisponível.'}
        </p>
      </div>
      {banner.enabled ? <PreviewTopBanner banner={banner} /> : null}
      <div className="flex flex-col gap-4 p-4">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={name || 'Produto'}
            className="aspect-square w-full rounded-xl object-cover"
          />
        ) : (
          <div className="grid aspect-square w-full place-items-center rounded-xl bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]">
            <svg viewBox="0 0 24 24" fill="none" className="size-8" aria-hidden>
              <title>Sem capa</title>
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" />
              <circle cx="9" cy="11" r="1.5" fill="currentColor" />
              <path d="M3 17l5-5 6 6 4-4 3 3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold text-[15px] text-[var(--color-fg)] leading-tight">
            {name || 'Nome do seu produto'}
          </h3>
          {description ? (
            <p className="line-clamp-3 text-[12px] text-[var(--color-fg-muted)] leading-[1.5]">
              {description}
            </p>
          ) : (
            <p className="text-[12px] text-[var(--color-fg-subtle)] italic">
              Descrição aparecerá aqui.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          {priceFormatted ? (
            <>
              {discountedPriceFormatted ? (
                <span className="text-[14px] text-[var(--color-fg-subtle)] line-through">
                  {priceFormatted}
                </span>
              ) : null}
              <span className="font-bold text-[24px] text-[var(--color-fg)] tracking-tight">
                {discountedPriceFormatted ?? priceFormatted}
              </span>
              {isSubscription ? (
                <span className="text-[12px] text-[var(--color-fg-subtle)]">/mês</span>
              ) : null}
              {discountedPriceFormatted ? (
                <span className="text-[11px] text-[var(--color-fg-subtle)]">
                  após o cronômetro zerar
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-[14px] text-[var(--color-fg-subtle)] italic">R$ —</span>
          )}
        </div>
        {timer.enabled ? <PreviewTimerBar timer={timer} /> : null}
        <button
          type="button"
          disabled
          className={
            isActive
              ? 'mt-1 cursor-not-allowed rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-4 py-2.5 font-semibold text-[13px] text-white opacity-90 shadow-sm'
              : 'mt-1 cursor-not-allowed rounded-xl bg-[var(--color-surface-muted)] px-4 py-2.5 font-semibold text-[13px] text-[var(--color-fg-subtle)]'
          }
        >
          {isActive ? 'Pagar agora' : 'Produto indisponível'}
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Promo banner mock. Full bleed inside the preview card and one line
 * tall, mirroring where it lands on the checkout — above the producer's
 * brand header, above everything.
 *
 * The producer's own hexes are applied as an inline `style`, which is
 * the single sanctioned exception to this codebase's tokens-only rule:
 * they are user data, and no CSS custom property can hold a value that
 * differs per product.
 */
function PreviewTopBanner({ banner }: { banner: PreviewBanner }) {
  if (banner.mode === 'text') {
    return (
      <div
        className="px-4 py-2 text-center font-medium text-[11px] leading-[1.4]"
        style={{ backgroundColor: banner.bgColor, color: banner.textColor }}
      >
        {banner.text.trim() || 'Texto do banner'}
      </div>
    );
  }
  return banner.imageSrc ? (
    <img src={banner.imageSrc} alt="" className="h-12 w-full object-cover" />
  ) : (
    <div className="grid h-12 w-full place-items-center border-[var(--color-border)] border-b border-dashed bg-[var(--color-surface-muted)] text-[11px] text-[var(--color-fg-subtle)]">
      Banner sem imagem
    </div>
  );
}

/**
 * Countdown mock, pinned just above the CTA where the real bar renders.
 * Deliberately shows the RUNNING state with the clock at its full
 * duration — that is what every buyer sees on first open, and it is the
 * only state a static preview can honestly claim. When the producer
 * picked `last_chance` we spell the second state out in a caption
 * instead of faking a countdown that never moves.
 */
function PreviewTimerBar({ timer }: { timer: PreviewTimer }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-brand-500)]/30 bg-[var(--color-brand-50)]/60 px-3 py-2">
        <span className="min-w-0 text-[11px] text-[var(--color-brand-700)] leading-[1.4]">
          {timer.message.trim() || 'Oferta por tempo limitado'}
        </span>
        <span className="shrink-0 font-semibold text-[13px] text-[var(--color-brand-700)] tabular-nums">
          {formatMinutesClock(timer.minutes)}
        </span>
      </div>
      {timer.behavior === 'last_chance' ? (
        <span className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.4]">
          Ao zerar: {timer.lastChanceMessage.trim() || 'mensagem de última chance'}
        </span>
      ) : (
        <span className="text-[11px] text-[var(--color-fg-subtle)] leading-[1.4]">
          Ao zerar: o ciclo recomeça do tempo cheio.
        </span>
      )}
    </div>
  );
}

/**
 * Minutes → the clock face the buyer sees at second zero. Grows a hours
 * segment past 60 so a 24-hour countdown doesn't read as "1440:00".
 */
function formatMinutesClock(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}:00`
    : `${String(rest).padStart(2, '0')}:00`;
}

/* -------------------------------------------------------------------------- */
/* Primary CTA — gradient + spring                                            */
/* -------------------------------------------------------------------------- */

function PrimaryCta({
  children,
  type = 'button',
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.16, ease: EASE }}
      className={
        disabled
          ? 'inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-[var(--color-surface-muted)] px-4 py-2.5 font-semibold text-[14px] text-[var(--color-fg-subtle)]'
          : 'inline-flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-4 py-2.5 font-semibold text-[14px] text-white shadow-[0_10px_24px_-8px_rgba(22,163,74,0.45)] transition hover:brightness-110'
      }
    >
      {children}
    </motion.button>
  );
}

const fieldInputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

/* -------------------------------------------------------------------------- */
/* ActiveToggle — motion switch                                               */
/* -------------------------------------------------------------------------- */

function ActiveToggle({
  checked,
  onChange,
  title,
  subtitle,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  subtitle: string;
}) {
  return (
    <div
      className={
        checked
          ? 'flex cursor-pointer items-center gap-4 rounded-xl border border-[var(--color-brand-500)]/40 bg-gradient-to-br from-[var(--color-brand-50)]/40 via-[var(--color-surface)] to-[var(--color-surface)] px-4 py-3.5 transition'
          : 'flex cursor-pointer items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 transition'
      }
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      role="switch"
      aria-checked={checked}
      tabIndex={0}
    >
      <motion.span
        className={
          checked
            ? 'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] p-0.5 shadow-inner'
            : 'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-[var(--color-surface-muted)] p-0.5'
        }
        aria-hidden
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 480, damping: 32 }}
          className={
            checked
              ? 'ml-auto block size-5 rounded-full bg-white shadow'
              : 'block size-5 rounded-full bg-white shadow'
          }
        />
      </motion.span>
      <div className="flex flex-col">
        <span className="font-medium text-[14px] text-[var(--color-fg)]">{title}</span>
        <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">{subtitle}</span>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; biome can't trace into children, but HTML label semantics still focus the first descendant control on click.
    <label className="flex flex-col gap-2">
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}

/**
 * Type segment — toggles between "compra única" and "assinatura
 * recorrente". Renders as a two-card pick so the producer sees the
 * trade-offs side-by-side instead of a binary switch hidden in a row.
 */
function ProductTypeSegment({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <p className="mb-3 font-medium text-[13px] text-[var(--color-fg-muted)]">Tipo de produto</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TypeCard
          selected={!value}
          onClick={() => onChange(false)}
          title="Compra única"
          subtitle="Cobrança avulsa"
          description="Pix, cartão ou boleto. Buyer paga uma vez e recebe o acesso."
        />
        <TypeCard
          selected={value}
          onClick={() => onChange(true)}
          title="Assinatura"
          subtitle="Cobrança recorrente"
          description="Cartão de crédito mensal ou anual. Mercado Pago renova automaticamente."
        />
      </div>
    </div>
  );
}

function TypeCard({
  selected,
  onClick,
  title,
  subtitle,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  description: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={
        selected
          ? 'group flex cursor-pointer flex-col items-start gap-2 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
          : 'group flex cursor-pointer flex-col items-start gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]'
      }
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</span>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">{subtitle}</span>
        </div>
        <AnimatePresence>
          {selected ? (
            <motion.span
              key="check"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 22 }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] text-white shadow-sm"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                aria-hidden="true"
                className="size-3.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
              </svg>
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">{description}</p>
    </motion.button>
  );
}

/**
 * Plans CRUD inline. Lists plans for this product + inline form to
 * add a new one. Edit happens via a small popover, delete via the
 * deleteRow action with the FK restriction handled server-side.
 */
function SubscriptionPlansSection({
  productId,
  productSlug,
}: {
  productId: string;
  productSlug: string;
}) {
  const utils = trpc.useUtils();
  const [copiedPlanId, setCopiedPlanId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  /**
   * Plan id whose payment-methods picker is currently expanded. Only one
   * plan can be in edit mode at a time so the producer doesn't get a
   * wall of pickers when they have many plans.
   */
  const [editingMethodsPlanId, setEditingMethodsPlanId] = useState<string | null>(null);
  const copyPlanLink = async (planId: string) => {
    const url = `${CHECKOUT_URL}/c/${productSlug}?plan=${planId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPlanId(planId);
      window.setTimeout(() => setCopiedPlanId((prev) => (prev === planId ? null : prev)), 1800);
    } catch {
      window.prompt('Copie o link manualmente:', url);
    }
  };
  const plans = trpc.subscriptions.listPlans.useQuery({ productId }, { staleTime: 15_000 });
  const create = trpc.subscriptions.createPlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
  });
  const update = trpc.subscriptions.updatePlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.subscriptions.deletePlan.useMutation({
    onSuccess: () => utils.subscriptions.listPlans.invalidate({ productId }),
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('monthly');
  const [price, setPrice] = useState('');
  const [trial, setTrial] = useState(0);
  /**
   * Methods this plan accepts. `card` = preapproval engine, `pix` = the
   * PIX cycle worker generates a fresh charge per period, `both` = buyer
   * picks at checkout. Default `card` so existing producers don't see
   * behaviour change.
   */
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'pix' | 'both'>('card');
  /**
   * Univercart Connect — partner + role this plan provisions access to.
   * Both fields are nullable and travel together (validated server-side).
   * When the producer picks a partner, we fetch its role catalogue and
   * surface a second dropdown.
   */
  const [partnerAccountId, setPartnerAccountId] = useState<string | null>(null);
  const [partnerRoleSlug, setPartnerRoleSlug] = useState<string | null>(null);
  const partnersQuery = trpc.partners.list.useQuery(undefined, { staleTime: 60_000 });
  const partnerRolesQuery = trpc.partners.listRoles.useQuery(
    { partnerId: partnerAccountId ?? '' },
    { enabled: !!partnerAccountId, staleTime: 60_000 },
  );

  const submit = () => {
    const cents = parseCentsBRL(price);
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) return;
    create.mutate(
      {
        productId,
        name: name.trim(),
        billingPeriod: period,
        amountCents: cents,
        trialDays: trial,
        paymentMethod,
        partnerAccountId,
        partnerRoleSlug,
      },
      {
        onSuccess: () => {
          setAdding(false);
          setName('');
          setPrice('');
          setTrial(0);
          setPeriod('monthly');
          setPaymentMethod('card');
          setPartnerAccountId(null);
          setPartnerRoleSlug(null);
        },
      },
    );
  };

  return (
    <>
      {deleteTarget && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismisses via Cancel button (keyboard-accessible); div onClick is a mouse-only convenience.
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
          onClick={() => setDeleteTarget(null)}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation; card content is interactive via real buttons. */}
          <div
            className="mx-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">Excluir plano?</h3>
            <p className="mt-2 text-[14px] text-[var(--color-fg-muted)] leading-[1.5]">
              <span className="font-medium text-[var(--color-fg)]">"{deleteTarget.name}"</span> será
              removido permanentemente.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  remove.mutate({ id: deleteTarget.id });
                  setDeleteTarget(null);
                }}
                disabled={remove.isPending}
              >
                Excluir
              </Button>
            </div>
          </div>
        </div>
      )}
      <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-medium text-[13px] text-[var(--color-fg)]">
              Planos da assinatura
            </span>
            <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
              Crie 1 ou mais planos (ex: Mensal R$ 49,90 · Anual R$ 499). Buyer escolhe no checkout.
              Marque um como "Mais escolhido" pra destacar.
            </span>
          </div>
          {!adding ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--color-brand-500)] px-3 py-2 font-semibold text-[13px] text-white transition hover:bg-[var(--color-brand-600)]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
                className="size-3.5"
              >
                <path strokeLinecap="round" d="M8 3v10M3 8h10" />
              </svg>
              Novo plano
            </button>
          ) : null}
        </header>

        {plans.isPending ? (
          <p className="text-[13px] text-[var(--color-fg-subtle)]">Carregando planos…</p>
        ) : plans.data && plans.data.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {plans.data.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${
                    p.billingPeriod === 'yearly'
                      ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                      : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
                  }`}
                >
                  {p.billingPeriod === 'yearly' ? 'Anual' : 'Mensal'}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[14px] text-[var(--color-fg)]">
                      {p.name}
                    </span>
                    <PlanMethodsBadge paymentMethod={p.paymentMethod} />
                  </div>
                  <span className="text-[12px] text-[var(--color-fg-subtle)]">
                    {p.trialDays > 0 ? `${p.trialDays} dias de trial · ` : ''}
                    {p.isActive ? 'Ativo' : 'Desativado'}
                    {p.partnerAccountId && p.partnerRoleSlug ? (
                      <>
                        {' · '}
                        <span
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--color-brand-50)] px-1.5 py-0.5 font-medium text-[10px] text-[var(--color-brand-700)] uppercase tracking-wider"
                          title="Plano provisiona acesso no SaaS parceiro via Univercart Connect"
                        >
                          Connect → {p.partnerRoleSlug}
                        </span>
                      </>
                    ) : (
                      <>
                        {' · '}
                        <span
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--color-warning-bg)] px-1.5 py-0.5 font-medium text-[10px] text-[var(--color-warning)] uppercase tracking-wider"
                          title="Buyer só recebe email com deliveryUrl estático. Sem auto-login no SaaS parceiro."
                        >
                          ⚠ Sem Connect
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <PlanPriceEditor
                  planId={p.id}
                  amountCents={p.amountCents}
                  period={p.billingPeriod as 'monthly' | 'yearly'}
                  onSave={(cents) =>
                    update.mutate(
                      { id: p.id, amountCents: cents },
                      { onSuccess: () => toast.success('Preço atualizado') },
                    )
                  }
                  isSaving={update.isPending}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copyPlanLink(p.id)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium text-[12px] transition ${
                      copiedPlanId === p.id
                        ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                        : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                    }`}
                    title="Link de checkout pré-selecionando este plano"
                  >
                    {copiedPlanId === p.id ? (
                      <>
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          aria-hidden="true"
                          className="size-3"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5l3 3 7-7" />
                        </svg>
                        Link copiado
                      </>
                    ) : (
                      <>
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          aria-hidden="true"
                          className="size-3.5"
                        >
                          <rect x="4" y="4" width="9" height="9" rx="1.5" />
                          <path d="M11 4V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
                        </svg>
                        Copiar link
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => update.mutate({ id: p.id, isHighlighted: !p.isHighlighted })}
                    className={`rounded-lg px-3 py-1.5 font-medium text-[12px] transition ${
                      p.isHighlighted
                        ? 'bg-[var(--color-brand-500)] text-white hover:bg-[var(--color-brand-600)]'
                        : 'border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]'
                    }`}
                    title="Destaca esse plano no checkout"
                  >
                    {p.isHighlighted ? '★ Destaque' : '☆ Destacar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingMethodsPlanId((prev) => (prev === p.id ? null : p.id))}
                    className={`rounded-lg px-3 py-1.5 font-medium text-[12px] transition ${
                      editingMethodsPlanId === p.id
                        ? 'border border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                        : 'border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
                    }`}
                    title="Alterar métodos de pagamento aceitos"
                  >
                    Métodos
                  </button>
                  <button
                    type="button"
                    onClick={() => update.mutate({ id: p.id, isActive: !p.isActive })}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)]"
                  >
                    {p.isActive ? 'Desativar' : 'Ativar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-danger)] transition hover:border-[var(--color-danger)]"
                  >
                    Excluir
                  </button>
                </div>
                {editingMethodsPlanId === p.id ? (
                  <div className="mt-3 flex flex-col gap-2 border-[var(--color-border)] border-t pt-3">
                    <span className="font-medium text-[12px] text-[var(--color-fg-muted)]">
                      Métodos de pagamento aceitos
                    </span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {(['card', 'pix', 'both'] as const).map((m) => {
                        const meta =
                          m === 'card'
                            ? {
                                title: 'Cartão de crédito',
                                subtitle: 'Cobrança recorrente automática',
                                badge: 'Padrão',
                              }
                            : m === 'pix'
                              ? {
                                  title: 'PIX',
                                  subtitle: 'Nova cobrança gerada a cada ciclo',
                                  badge: '0% tarifa',
                                }
                              : {
                                  title: 'Ambos',
                                  subtitle: 'Cliente escolhe no checkout',
                                  badge: 'Recomendado',
                                };
                        return (
                          <PaymentMethodCard
                            key={m}
                            active={p.paymentMethod === m}
                            onClick={() => {
                              if (p.paymentMethod === m) {
                                setEditingMethodsPlanId(null);
                                return;
                              }
                              update.mutate(
                                { id: p.id, paymentMethod: m },
                                {
                                  onSuccess: () => {
                                    toast.success(`Métodos atualizados: ${meta.title}`);
                                    setEditingMethodsPlanId(null);
                                  },
                                },
                              );
                            }}
                            title={meta.title}
                            subtitle={meta.subtitle}
                            badge={meta.badge}
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-fg-subtle)]">
            Sem planos cadastrados ainda. Adicione pelo menos um pra abrir o checkout pra
            compradores.
          </p>
        )}

        {adding ? (
          <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-brand-500)]/40 bg-[var(--color-surface)] p-5 ring-4 ring-[var(--color-brand-500)]/10">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px_140px_100px]">
              <Field label="Nome do plano">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={fieldInputClass}
                  placeholder="Ex.: Mensal Premium"
                  maxLength={80}
                />
              </Field>
              <Field label="Período">
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as 'monthly' | 'yearly')}
                  className={`${fieldInputClass} appearance-none`}
                >
                  <option value="monthly">Mensal</option>
                  <option value="yearly">Anual</option>
                </select>
              </Field>
              <Field label="Preço">
                <div className="relative">
                  <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 font-medium text-[14px] text-[var(--color-fg-subtle)]">
                    R$
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className={`${fieldInputClass} pl-10`}
                    placeholder="49,90"
                  />
                </div>
              </Field>
              <Field label="Trial (dias)">
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={trial}
                  onChange={(e) => setTrial(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                  className={fieldInputClass}
                />
              </Field>
            </div>

            {/* Métodos de pagamento aceitos. */}
            <div className="flex flex-col gap-2">
              <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">
                Métodos de pagamento aceitos
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <PaymentMethodCard
                  active={paymentMethod === 'card'}
                  onClick={() => setPaymentMethod('card')}
                  title="Cartão de crédito"
                  subtitle="Cobrança recorrente automática"
                  badge="Padrão"
                />
                <PaymentMethodCard
                  active={paymentMethod === 'pix'}
                  onClick={() => setPaymentMethod('pix')}
                  title="PIX"
                  subtitle="Nova cobrança gerada a cada ciclo"
                  badge="0% tarifa"
                />
                <PaymentMethodCard
                  active={paymentMethod === 'both'}
                  onClick={() => setPaymentMethod('both')}
                  title="Ambos"
                  subtitle="Cliente escolhe no checkout"
                  badge="Recomendado"
                />
              </div>
            </div>

            {/* Univercart Connect: optional SaaS partner mapping. */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Univercart Connect (opcional)"
                hint="SaaS parceiro liberado quando o pagamento for confirmado."
              >
                <select
                  value={partnerAccountId ?? ''}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setPartnerAccountId(next);
                    setPartnerRoleSlug(null);
                  }}
                  className={`${fieldInputClass} appearance-none`}
                >
                  <option value="">Nenhum (entrega manual)</option>
                  {(partnersQuery.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Papel no SaaS"
                hint="Slug que o SaaS espera receber (entry / medium / ultra...)."
              >
                <select
                  value={partnerRoleSlug ?? ''}
                  onChange={(e) => setPartnerRoleSlug(e.target.value || null)}
                  disabled={!partnerAccountId}
                  className={`${fieldInputClass} appearance-none disabled:opacity-50`}
                >
                  <option value="">{partnerAccountId ? 'Escolher papel…' : '—'}</option>
                  {(partnerRolesQuery.data ?? []).map((r) => (
                    <option key={r.slug} value={r.slug}>
                      {r.displayName} ({r.slug})
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {create.error ? (
              <p className="text-[13px] text-[var(--color-danger)]">{create.error.message}</p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={submit} disabled={create.isPending}>
                {create.isPending ? 'Criando…' : 'Adicionar plano'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

/**
 * Inline price editor para planos de assinatura.
 * Click no preço → input R$ → Enter/blur salva, Esc cancela.
 */
function PlanPriceEditor({
  amountCents,
  period,
  onSave,
  isSaving,
}: {
  planId: string;
  amountCents: number;
  period: 'monthly' | 'yearly';
  onSave: (cents: number) => void;
  isSaving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setVal((amountCents / 100).toFixed(2).replace('.', ','));
    setEditing(true);
    window.setTimeout(() => inputRef.current?.select(), 30);
  };

  const save = () => {
    const cents = parseCentsBRL(val);
    if (!Number.isFinite(cents) || cents < 100 || cents > 10_000_000) {
      toast.error('Preço inválido (mín R$ 1,00 / máx R$ 100.000)');
      setEditing(false);
      return;
    }
    if (cents === amountCents) {
      setEditing(false);
      return;
    }
    onSave(cents);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <div className="relative">
          <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 font-medium text-[13px] text-[var(--color-fg-subtle)]">
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
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={save}
            disabled={isSaving}
            className="w-28 rounded-lg border border-[var(--color-brand-500)] bg-[var(--color-surface)] py-1.5 pr-2 pl-8 font-semibold text-[14px] text-[var(--color-fg)] tabular-nums outline-none ring-2 ring-[var(--color-brand-500)]/20"
          />
        </div>
        <span className="text-[11px] text-[var(--color-fg-subtle)]">
          /{period === 'yearly' ? 'ano' : 'mês'}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      title="Clique para editar o preço"
      className="group flex items-baseline gap-1 rounded-md px-1 py-0.5 transition hover:bg-[var(--color-surface-muted)]"
    >
      <span className="font-semibold text-[16px] text-[var(--color-fg)] tabular-nums group-hover:text-[var(--color-brand-600)]">
        {formatCents(amountCents, 'BRL')}
      </span>
      <span className="text-[11px] text-[var(--color-fg-subtle)]">
        /{period === 'yearly' ? 'ano' : 'mês'}
      </span>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="ml-1 size-3 text-[var(--color-brand-600)] opacity-0 transition group-hover:opacity-100"
        aria-hidden
      >
        <title>Editar preço</title>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 2.5l2 2L5 13l-3 .5.5-3 9-8z" />
      </svg>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* PlanMethodsBadge — compact pill shown next to a plan's name in the list.    */
/*                                                                            */
/* Tells the producer at a glance which methods buyers can use without        */
/* expanding the picker. Color is monochrome so it never competes with the    */
/* Connect / "Sem Connect" badge that already lives on the same row.          */
/* -------------------------------------------------------------------------- */
function PlanMethodsBadge({ paymentMethod }: { paymentMethod: 'card' | 'pix' | 'both' }) {
  return (
    <span
      title="Métodos de pagamento aceitos por este plano"
      className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-medium text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wider"
    >
      {paymentMethod === 'pix' ? (
        <>
          <PixIcon size={12} tone="brand" />
          PIX
        </>
      ) : paymentMethod === 'both' ? (
        <>
          <CardIcon size={12} />
          <span aria-hidden>+</span>
          <PixIcon size={12} tone="brand" />
          Cartão & PIX
        </>
      ) : (
        <>
          <CardIcon size={12} />
          Cartão
        </>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* PaymentMethodCard — selectable tile used in the "Métodos aceitos" picker.   */
/*                                                                            */
/* Renders as a button so keyboard activation (Enter/Space) toggles selection */
/* without extra handlers; the surrounding <form> isn't submitted because     */
/* `type="button"` is explicit. Active state uses the brand ring pattern used */
/* across the dashboard so the picker matches the rest of the surface.        */
/* -------------------------------------------------------------------------- */
function PaymentMethodCard({
  active,
  onClick,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  badge: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'relative flex cursor-pointer flex-col gap-1.5 rounded-xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-4 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
          : 'relative flex cursor-pointer flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition hover:border-[var(--color-brand-500)]/60 hover:bg-[var(--color-surface-muted)]/30'
      }
    >
      <div className="flex items-center gap-2">
        {active ? (
          <span
            aria-hidden
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-500)] text-white shadow-sm"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="size-3"
            >
              <title>Selecionado</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8.5L7 11.5 12 5.5" />
            </svg>
          </span>
        ) : (
          <span
            aria-hidden
            className="inline-flex size-5 shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)]"
          />
        )}
        <span className="flex-1 font-semibold text-[14px] text-[var(--color-fg)]">{title}</span>
        <span
          className={
            active
              ? 'rounded-full bg-[var(--color-brand-500)] px-2 py-0.5 font-semibold text-[10px] text-white uppercase tracking-wider'
              : 'rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider'
          }
        >
          {badge}
        </span>
      </div>
      <span className="pl-7 text-[12px] text-[var(--color-fg-muted)] leading-[1.4]">
        {subtitle}
      </span>
    </button>
  );
}
