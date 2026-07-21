'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Aparência do checkout — the per-product scarcity countdown and the
 * promotional top banner, extracted out of `[id]/page.tsx` because that
 * page is already 1400+ lines with eight top-level components and this
 * section alone is a dozen controls.
 *
 * It owns no state. Every value and every setter is prop-drilled from
 * the page, so the seeding effect there stays the single place that
 * decides what a saved product looks like in the form — the section
 * cannot quietly introduce a second source of truth for a
 * price-affecting field.
 *
 * `Field`, `fieldInputClass`, `ActiveToggle` and `TypeCard` are copied
 * from the page rather than imported. That is the house pattern (they
 * are already module-local and duplicated per page, see
 * `configuracoes/marca/page.tsx`), and the alternative — exporting them
 * from a Next route module — would put non-route exports in a
 * `page.tsx`. A real extraction of the dashboard's form primitives is a
 * refactor of its own, not something to start mid-feature.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three discriminants, declared as plain literal unions exactly like
 * `'monthly' | 'yearly'` and `'card' | 'pix' | 'both'` elsewhere in this
 * route. They mirror the `as const` tuples in
 * `@payunivercart/shared/checkout-timer`, which is deliberately NOT
 * imported here: that module pulls `node:crypto`, and the only existing
 * dashboard import of the shared package reaches for an explicit
 * subpath (`@payunivercart/shared/webhooks/events`) precisely to keep
 * `node:*` schemes out of the client bundle.
 */
export type TimerExpiredBehavior = 'restart' | 'last_chance';
export type TimerDiscountType = 'percent' | 'fixed';
export type BannerMode = 'image' | 'text';

/**
 * Seed values for the columns that are nullable at rest.
 *
 * `DEFAULT_TIMER_MESSAGE` is the exact string `checkout.getBySlug`
 * substitutes when `checkout_timer_message` is NULL, so a producer who
 * never touched the field sees in the form precisely what the buyer
 * already sees on the page — no invisible default, no surprise on the
 * first save.
 *
 * `DEFAULT_TIMER_MINUTES` mirrors the column default (15) and is also
 * the payload fallback: the minutes input can legitimately sit at 0
 * while the producer retypes it, and that transient value must never
 * reach an API that rejects it with a 400.
 */
export const DEFAULT_TIMER_MESSAGE = 'Oferta por tempo limitado';
export const DEFAULT_LAST_CHANCE_MESSAGE = 'Última chance: essa condição encerra agora.';
export const DEFAULT_TIMER_MINUTES = 15;
export const DEFAULT_BANNER_BG_COLOR = '#111827';
export const DEFAULT_BANNER_TEXT_COLOR = '#ffffff';

/** Hex the `<input type="color">` swatch falls back to while the paired
 *  text field holds a half-typed value. Without it the browser silently
 *  resets the picker to black and the producer sees the swatch fight
 *  what they are typing. */
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX_FALLBACK = '#000000';

/* -------------------------------------------------------------------------- */
/* Section                                                                    */
/* -------------------------------------------------------------------------- */

export function CheckoutAppearanceSection({
  isSubscription,
  timerEnabled,
  onTimerEnabledChange,
  timerMinutes,
  onTimerMinutesChange,
  timerMessage,
  onTimerMessageChange,
  timerBehavior,
  onTimerBehaviorChange,
  timerLastChanceMessage,
  onTimerLastChanceMessageChange,
  timerDiscountOn,
  onTimerDiscountOnChange,
  timerDiscountType,
  onTimerDiscountTypeChange,
  timerDiscountPercent,
  onTimerDiscountPercentChange,
  timerDiscountInput,
  onTimerDiscountInputChange,
  bannerEnabled,
  onBannerEnabledChange,
  bannerMode,
  onBannerModeChange,
  bannerImagePreviewUrl,
  onBannerImageChange,
  onBannerImageClear,
  bannerImageMobilePreviewUrl,
  onBannerImageMobileChange,
  onBannerImageMobileClear,
  bannerText,
  onBannerTextChange,
  bannerBgColor,
  onBannerBgColorChange,
  bannerTextColor,
  onBannerTextColorChange,
  bannerLinkUrl,
  onBannerLinkUrlChange,
}: {
  /** Subscriptions price off `subscription_plans` and never pass
   *  through `createOrder`, so the server has no path to honour a
   *  countdown discount on them. We hide the discount controls instead
   *  of letting the producer configure something that silently never
   *  applies; the countdown itself still renders as urgency copy. */
  isSubscription: boolean;
  timerEnabled: boolean;
  onTimerEnabledChange: (next: boolean) => void;
  timerMinutes: number;
  onTimerMinutesChange: (next: number) => void;
  timerMessage: string;
  onTimerMessageChange: (next: string) => void;
  timerBehavior: TimerExpiredBehavior;
  onTimerBehaviorChange: (next: TimerExpiredBehavior) => void;
  timerLastChanceMessage: string;
  onTimerLastChanceMessageChange: (next: string) => void;
  timerDiscountOn: boolean;
  onTimerDiscountOnChange: (next: boolean) => void;
  timerDiscountType: TimerDiscountType;
  onTimerDiscountTypeChange: (next: TimerDiscountType) => void;
  timerDiscountPercent: number;
  onTimerDiscountPercentChange: (next: number) => void;
  /** Free-form `R$` string, parsed with `parseCentsBRL` by the page —
   *  same contract as the product's own price field. */
  timerDiscountInput: string;
  onTimerDiscountInputChange: (next: string) => void;
  bannerEnabled: boolean;
  onBannerEnabledChange: (next: boolean) => void;
  bannerMode: BannerMode;
  onBannerModeChange: (next: BannerMode) => void;
  /** The banner as it stands right now — a `data:` URL for a file
   *  picked in this session, the public `/img/product/:id/banner` route
   *  for saved bytes, or NULL when there is nothing to show. Resolved by
   *  the page rather than here because these fields remount whenever the
   *  producer flips between Imagem and Texto. */
  bannerImagePreviewUrl: string | null;
  onBannerImageChange: (next: ImageUpload | null) => void;
  /** Fired only by the field's explicit "Remover" button — the page
   *  turns it into an explicit `null` on the wire, which is what blanks
   *  the column. `onChange(null)` alone cannot mean that: the field also
   *  emits it when a picked file fails the MIME or size check. */
  onBannerImageClear: () => void;
  bannerImageMobilePreviewUrl: string | null;
  onBannerImageMobileChange: (next: ImageUpload | null) => void;
  onBannerImageMobileClear: () => void;
  bannerText: string;
  onBannerTextChange: (next: string) => void;
  bannerBgColor: string;
  onBannerBgColorChange: (next: string) => void;
  bannerTextColor: string;
  onBannerTextColorChange: (next: string) => void;
  bannerLinkUrl: string;
  onBannerLinkUrlChange: (next: string) => void;
}) {
  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
      <header className="flex flex-col gap-1">
        <span className="font-medium text-[13px] text-[var(--color-fg)]">
          Aparência do checkout
        </span>
        <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
          Dois recursos que mexem direto na conversão da página de pagamento: um cronômetro que
          começa a contar quando cada comprador abre o seu link, e uma faixa promocional no topo.
          Valem só pra este produto — seus outros checkouts continuam como estão.
        </span>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Cronômetro de escassez                                           */}
      {/* ---------------------------------------------------------------- */}

      <ActiveToggle
        checked={timerEnabled}
        onChange={onTimerEnabledChange}
        title="Cronômetro de escassez"
        subtitle="O relógio começa quando cada comprador abre o seu link, não numa data fixa. Quem abrir amanhã vê o mesmo tempo de quem abriu hoje, e recarregar a página não reinicia a contagem."
      />

      <AnimatePresence initial={false}>
        {timerEnabled ? (
          <motion.div
            key="timer-config"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex flex-col gap-5"
          >
            <div className="grid grid-cols-1 gap-5 md:grid-cols-[160px_minmax(0,1fr)]">
              <Field label="Duração (minutos)" hint="De 1 a 1440 (24 horas).">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  value={timerMinutes}
                  onChange={(e) => onTimerMinutesChange(Number.parseInt(e.target.value, 10) || 0)}
                  className={fieldInputClass}
                />
              </Field>
              <Field
                label="Mensagem enquanto roda"
                hint="Aparece ao lado do relógio. Máx 120 caracteres."
              >
                <input
                  type="text"
                  value={timerMessage}
                  onChange={(e) => onTimerMessageChange(e.target.value)}
                  className={fieldInputClass}
                  placeholder={DEFAULT_TIMER_MESSAGE}
                  maxLength={120}
                />
              </Field>
            </div>

            <div>
              <p className="mb-3 font-medium text-[13px] text-[var(--color-fg-muted)]">
                Quando o cronômetro zerar
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <TypeCard
                  selected={timerBehavior === 'restart'}
                  onClick={() => onTimerBehaviorChange('restart')}
                  title="Reiniciar o ciclo"
                  subtitle="Urgência perene"
                  description="O relógio volta ao tempo cheio e segue rodando. Ninguém vê a oferta como encerrada — funciona melhor pra tráfego frio que chega o tempo todo."
                />
                <TypeCard
                  selected={timerBehavior === 'last_chance'}
                  onClick={() => onTimerBehaviorChange('last_chance')}
                  title="Última chance"
                  subtitle="Trava em 00:00"
                  description="O relógio para em 00:00 e a mensagem muda. Se você configurar um desconto, ele passa a valer daí em diante — quem confere o tempo de espera é o servidor, não o navegador do comprador."
                />
              </div>
            </div>

            <AnimatePresence mode="wait">
              {timerBehavior === 'last_chance' ? (
                <motion.div
                  key="last-chance"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="flex flex-col gap-5"
                >
                  <Field
                    label="Mensagem de última chance"
                    hint="Substitui a mensagem acima assim que o relógio zera. Máx 120 caracteres."
                  >
                    <input
                      type="text"
                      value={timerLastChanceMessage}
                      onChange={(e) => onTimerLastChanceMessageChange(e.target.value)}
                      className={fieldInputClass}
                      placeholder={DEFAULT_LAST_CHANCE_MESSAGE}
                      maxLength={120}
                    />
                  </Field>

                  {isSubscription ? (
                    <p className="rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-4 py-3 text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
                      Assinaturas cobram pelo valor do plano, que não passa pelo mesmo cálculo do
                      checkout avulso — por isso o desconto de última chance não se aplica aqui. O
                      cronômetro continua aparecendo como urgência.
                    </p>
                  ) : (
                    <>
                      <ActiveToggle
                        checked={timerDiscountOn}
                        onChange={onTimerDiscountOnChange}
                        title="Aplicar desconto na última chance"
                        subtitle="O preço cai sozinho pra quem esperou o tempo inteiro. Quem abrir agora e tentar pular a espera paga o preço cheio: o valor é recalculado no servidor, o navegador nunca manda um preço."
                      />

                      <AnimatePresence initial={false}>
                        {timerDiscountOn ? (
                          <motion.div
                            key="discount-config"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.2, ease: EASE }}
                            className="flex flex-col gap-5"
                          >
                            <div className="flex flex-col gap-2">
                              <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">
                                Tipo de desconto
                              </span>
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <ChoiceCard
                                  active={timerDiscountType === 'percent'}
                                  onClick={() => onTimerDiscountTypeChange('percent')}
                                  title="Porcentagem"
                                  subtitle="Abate um % do preço cheio"
                                />
                                <ChoiceCard
                                  active={timerDiscountType === 'fixed'}
                                  onClick={() => onTimerDiscountTypeChange('fixed')}
                                  title="Valor fixo"
                                  subtitle="Abate um valor em reais"
                                />
                              </div>
                            </div>

                            {timerDiscountType === 'percent' ? (
                              <Field
                                label="Desconto (%)"
                                hint="De 1% a 90%. Acima disso o valor cobrado ficaria baixo demais e o gateway recusaria a cobrança."
                              >
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  max={90}
                                  value={timerDiscountPercent}
                                  onChange={(e) =>
                                    onTimerDiscountPercentChange(
                                      Number.parseInt(e.target.value, 10) || 0,
                                    )
                                  }
                                  className={fieldInputClass}
                                />
                              </Field>
                            ) : (
                              <Field
                                label="Desconto (R$)"
                                hint="Precisa ser menor que o preço — sempre sobra pelo menos R$ 1,00 pra cobrar."
                              >
                                <div className="relative">
                                  <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 font-medium text-[14px] text-[var(--color-fg-subtle)]">
                                    R$
                                  </span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={timerDiscountInput}
                                    onChange={(e) => onTimerDiscountInputChange(e.target.value)}
                                    className={`${fieldInputClass} pl-10`}
                                    placeholder="20,00"
                                  />
                                </div>
                              </Field>
                            )}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="h-px bg-[var(--color-border)]" aria-hidden />

      {/* ---------------------------------------------------------------- */}
      {/* Banner de topo                                                   */}
      {/* ---------------------------------------------------------------- */}

      <ActiveToggle
        checked={bannerEnabled}
        onChange={onBannerEnabledChange}
        title="Banner de topo"
        subtitle="Faixa que ocupa a largura inteira acima do cabeçalho da sua marca no checkout. Serve pra anunciar bônus, prazo ou condição especial antes do comprador olhar o preço."
      />

      <AnimatePresence initial={false}>
        {bannerEnabled ? (
          <motion.div
            key="banner-config"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex flex-col gap-5"
          >
            <div>
              <p className="mb-3 font-medium text-[13px] text-[var(--color-fg-muted)]">
                Tipo de banner
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <TypeCard
                  selected={bannerMode === 'image'}
                  onClick={() => onBannerModeChange('image')}
                  title="Imagem"
                  subtitle="Arte pronta"
                  description="Você sobe o arquivo. Dá pra mandar uma versão separada pra celular, porque uma arte 16:5 vira um fiapo ilegível numa tela de 375px."
                />
                <TypeCard
                  selected={bannerMode === 'text'}
                  onClick={() => onBannerModeChange('text')}
                  title="Texto"
                  subtitle="Uma frase colorida"
                  description="Uma frase com as cores que você escolher. Carrega instantâneo, nunca fica pixelada e se adapta sozinha a qualquer largura de tela."
                />
              </div>
            </div>

            <AnimatePresence mode="wait">
              {bannerMode === 'image' ? (
                <motion.div
                  key="banner-image"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="flex flex-col gap-5"
                >
                  <ImageUploadField
                    label="Imagem do banner (desktop)"
                    hint="Formato 16:5 — algo como 1600×500. PNG/JPEG/WEBP, até 1 MB. Deixe como está pra manter a imagem atual."
                    initialPreviewUrl={bannerImagePreviewUrl}
                    enforceSquare={false}
                    previewClassName="h-16 w-52"
                    placeholderLabel="16:5"
                    onChange={onBannerImageChange}
                    onClear={onBannerImageClear}
                  />
                  <ImageUploadField
                    label="Imagem do banner (celular) — opcional"
                    hint="Formato 3:4 — algo como 900×1200. Sem ela, o celular mostra a arte de desktop, que costuma ficar pequena demais pra ler."
                    initialPreviewUrl={bannerImageMobilePreviewUrl}
                    enforceSquare={false}
                    previewClassName="h-28 w-20"
                    placeholderLabel="3:4"
                    onChange={onBannerImageMobileChange}
                    onClear={onBannerImageMobileClear}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="banner-text"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="flex flex-col gap-5"
                >
                  <Field
                    label="Texto do banner"
                    hint="Uma frase curta — a faixa tem uma linha só. Máx 200 caracteres."
                  >
                    <input
                      type="text"
                      value={bannerText}
                      onChange={(e) => onBannerTextChange(e.target.value)}
                      className={fieldInputClass}
                      placeholder="Bônus exclusivo pra quem comprar hoje"
                      maxLength={200}
                    />
                  </Field>
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <ColorField
                      label="Cor de fundo"
                      hint="Hex no formato #RRGGBB."
                      value={bannerBgColor}
                      onChange={onBannerBgColorChange}
                    />
                    <ColorField
                      label="Cor do texto"
                      hint="Garanta contraste com o fundo — a faixa fica acima de tudo na página."
                      value={bannerTextColor}
                      onChange={onBannerTextColorChange}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <Field
              label="Link do banner"
              hint="Opcional. Precisa começar com https:// e abre em nova aba — a faixa fica numa página de pagamento, então não aceitamos outros esquemas de URL."
            >
              <input
                type="url"
                value={bannerLinkUrl}
                onChange={(e) => onBannerLinkUrlChange(e.target.value)}
                className={fieldInputClass}
                placeholder="https://"
                maxLength={500}
                inputMode="url"
              />
            </Field>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* ColorField — swatch + hex, kept in sync                                    */
/* -------------------------------------------------------------------------- */

/**
 * Native picker beside a free-form hex field, both writing the same
 * state. The text field is the source of truth because the API takes a
 * `#rrggbb` string and the producer often pastes one from a brand kit;
 * the swatch only falls back to black while that string is mid-typing,
 * so the picker never fights the keyboard.
 */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const swatch = HEX_PATTERN.test(value.trim()) ? value.trim() : HEX_FALLBACK;
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} — seletor`}
          className="size-12 shrink-0 cursor-pointer rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={fieldInputClass}
          placeholder="#111827"
          maxLength={7}
        />
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Form primitives — duplicated from the page, see the module docblock        */
/* -------------------------------------------------------------------------- */

const fieldInputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

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
 * Compact two-option picker for the discount type. Same radio-dot +
 * brand-ring language as the plan `PaymentMethodCard` on this route,
 * minus the badge slot — the choice here is mechanical (% vs R$), not
 * a recommendation, so nothing should be labelled "Recomendado".
 */
function ChoiceCard({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
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
      </div>
      <span className="pl-7 text-[12px] text-[var(--color-fg-muted)] leading-[1.4]">
        {subtitle}
      </span>
    </button>
  );
}
