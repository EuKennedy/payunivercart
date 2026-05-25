'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Tracking pixels — Pilar 2 producer surface.
 *
 * Layout mirrors `/integrations/gateways`: a tile grid where each
 * provider that has a wired adapter is in-color + clickable, and the
 * not-yet-built ones sit grayscale behind a lock + "Em breve" pill.
 * Below the grid, the list of configured pixels per provider shows
 * label + env (test/prod) + last validation + quick actions.
 *
 * Selecting a tile reveals the per-provider form (Meta / GA4 /
 * TikTok). Each form's credential fields match the provider's spec
 * exactly so producers can paste straight from Events Manager / GA4
 * Admin / TikTok Events Manager without re-reading docs.
 *
 * Why we don't lazy-load the forms: each one is ~30 lines and shares
 * the same `FormField` primitive — keeping them inline avoids a
 * Suspense flash when the producer flips tiles.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

type ProviderId = 'meta' | 'ga4' | 'tiktok' | 'google_ads' | 'pinterest' | 'kwai';

interface ProviderTile {
  id: ProviderId;
  name: string;
  tagline: string;
  active: boolean;
}

const TILES: ProviderTile[] = [
  {
    id: 'meta',
    name: 'Meta (Facebook + Instagram)',
    tagline: 'Conversions API · Purchase · InitiateCheckout',
    active: true,
  },
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    tagline: 'Measurement Protocol · purchase · begin_checkout',
    active: true,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    tagline: 'Events API · CompletePayment · ViewContent',
    active: true,
  },
  {
    id: 'google_ads',
    name: 'Google Ads',
    tagline: 'Enhanced Conversions (em breve)',
    active: false,
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    tagline: 'Conversion API (em breve)',
    active: false,
  },
  {
    id: 'kwai',
    name: 'Kwai',
    tagline: 'Pixel API (em breve)',
    active: false,
  },
];

export default function PixelsPage() {
  const list = trpc.tracking.list.useQuery();
  const utils = trpc.useUtils();

  const upsert = trpc.tracking.upsert.useMutation({
    onSuccess: () => {
      utils.tracking.list.invalidate();
      setActiveForm(null);
      toast.success('Pixel salvo e validado.');
    },
    onError: (err) => toast.error(err.message),
  });
  const test = trpc.tracking.test.useMutation({
    onSuccess: (data) => {
      utils.tracking.list.invalidate();
      if (data.ok) toast.success('Pixel ativo no provedor.');
      else toast.error(data.error ?? 'Falha na validação');
    },
  });
  const remove = trpc.tracking.remove.useMutation({
    onSuccess: () => utils.tracking.list.invalidate(),
  });
  const setDefault = trpc.tracking.setDefault.useMutation({
    onSuccess: () => utils.tracking.list.invalidate(),
  });

  const [activeForm, setActiveForm] = useState<ProviderId | null>(null);

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · tracking pixels</Kicker>
        <Heading level={1}>Server-side tracking.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          A plataforma dispara cada conversão direto pra API do provedor — bypass de iOS / ITP /
          ad-block. Cole suas chaves; nunca devolvemos elas pra tela depois de salvas.
        </p>
      </header>

      {/* Tile grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => {
          const configured = list.data?.some((p) => p.provider === tile.id);
          const isActiveForm = activeForm === tile.id;
          return (
            <motion.button
              key={tile.id}
              type="button"
              disabled={!tile.active}
              onClick={() => {
                if (tile.active) {
                  setActiveForm(isActiveForm ? null : tile.id);
                  setTimeout(() => {
                    document
                      .getElementById('pixel-form-anchor')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 50);
                }
              }}
              whileHover={tile.active ? { y: -2 } : undefined}
              whileTap={tile.active ? { scale: 0.98 } : undefined}
              transition={{ duration: 0.2, ease: EASE }}
              className={
                isActiveForm
                  ? 'relative flex cursor-pointer flex-col gap-4 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
                  : tile.active
                    ? 'group relative flex cursor-pointer flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-brand-500)]'
                    : 'relative flex cursor-not-allowed flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left opacity-60'
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <h3 className="font-semibold text-[15px] text-[var(--color-fg)]">{tile.name}</h3>
                  <p className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
                    {tile.tagline}
                  </p>
                </div>
                {configured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-success)] uppercase tracking-wider">
                    <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
                    Ativo
                  </span>
                ) : null}
              </div>
              {!tile.active ? (
                <span className="mt-auto rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                  Em breve
                </span>
              ) : (
                <span className="mt-auto font-medium text-[12px] text-[var(--color-brand-600)]">
                  {configured ? 'Adicionar outro pixel →' : 'Configurar agora →'}
                </span>
              )}
            </motion.button>
          );
        })}
      </section>

      {/* Configured pixels per provider */}
      {list.data && list.data.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Pixels conectados ({list.data.length})
          </h2>
          <ul className="flex flex-col gap-3">
            <AnimatePresence initial={false}>
              {list.data.map((pixel) => (
                <motion.li
                  key={pixel.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.24, ease: EASE }}
                  className={
                    pixel.isDefault
                      ? 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 ring-4 ring-[var(--color-brand-500)]/10'
                      : 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5'
                  }
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[15px] text-[var(--color-fg)]">
                        {pixel.label}
                      </span>
                      <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wider">
                        {pixel.provider}
                      </span>
                      {pixel.isDefault ? (
                        <span className="rounded-full bg-[var(--color-brand-50)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-wider">
                          ★ Padrão
                        </span>
                      ) : null}
                      {pixel.testMode ? (
                        <span className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-warning)] uppercase tracking-wider">
                          Test mode
                        </span>
                      ) : null}
                      {!pixel.enabled ? (
                        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                          Pausado
                        </span>
                      ) : null}
                    </div>
                    <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                      {pixel.publicPixelId}
                    </span>
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      {pixel.lastValidatedAt
                        ? `Validado em ${new Date(pixel.lastValidatedAt).toLocaleString('pt-BR')}`
                        : pixel.lastErrorMessage
                          ? `Falha: ${pixel.lastErrorMessage}`
                          : 'Aguardando validação'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => test.mutate({ id: pixel.id })}
                      disabled={test.isPending}
                    >
                      Testar
                    </Button>
                    {!pixel.isDefault ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDefault.mutate({ id: pixel.id })}
                        disabled={setDefault.isPending}
                      >
                        Tornar padrão
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (!confirm(`Remover "${pixel.label}"?`)) return;
                        remove.mutate({ id: pixel.id });
                      }}
                      disabled={remove.isPending}
                    >
                      Remover
                    </Button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      ) : null}

      <div id="pixel-form-anchor" />
      <AnimatePresence mode="wait">
        {activeForm ? (
          <motion.section
            key={activeForm}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <header className="mb-5 flex items-center justify-between">
              <Heading level={3}>Configurar {TILES.find((t) => t.id === activeForm)?.name}</Heading>
              <Button variant="ghost" size="sm" onClick={() => setActiveForm(null)}>
                Cancelar
              </Button>
            </header>
            {activeForm === 'meta' ? (
              <MetaForm
                onSubmit={(creds, label, testMode) =>
                  upsert.mutate({
                    provider: 'meta',
                    credentials: creds,
                    label,
                    testMode,
                    isDefault: true,
                    enabled: true,
                    validateBeforeSave: true,
                  })
                }
                pending={upsert.isPending}
              />
            ) : null}
            {activeForm === 'ga4' ? (
              <Ga4Form
                onSubmit={(creds, label, testMode) =>
                  upsert.mutate({
                    provider: 'ga4',
                    credentials: creds,
                    label,
                    testMode,
                    isDefault: true,
                    enabled: true,
                    validateBeforeSave: true,
                  })
                }
                pending={upsert.isPending}
              />
            ) : null}
            {activeForm === 'tiktok' ? (
              <TikTokForm
                onSubmit={(creds, label, testMode) =>
                  upsert.mutate({
                    provider: 'tiktok',
                    credentials: creds,
                    label,
                    testMode,
                    isDefault: true,
                    enabled: true,
                    validateBeforeSave: true,
                  })
                }
                pending={upsert.isPending}
              />
            ) : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-provider forms                                                         */
/* -------------------------------------------------------------------------- */

function MetaForm({
  onSubmit,
  pending,
}: {
  onSubmit: (
    creds: { pixelId: string; accessToken: string; testEventCode?: string },
    label: string,
    testMode: boolean,
  ) => void;
  pending: boolean;
}) {
  const [label, setLabel] = useState('Meta — Principal');
  const [pixelId, setPixelId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          {
            pixelId: pixelId.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label.trim(),
          testMode,
        );
      }}
      className="grid grid-cols-1 gap-5 sm:grid-cols-2"
    >
      <FormField label="Apelido" className="sm:col-span-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
      </FormField>
      <FormField label="Pixel ID" hint="Events Manager → seu pixel → ID (15-16 dígitos).">
        <input
          value={pixelId}
          onChange={(e) => setPixelId(e.target.value)}
          placeholder="1234567890123456"
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField label="Access Token" hint='Events Manager → Settings → "Generate Access Token".'>
        <input
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField
        label="Test Event Code (opcional)"
        hint='Settings → "Test Events". Não conta como conversão real.'
        className="sm:col-span-2"
      >
        <input
          value={testEventCode}
          onChange={(e) => setTestEventCode(e.target.value)}
          placeholder="TEST12345"
          className={inputClass}
          autoComplete="off"
        />
      </FormField>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro painel de teste do Meta — não otimizam campanhas."
      />
      <div className="flex items-center gap-3 pt-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Validando…' : 'Salvar e validar'}
        </Button>
      </div>
    </form>
  );
}

function Ga4Form({
  onSubmit,
  pending,
}: {
  onSubmit: (
    creds: { measurementId: string; apiSecret: string },
    label: string,
    testMode: boolean,
  ) => void;
  pending: boolean;
}) {
  const [label, setLabel] = useState('GA4 — Principal');
  const [measurementId, setMeasurementId] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          { measurementId: measurementId.trim(), apiSecret: apiSecret.trim() },
          label.trim(),
          testMode,
        );
      }}
      className="grid grid-cols-1 gap-5 sm:grid-cols-2"
    >
      <FormField label="Apelido" className="sm:col-span-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
      </FormField>
      <FormField label="Measurement ID" hint="Formato G-XXXXXXXX.">
        <input
          value={measurementId}
          onChange={(e) => setMeasurementId(e.target.value)}
          placeholder="G-ABC1234567"
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField
        label="API Secret"
        hint='Admin → Data Streams → seu stream → "Measurement Protocol API secrets".'
      >
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Debug mode"
        hint="Eventos aparecem em DebugView; não contam em relatórios padrão."
      />
      <div className="flex items-center gap-3 pt-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Validando…' : 'Salvar e validar'}
        </Button>
      </div>
    </form>
  );
}

function TikTokForm({
  onSubmit,
  pending,
}: {
  onSubmit: (
    creds: { pixelCode: string; accessToken: string; testEventCode?: string },
    label: string,
    testMode: boolean,
  ) => void;
  pending: boolean;
}) {
  const [label, setLabel] = useState('TikTok — Principal');
  const [pixelCode, setPixelCode] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          {
            pixelCode: pixelCode.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label.trim(),
          testMode,
        );
      }}
      className="grid grid-cols-1 gap-5 sm:grid-cols-2"
    >
      <FormField label="Apelido" className="sm:col-span-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
      </FormField>
      <FormField label="Pixel Code" hint='Events Manager → Settings → "Web Event ID".'>
        <input
          value={pixelCode}
          onChange={(e) => setPixelCode(e.target.value)}
          placeholder="C12ABC34DEF5GHIJ"
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField
        label="Access Token"
        hint='Events Manager → "Generate Access Token". Use o token long-lived.'
      >
        <input
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          className={inputClass}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField
        label="Test Event Code (opcional)"
        hint='Events Manager → "Test Events".'
        className="sm:col-span-2"
      >
        <input
          value={testEventCode}
          onChange={(e) => setTestEventCode(e.target.value)}
          placeholder="TEST12345"
          className={inputClass}
          autoComplete="off"
        />
      </FormField>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro Test Events do TikTok — não otimizam campanhas."
      />
      <div className="flex items-center gap-3 pt-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Validando…' : 'Salvar e validar'}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function FormField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}.
    <label className={`flex flex-col gap-2 ${className ?? ''}`}>
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      className={
        checked
          ? 'flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-brand-500)]/40 bg-[var(--color-brand-50)]/40 px-4 py-3 transition sm:col-span-2'
          : 'flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition sm:col-span-2'
      }
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
        <span className="font-medium text-[14px] text-[var(--color-fg)]">{label}</span>
        <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span>
      </div>
    </div>
  );
}
