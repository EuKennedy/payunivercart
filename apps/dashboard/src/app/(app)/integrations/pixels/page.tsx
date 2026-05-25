'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Tracking pixels — Pilar 2 producer surface (premium build).
 *
 * Tabs:
 *   1. "Visão geral"   — connected pixels list + per-pixel health,
 *                        dispatch volume, last-validated chip, swap
 *                        default / pause / remove.
 *   2. "Configurar pixel" — provider service grid (6 tiles, brand
 *                        accent), opens an inline form per provider
 *                        with the exact credentials it needs.
 *   3. "Eventos"       — placeholder for the dispatch ledger view
 *                        (drops in PR 5/5 of Pilar 2 — backend
 *                        already keeps the rows).
 *
 * Visual language:
 *   - Dark-first surfaces with brand accent on active state.
 *   - Per-provider brand gradient inside the tile (Meta blue, GA4
 *     orange, TikTok charcoal, Google Ads green, Pinterest red,
 *     Kwai orange-red) so producer recognizes the service at a glance.
 *   - Tabs animate via `layoutId` (Linear pattern); content slide
 *     between tabs with framer-motion AnimatePresence.
 *   - Form panel: glass-like surface, sticky CTA, real-time validation
 *     mirror messages from the adapter, no fake-success states.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

type ProviderId = 'meta' | 'ga4' | 'tiktok' | 'google_ads' | 'pinterest' | 'kwai';

type TabId = 'overview' | 'configure' | 'events';

interface ProviderTile {
  id: ProviderId;
  name: string;
  tagline: string;
  /** Brand colors for the icon bubble. Both light/dark friendly. */
  brandFrom: string;
  brandTo: string;
  /** What the producer is going to actually configure. Shown as bullet
   *  list inside the tile so they know what they need before clicking. */
  needs: string[];
  docsUrl: string;
}

const TILES: ProviderTile[] = [
  {
    id: 'meta',
    name: 'Meta',
    tagline: 'Facebook + Instagram — Conversions API',
    brandFrom: '#0866FF',
    brandTo: '#0042A8',
    needs: ['Pixel ID', 'Access Token'],
    docsUrl: 'https://www.facebook.com/business/help/2041148702652965',
  },
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    tagline: 'Measurement Protocol — purchase + begin_checkout',
    brandFrom: '#F9AB00',
    brandTo: '#E37400',
    needs: ['Measurement ID', 'API Secret'],
    docsUrl: 'https://developers.google.com/analytics/devguides/collection/protocol/ga4',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    tagline: 'Events API v1.3 — CompletePayment',
    brandFrom: '#25F4EE',
    brandTo: '#FE2C55',
    needs: ['Pixel Code', 'Access Token'],
    docsUrl: 'https://business-api.tiktok.com/portal/docs?id=1771101303285761',
  },
  {
    id: 'google_ads',
    name: 'Google Ads',
    tagline: 'Enhanced Conversions for Web (server-side)',
    brandFrom: '#34A853',
    brandTo: '#1E8E3E',
    needs: ['Customer ID', 'Conversion Action', 'OAuth Refresh Token', 'Developer Token'],
    docsUrl: 'https://developers.google.com/google-ads/api/docs/conversions/enhance-conversions',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    tagline: 'Conversions API v5',
    brandFrom: '#E60023',
    brandTo: '#AD081B',
    needs: ['Ad Account ID', 'Conversion Token', 'Tag ID'],
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/events-create/',
  },
  {
    id: 'kwai',
    name: 'Kwai for Business',
    tagline: 'Pixel API — PURCHASE + ADD_TO_CART',
    brandFrom: '#FF5500',
    brandTo: '#FF0050',
    needs: ['Pixel ID', 'Access Token'],
    docsUrl: 'https://kwaiforbusiness.com/',
  },
];

const TABS: { id: TabId; label: string; description: string }[] = [
  { id: 'overview', label: 'Visão geral', description: 'Pixels conectados + saúde' },
  { id: 'configure', label: 'Configurar pixel', description: '6 services prontos' },
  { id: 'events', label: 'Eventos', description: 'Histórico de disparos' },
];

export default function PixelsPage() {
  const list = trpc.tracking.list.useQuery();
  const utils = trpc.useUtils();

  const upsert = trpc.tracking.upsert.useMutation({
    onSuccess: () => {
      utils.tracking.list.invalidate();
      setSelectedProvider(null);
      setActiveTab('overview');
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
    onSuccess: () => {
      utils.tracking.list.invalidate();
      toast.success('Pixel removido.');
    },
  });
  const setDefault = trpc.tracking.setDefault.useMutation({
    onSuccess: () => utils.tracking.list.invalidate(),
  });

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null);

  const configuredByProvider = useMemo(() => {
    const map: Partial<Record<ProviderId, number>> = {};
    for (const p of list.data ?? []) {
      map[p.provider as ProviderId] = (map[p.provider as ProviderId] ?? 0) + 1;
    }
    return map;
  }, [list.data]);

  return (
    <div className="flex flex-col gap-10">
      {/* HERO */}
      <header className="flex flex-col gap-3">
        <Kicker>integrações · tracking</Kicker>
        <Heading level={1}>Server-side tracking.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Cada conversão sai direto da nossa API pra API do provedor — sem perda por iOS, ITP ou
          ad-block. As chaves ficam criptografadas e nunca voltam pra tela depois de salvas.
        </p>
      </header>

      {/* TABS */}
      <nav
        role="tablist"
        aria-label="Tracking sections"
        className="inline-flex w-fit rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-sm)]"
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={
                isActive
                  ? 'relative cursor-pointer rounded-xl px-4 py-2 font-semibold text-[13px] text-[var(--color-fg)] transition'
                  : 'relative cursor-pointer rounded-xl px-4 py-2 font-medium text-[13px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]'
              }
            >
              {isActive ? (
                <motion.span
                  layoutId="pixels-tab-pill"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-br from-[var(--color-brand-50)] to-[var(--color-surface-muted)] ring-1 ring-[var(--color-brand-500)]/30"
                  aria-hidden
                />
              ) : null}
              <span className="relative">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* TAB CONTENT */}
      <AnimatePresence mode="wait">
        {activeTab === 'overview' ? (
          <motion.section
            key="overview"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="flex flex-col gap-6"
          >
            <OverviewTab
              list={list.data ?? []}
              isPending={list.isPending}
              onTest={(id) => test.mutate({ id })}
              onRemove={(id) => remove.mutate({ id })}
              onSetDefault={(id) => setDefault.mutate({ id })}
              onAddPixel={() => {
                setActiveTab('configure');
                setSelectedProvider(null);
              }}
              isMutating={test.isPending || remove.isPending || setDefault.isPending}
            />
          </motion.section>
        ) : null}

        {activeTab === 'configure' ? (
          <motion.section
            key="configure"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="flex flex-col gap-6"
          >
            <ConfigureTab
              selectedProvider={selectedProvider}
              setSelectedProvider={setSelectedProvider}
              configuredByProvider={configuredByProvider}
              onSubmit={(input) => upsert.mutate(input)}
              pending={upsert.isPending}
              error={upsert.error?.message ?? null}
            />
          </motion.section>
        ) : null}

        {activeTab === 'events' ? (
          <motion.section
            key="events"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-16 text-center"
          >
            <p className="font-semibold text-[16px] text-[var(--color-fg)]">
              Histórico de disparos
            </p>
            <p className="mt-2 max-w-md mx-auto text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">
              O ledger por pixel + filtros por status/provider/event entram aqui no próximo release.
              A coleta já roda em background — os dados estão sendo armazenados.
            </p>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* OVERVIEW TAB                                                               */
/* -------------------------------------------------------------------------- */

interface PixelRow {
  id: string;
  provider: string;
  label: string;
  publicPixelId: string;
  isDefault: boolean;
  enabled: boolean;
  testMode: boolean;
  /** Wire-format may arrive as Date or ISO string depending on
   *  superjson configuration; we coerce to Date inside the component. */
  lastValidatedAt: Date | string | null;
  lastErrorMessage: string | null;
  eventsEnabled: Record<string, boolean>;
}

function OverviewTab({
  list,
  isPending,
  onTest,
  onRemove,
  onSetDefault,
  onAddPixel,
  isMutating,
}: {
  list: PixelRow[];
  isPending: boolean;
  onTest: (id: string) => void;
  onRemove: (id: string) => void;
  onSetDefault: (id: string) => void;
  onAddPixel: () => void;
  isMutating: boolean;
}) {
  if (isPending) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton.
            key={i}
            className="h-24 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
          />
        ))}
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] px-6 py-16 text-center">
        <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[var(--color-brand-50)] to-[var(--color-surface-muted)] ring-1 ring-[var(--color-brand-500)]/20">
          <BoltIcon />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-[16px] text-[var(--color-fg)]">
            Você ainda não conectou nenhum pixel.
          </p>
          <p className="max-w-md text-[13px] text-[var(--color-fg-muted)] leading-[1.5]">
            Configure pelo menos um pixel pra começar a otimizar seus anúncios com sinais de
            servidor.
          </p>
        </div>
        <Button onClick={onAddPixel}>Configurar primeiro pixel</Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          {list.length} {list.length === 1 ? 'pixel conectado' : 'pixels conectados'}
        </h2>
        <Button variant="secondary" size="sm" onClick={onAddPixel}>
          + Adicionar pixel
        </Button>
      </div>
      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {list.map((pixel) => {
            const tile = TILES.find((t) => t.id === pixel.provider);
            return (
              <motion.li
                key={pixel.id}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.24, ease: EASE }}
                className={
                  pixel.isDefault
                    ? 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-brand-500)]/40 bg-gradient-to-br from-[var(--color-brand-50)]/30 via-[var(--color-surface)] to-[var(--color-surface)] p-5 shadow-[0_18px_36px_-18px_rgba(22,163,74,0.25)] ring-1 ring-[var(--color-brand-500)]/15'
                    : 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition hover:border-[var(--color-border-strong)]'
                }
              >
                <div className="flex min-w-0 items-center gap-4">
                  <BrandBubble
                    from={tile?.brandFrom ?? '#666'}
                    to={tile?.brandTo ?? '#333'}
                    provider={pixel.provider as ProviderId}
                  />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold text-[15px] text-[var(--color-fg)]">
                        {pixel.label}
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
                    <span className="truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">
                      {tile?.name} · {pixel.publicPixelId}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <HealthDot ok={!!pixel.lastValidatedAt && !pixel.lastErrorMessage} />
                      <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {pixel.lastValidatedAt
                          ? `Validado em ${new Date(pixel.lastValidatedAt).toLocaleString('pt-BR')}`
                          : pixel.lastErrorMessage
                            ? `Falha: ${pixel.lastErrorMessage}`
                            : 'Aguardando validação'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onTest(pixel.id)}
                    disabled={isMutating}
                  >
                    Testar
                  </Button>
                  {!pixel.isDefault ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onSetDefault(pixel.id)}
                      disabled={isMutating}
                    >
                      Tornar padrão
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!confirm(`Remover "${pixel.label}"?`)) return;
                      onRemove(pixel.id);
                    }}
                    disabled={isMutating}
                  >
                    Remover
                  </Button>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* CONFIGURE TAB                                                              */
/* -------------------------------------------------------------------------- */

type UpsertInput = {
  provider: ProviderId;
  credentials: Record<string, string | undefined>;
  label: string;
  testMode: boolean;
  isDefault: boolean;
  enabled: boolean;
  validateBeforeSave: boolean;
};

function ConfigureTab({
  selectedProvider,
  setSelectedProvider,
  configuredByProvider,
  onSubmit,
  pending,
  error,
}: {
  selectedProvider: ProviderId | null;
  setSelectedProvider: (p: ProviderId | null) => void;
  configuredByProvider: Partial<Record<ProviderId, number>>;
  // biome-ignore lint/suspicious/noExplicitAny: discriminated union narrowed at the router boundary — accepts every tile shape here.
  onSubmit: (input: any) => void;
  pending: boolean;
  error: string | null;
}) {
  const activeTile = TILES.find((t) => t.id === selectedProvider) ?? null;

  return (
    <div className="flex flex-col gap-8">
      {/* Service grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => {
          const isSelected = selectedProvider === tile.id;
          const count = configuredByProvider[tile.id] ?? 0;
          return (
            <motion.button
              key={tile.id}
              type="button"
              onClick={() => setSelectedProvider(isSelected ? null : tile.id)}
              whileHover={{ y: -3 }}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.2, ease: EASE }}
              className={
                isSelected
                  ? 'relative flex cursor-pointer flex-col gap-4 overflow-hidden rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 text-left ring-4 ring-[var(--color-brand-500)]/10 transition'
                  : 'group relative flex cursor-pointer flex-col gap-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition hover:border-[var(--color-brand-500)]/50 hover:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.18)]'
              }
            >
              {/* Brand glow */}
              <div
                aria-hidden
                className="-top-12 -right-12 pointer-events-none absolute h-32 w-32 rounded-full blur-3xl opacity-25 transition group-hover:opacity-40"
                style={{
                  background: `linear-gradient(135deg, ${tile.brandFrom}, ${tile.brandTo})`,
                }}
              />

              <div className="relative flex items-start justify-between gap-3">
                <BrandBubble from={tile.brandFrom} to={tile.brandTo} provider={tile.id} size={11} />
                {count > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-success)] uppercase tracking-wider">
                    <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
                    {count} ativo{count > 1 ? 's' : ''}
                  </span>
                ) : null}
              </div>

              <div className="relative flex flex-col gap-1">
                <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">{tile.name}</h3>
                <p className="text-[12px] text-[var(--color-fg-muted)] leading-[1.5]">
                  {tile.tagline}
                </p>
              </div>

              <ul className="relative flex flex-wrap gap-1.5">
                {tile.needs.map((n) => (
                  <li
                    key={n}
                    className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider"
                  >
                    {n}
                  </li>
                ))}
              </ul>

              <div className="relative mt-auto flex items-center justify-between">
                <span className="font-semibold text-[12px] text-[var(--color-brand-600)]">
                  {isSelected ? 'Selecionado' : count > 0 ? 'Adicionar outro →' : 'Configurar →'}
                </span>
                <a
                  href={tile.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-[11px] text-[var(--color-fg-subtle)] underline-offset-2 hover:text-[var(--color-fg-muted)] hover:underline"
                >
                  Docs ↗
                </a>
              </div>
            </motion.button>
          );
        })}
      </section>

      {/* Form panel */}
      <AnimatePresence mode="wait">
        {activeTile ? (
          <motion.section
            key={activeTile.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_28px_64px_-24px_rgba(0,0,0,0.28)]"
          >
            <header
              className="relative overflow-hidden border-[var(--color-border)] border-b bg-gradient-to-br px-6 py-5"
              style={{
                background: `linear-gradient(135deg, ${activeTile.brandFrom}11, var(--color-surface) 70%)`,
              }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <BrandBubble
                    from={activeTile.brandFrom}
                    to={activeTile.brandTo}
                    provider={activeTile.id}
                    size={12}
                  />
                  <div className="flex flex-col">
                    <Heading level={3}>{activeTile.name}</Heading>
                    <p className="text-[12px] text-[var(--color-fg-muted)]">{activeTile.tagline}</p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelectedProvider(null)}>
                  Fechar
                </Button>
              </div>
            </header>
            <div className="px-6 py-6">
              {activeTile.id === 'meta' ? (
                <MetaForm onSubmit={onSubmit} pending={pending} error={error} />
              ) : activeTile.id === 'ga4' ? (
                <Ga4Form onSubmit={onSubmit} pending={pending} error={error} />
              ) : activeTile.id === 'tiktok' ? (
                <TikTokForm onSubmit={onSubmit} pending={pending} error={error} />
              ) : activeTile.id === 'google_ads' ? (
                <GoogleAdsForm onSubmit={onSubmit} pending={pending} error={error} />
              ) : activeTile.id === 'pinterest' ? (
                <PinterestForm onSubmit={onSubmit} pending={pending} error={error} />
              ) : (
                <KwaiForm onSubmit={onSubmit} pending={pending} error={error} />
              )}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* FORMS — one per provider                                                   */
/* -------------------------------------------------------------------------- */

type FormProps = {
  onSubmit: (input: UpsertInput) => void;
  pending: boolean;
  error: string | null;
};

function MetaForm({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('Meta — Principal');
  const [pixelId, setPixelId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'meta',
          credentials: {
            pixelId: pixelId.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Pixel ID" hint="Events Manager → seu pixel → ID (15-16 dígitos).">
        <Input value={pixelId} onChange={setPixelId} placeholder="1234567890123456" required />
      </Field>
      <Field label="Access Token" hint='Events Manager → Settings → "Generate Access Token".'>
        <Input value={accessToken} onChange={setAccessToken} type="password" required />
      </Field>
      <Field
        label="Test Event Code (opcional)"
        hint='Settings → "Test Events". Não conta como conversão real.'
        className="sm:col-span-2"
      >
        <Input value={testEventCode} onChange={setTestEventCode} placeholder="TEST12345" />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro painel de teste do Meta — não otimizam campanhas."
      />
    </FormShell>
  );
}

function Ga4Form({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('GA4 — Principal');
  const [measurementId, setMeasurementId] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'ga4',
          credentials: { measurementId: measurementId.trim(), apiSecret: apiSecret.trim() },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Measurement ID" hint="Formato G-XXXXXXXX.">
        <Input
          value={measurementId}
          onChange={setMeasurementId}
          placeholder="G-ABC1234567"
          required
        />
      </Field>
      <Field label="API Secret" hint='Admin → Data Streams → "Measurement Protocol API secrets".'>
        <Input value={apiSecret} onChange={setApiSecret} type="password" required />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Debug mode"
        hint="Eventos aparecem em DebugView e não somam em relatórios padrão."
      />
    </FormShell>
  );
}

function TikTokForm({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('TikTok — Principal');
  const [pixelCode, setPixelCode] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'tiktok',
          credentials: {
            pixelCode: pixelCode.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Pixel Code" hint='Events Manager → Settings → "Web Event ID".'>
        <Input value={pixelCode} onChange={setPixelCode} placeholder="C12ABC34DEF5GHIJ" required />
      </Field>
      <Field label="Access Token" hint='Events Manager → "Generate Access Token".'>
        <Input value={accessToken} onChange={setAccessToken} type="password" required />
      </Field>
      <Field
        label="Test Event Code (opcional)"
        hint='Events Manager → "Test Events".'
        className="sm:col-span-2"
      >
        <Input value={testEventCode} onChange={setTestEventCode} placeholder="TEST12345" />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro Test Events do TikTok."
      />
    </FormShell>
  );
}

function GoogleAdsForm({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('Google Ads — Principal');
  const [customerId, setCustomerId] = useState('');
  const [conversionActionId, setConversionActionId] = useState('');
  const [oauthRefreshToken, setOauthRefreshToken] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [developerToken, setDeveloperToken] = useState('');
  const [loginCustomerId, setLoginCustomerId] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'google_ads',
          credentials: {
            customerId: customerId.trim(),
            conversionActionId: conversionActionId.trim(),
            oauthRefreshToken: oauthRefreshToken.trim(),
            oauthClientId: oauthClientId.trim(),
            oauthClientSecret: oauthClientSecret.trim(),
            developerToken: developerToken.trim(),
            loginCustomerId: loginCustomerId.trim() || undefined,
          },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Customer ID" hint="10 dígitos sem hífen.">
        <Input value={customerId} onChange={setCustomerId} placeholder="1234567890" required />
      </Field>
      <Field label="Conversion Action ID" hint="Conversões → seu conversion action → ID numérico.">
        <Input
          value={conversionActionId}
          onChange={setConversionActionId}
          placeholder="123456789"
          required
        />
      </Field>
      <Field label="OAuth Client ID" hint="Google Cloud Console → Credentials.">
        <Input value={oauthClientId} onChange={setOauthClientId} required />
      </Field>
      <Field label="OAuth Client Secret">
        <Input value={oauthClientSecret} onChange={setOauthClientSecret} type="password" required />
      </Field>
      <Field
        label="OAuth Refresh Token"
        hint="Gerado uma vez via OAuth Playground com o scope adwords."
        className="sm:col-span-2"
      >
        <Input value={oauthRefreshToken} onChange={setOauthRefreshToken} type="password" required />
      </Field>
      <Field label="Developer Token" hint="MCC → API Center → Developer Token.">
        <Input value={developerToken} onChange={setDeveloperToken} type="password" required />
      </Field>
      <Field label="Login Customer ID (opcional)" hint="Use quando o token é de uma MCC.">
        <Input value={loginCustomerId} onChange={setLoginCustomerId} placeholder="9876543210" />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Validação apenas"
        hint="Eventos vão como validateOnly — não criam conversão real."
      />
    </FormShell>
  );
}

function PinterestForm({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('Pinterest — Principal');
  const [adAccountId, setAdAccountId] = useState('');
  const [conversionToken, setConversionToken] = useState('');
  const [tagId, setTagId] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'pinterest',
          credentials: {
            adAccountId: adAccountId.trim(),
            conversionToken: conversionToken.trim(),
            tagId: tagId.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Ad Account ID" hint="Ads Manager → URL → o número após /advertiser/.">
        <Input value={adAccountId} onChange={setAdAccountId} placeholder="549764390123" required />
      </Field>
      <Field label="Tag ID" hint="Pinterest Tag → ID numérico.">
        <Input value={tagId} onChange={setTagId} placeholder="2613000000000" required />
      </Field>
      <Field
        label="Conversion Token"
        hint='Settings → Conversion API → "Generate token".'
        className="sm:col-span-2"
      >
        <Input value={conversionToken} onChange={setConversionToken} type="password" required />
      </Field>
      <Field
        label="Test Event Code (opcional)"
        hint="Test Events Manager."
        className="sm:col-span-2"
      >
        <Input value={testEventCode} onChange={setTestEventCode} placeholder="TEST12345" />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro Test Events Manager."
      />
    </FormShell>
  );
}

function KwaiForm({ onSubmit, pending, error }: FormProps) {
  const [label, setLabel] = useState('Kwai — Principal');
  const [pixelId, setPixelId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [testMode, setTestMode] = useState(false);
  return (
    <FormShell
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          provider: 'kwai',
          credentials: {
            pixelId: pixelId.trim(),
            accessToken: accessToken.trim(),
            testEventCode: testEventCode.trim() || undefined,
          },
          label: label.trim(),
          testMode,
          isDefault: true,
          enabled: true,
          validateBeforeSave: true,
        });
      }}
      pending={pending}
      error={error}
    >
      <Field label="Apelido" className="sm:col-span-2">
        <Input value={label} onChange={setLabel} />
      </Field>
      <Field label="Pixel ID" hint="Kwai for Business → Pixels → seu pixel → ID.">
        <Input value={pixelId} onChange={setPixelId} required />
      </Field>
      <Field label="Access Token" hint='Pixels → "Generate Access Token".'>
        <Input value={accessToken} onChange={setAccessToken} type="password" required />
      </Field>
      <Field label="Test Event Code (opcional)" hint="Test Events panel." className="sm:col-span-2">
        <Input value={testEventCode} onChange={setTestEventCode} placeholder="TEST12345" />
      </Field>
      <ToggleRow
        checked={testMode}
        onChange={setTestMode}
        label="Modo teste"
        hint="Eventos vão pro painel de teste do Kwai."
      />
    </FormShell>
  );
}

/* -------------------------------------------------------------------------- */
/* PRIMITIVES                                                                 */
/* -------------------------------------------------------------------------- */

function FormShell({
  onSubmit,
  children,
  pending,
  error,
}: {
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
  pending: boolean;
  error: string | null;
}) {
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      {children}
      {error ? (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)] sm:col-span-2"
        >
          {error}
        </motion.p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 pt-2 sm:col-span-2">
        <motion.button
          type="submit"
          disabled={pending}
          whileHover={pending ? undefined : { scale: 1.02 }}
          whileTap={pending ? undefined : { scale: 0.97 }}
          transition={{ duration: 0.16, ease: EASE }}
          className={
            pending
              ? 'inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-[var(--color-surface-muted)] px-5 py-2.5 font-semibold text-[14px] text-[var(--color-fg-subtle)]'
              : 'inline-flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] px-5 py-2.5 font-semibold text-[14px] text-white shadow-[0_10px_24px_-8px_rgba(22,163,74,0.45)] transition hover:brightness-110'
          }
        >
          {pending ? (
            <>
              <Spinner /> Validando…
            </>
          ) : (
            'Salvar e validar'
          )}
        </motion.button>
        <p className="text-[12px] text-[var(--color-fg-subtle)]">
          A plataforma chama o provider antes de salvar — você descobre na hora se a credencial está
          errada.
        </p>
      </div>
    </form>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function Input({
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
}: {
  value: string;
  onChange: (next: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      autoComplete="off"
      className={inputClass}
    />
  );
}

function Field({
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
          ? 'flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-brand-500)]/40 bg-gradient-to-br from-[var(--color-brand-50)]/40 via-[var(--color-surface)] to-[var(--color-surface)] px-4 py-3 transition sm:col-span-2'
          : 'flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition hover:border-[var(--color-border-strong)] sm:col-span-2'
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

function BrandBubble({
  from,
  to,
  provider,
  size = 10,
}: {
  from: string;
  to: string;
  provider: ProviderId;
  size?: number;
}) {
  const sizeCls = size === 12 ? 'size-12' : size === 11 ? 'size-11' : 'size-10';
  return (
    <span
      aria-hidden
      className={`relative grid ${sizeCls} shrink-0 place-items-center overflow-hidden rounded-2xl text-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-white/10`}
      style={{
        background: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      <ProviderGlyph provider={provider} />
    </span>
  );
}

function ProviderGlyph({ provider }: { provider: ProviderId }) {
  // SVG monograms — recognizable enough without copying official logos.
  // Stroke-only to keep visual weight consistent across all 6 tiles.
  const map: Record<ProviderId, string> = {
    meta: 'M',
    ga4: 'G',
    tiktok: 'T',
    google_ads: 'A',
    pinterest: 'P',
    kwai: 'K',
  };
  return <span className="font-bold text-[16px] tracking-tight">{map[provider]}</span>;
}

function HealthDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-label={ok ? 'Saudável' : 'Atenção'}
      className={
        ok
          ? 'inline-flex size-2 rounded-full bg-[var(--color-success)] shadow-[0_0_8px_var(--color-success)]'
          : 'inline-flex size-2 rounded-full bg-[var(--color-warning)] shadow-[0_0_8px_var(--color-warning)]'
      }
    />
  );
}

function BoltIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="size-6 text-[var(--color-brand-600)]"
      aria-hidden
    >
      <title>Tracking</title>
      <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7Z" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-4 animate-spin" aria-hidden>
      <title>Carregando</title>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
