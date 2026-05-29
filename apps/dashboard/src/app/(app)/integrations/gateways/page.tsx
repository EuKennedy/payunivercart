'use client';

import { useState } from 'react';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Gateways de pagamento.
 *
 * Repaginated as a five-card grid that mirrors what producers see on
 * Hotmart / Kiwify: each option is a brand tile with its real logo.
 * Mercado Pago is the only one wired today (BR Pix-first launch),
 * so its tile is in-color + actionable; the other four sit
 * grayscale behind a lock overlay + "Em breve" pill — clear signal
 * that they're coming without faking that they work.
 *
 * Asaas is intentionally tagged "Assinaturas" — when it lands it
 * powers the platform's R$99,90/mês recurrence (B28), not the
 * producer's transactional gateway list.
 */

interface GatewayTile {
  id: 'mercadopago' | 'pagarme' | 'pagseguro' | 'stripe' | 'asaas';
  name: string;
  logo: string;
  tagline: string;
  badge?: 'em-breve' | 'assinaturas';
}

const TILES: GatewayTile[] = [
  {
    id: 'mercadopago',
    name: 'Mercado Pago',
    logo: '/gateways/mercadopago.png',
    tagline: 'Pix · Cartão · Boleto · Sandbox',
  },
  {
    id: 'pagarme',
    name: 'Pagar.me',
    logo: '/gateways/pagarme.png',
    tagline: 'Pix · Cartão · Boleto',
    badge: 'em-breve',
  },
  {
    id: 'pagseguro',
    name: 'PagSeguro',
    logo: '/gateways/pagseguro.png',
    tagline: 'Pix · Cartão · Boleto',
    badge: 'em-breve',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    logo: '/gateways/stripe.png',
    tagline: 'Internacional · USD · Cartão',
    badge: 'em-breve',
  },
  {
    id: 'asaas',
    name: 'Asaas',
    logo: '/gateways/asaas.svg',
    tagline: 'Assinaturas SaaS · Recorrência',
    badge: 'assinaturas',
  },
];

export default function GatewaysPage() {
  const list = trpc.gateways.list.useQuery();
  const utils = trpc.useUtils();

  const upsert = trpc.gateways.upsert.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate();
      setShowForm(false);
      resetForm();
    },
  });
  const test = trpc.gateways.test.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });
  const remove = trpc.gateways.remove.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });
  const setDefault = trpc.gateways.setDefault.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });
  const setSandboxFlag = trpc.gateways.setSandboxFlag.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });

  const [showForm, setShowForm] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [label, setLabel] = useState('Mercado Pago');
  const [isSandbox, setIsSandbox] = useState(false);
  // Auto-detect sandbox from access token prefix. MP issues
  // `APP_USR-...` for production credentials and `TEST-...` for
  // sandbox. The producer can still override the checkbox manually if
  // they're using a token type we don't recognize.
  const [sandboxManuallySet, setSandboxManuallySet] = useState(false);

  function resetForm() {
    setAccessToken('');
    setPublicKey('');
    setWebhookSecret('');
    setLabel('Mercado Pago');
    setIsSandbox(false);
    setSandboxManuallySet(false);
  }

  function handleAccessTokenChange(value: string) {
    setAccessToken(value);
    if (sandboxManuallySet) return;
    const trimmed = value.trim();
    if (trimmed.startsWith('TEST-')) setIsSandbox(true);
    else if (trimmed.startsWith('APP_USR-')) setIsSandbox(false);
  }

  // Producer can have multiple MP accounts wired (e.g. one sandbox for
  // QA + one production for live charges; eventually multi-store setups
  // with one production account per brand). We render every row so the
  // producer can flip the default with one click instead of deleting +
  // recreating, which would invalidate ongoing subscriptions tied to
  // the old credential row.
  const mpAccounts = (list.data ?? []).filter((g) => g.gatewayId === 'mercadopago');
  const mpConfigured = mpAccounts[0];

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    upsert.mutate({
      gatewayId: 'mercadopago',
      label: label.trim() || 'Mercado Pago',
      isDefault: true,
      isSandbox,
      validateBeforeSave: true,
      credentials: {
        accessToken: accessToken.trim(),
        publicKey: publicKey.trim(),
        webhookSecret: webhookSecret.trim() || undefined,
        isSandbox,
      },
    });
  };

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · gateways</Kicker>
        <Heading level={1}>Receba pagamentos.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Você usa suas próprias chaves de cada gateway — a plataforma só orquestra. As credenciais
          ficam criptografadas no banco e a chave nunca volta pra tela depois de salva.
        </p>
      </header>

      {/* Tiles grid — clickable on the active provider, locked on others */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => {
          const isActive = tile.id === 'mercadopago';
          const isConfigured = isActive && !!mpConfigured;
          const cardClasses = isActive
            ? 'group relative flex flex-col gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-left transition hover:border-[var(--color-brand-500)] hover:shadow-sm cursor-pointer'
            : 'relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6';
          const inner = (
            <>
              <div className="flex h-20 items-center justify-center">
                <img
                  src={tile.logo}
                  alt={tile.name}
                  className={
                    isActive
                      ? 'max-h-14 max-w-[180px] object-contain'
                      : 'max-h-14 max-w-[180px] object-contain opacity-50 grayscale'
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <h3 className="font-semibold text-[16px] text-[var(--color-fg)]">{tile.name}</h3>
                <p className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
                  {tile.tagline}
                </p>
              </div>
              <div className="mt-auto">
                {isActive ? (
                  isConfigured ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success-bg)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-success)] uppercase tracking-wider">
                        <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
                        Configurado
                      </span>
                      {mpConfigured.isSandbox ? (
                        <span className="rounded-full bg-[var(--color-warning-bg)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-warning)] uppercase tracking-wider">
                          Sandbox
                        </span>
                      ) : null}
                      <span className="ml-auto text-[12px] text-[var(--color-brand-600)] group-hover:underline">
                        Reconfigurar →
                      </span>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-3 py-1.5 font-semibold text-[12px] text-[var(--color-fg-inverse)] uppercase tracking-wider transition group-hover:bg-[var(--color-fg-muted)]">
                      Configurar agora →
                    </span>
                  )
                ) : (
                  <span
                    className={
                      tile.badge === 'assinaturas'
                        ? 'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-brand-50)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-brand-700)] uppercase tracking-wider'
                        : 'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider'
                    }
                  >
                    {tile.badge === 'assinaturas' ? (
                      <>
                        <BadgeIcon /> Assinaturas SaaS
                      </>
                    ) : (
                      <>
                        <LockIcon /> Em breve
                      </>
                    )}
                  </span>
                )}
              </div>
              {!isActive ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--color-surface)]/40 backdrop-blur-[1px]">
                  <span className="grid size-12 place-items-center rounded-full bg-[var(--color-surface)] shadow-sm ring-1 ring-[var(--color-border)]">
                    <LockIcon size={18} />
                  </span>
                </div>
              ) : null}
            </>
          );
          if (isActive) {
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => {
                  setShowForm(true);
                  // Bring the form into view — when the page is tall
                  // and the producer scrolled past the tiles, opening
                  // the panel below should follow the click.
                  if (typeof window !== 'undefined') {
                    setTimeout(() => {
                      document
                        .getElementById('mp-connect-form')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 50);
                  }
                }}
                className={cardClasses}
              >
                {inner}
              </button>
            );
          }
          return (
            <article key={tile.id} className={cardClasses}>
              {inner}
            </article>
          );
        })}
      </section>

      {/* All configured Mercado Pago accounts. The row marked as default
          is the one we use to charge buyers; the others sit on standby
          for one-click swap (e.g. switch a producer's checkout from
          sandbox to production without re-typing credentials). */}
      {mpAccounts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
              Contas Mercado Pago {mpAccounts.length > 1 ? `(${mpAccounts.length} conectadas)` : ''}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(true);
                resetForm();
                setTimeout(() => {
                  document
                    .getElementById('mp-connect-form')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
              }}
            >
              + Nova conta
            </Button>
          </div>
          <ul className="flex flex-col gap-3">
            {mpAccounts.map((acc) => (
              <li
                key={acc.id}
                className={
                  acc.isDefault
                    ? 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border-2 border-[var(--color-brand-500)] bg-[var(--color-surface)] p-5 ring-4 ring-[var(--color-brand-500)]/10'
                    : 'flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5'
                }
              >
                <div className="flex items-center gap-4">
                  <img
                    src="/gateways/mercadopago.png"
                    alt="Mercado Pago"
                    className="h-9 max-w-[120px] object-contain"
                  />
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[15px] text-[var(--color-fg)]">
                        {acc.label}
                      </span>
                      {acc.isDefault ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-50)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-brand-700)] uppercase tracking-wider">
                          ★ Padrão
                        </span>
                      ) : null}
                      {acc.isSandbox ? (
                        <span className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-warning)] uppercase tracking-wider">
                          Sandbox
                        </span>
                      ) : (
                        <span className="rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-medium text-[10px] text-[var(--color-success)] uppercase tracking-wider">
                          Produção
                        </span>
                      )}
                    </div>
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                      {acc.lastValidatedAt
                        ? `Validada em ${new Date(acc.lastValidatedAt).toLocaleString('pt-BR')}`
                        : acc.validationError
                          ? `Falha: ${acc.validationError}`
                          : 'Aguardando validação'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => test.mutate({ id: acc.id })}
                    disabled={test.isPending}
                  >
                    Testar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const target = !acc.isSandbox;
                      if (
                        !confirm(`Mudar "${acc.label}" para ${target ? 'sandbox' : 'produção'}?`)
                      ) {
                        return;
                      }
                      setSandboxFlag.mutate({ id: acc.id, isSandbox: target });
                    }}
                    disabled={setSandboxFlag.isPending}
                  >
                    {acc.isSandbox ? 'Marcar produção' : 'Marcar sandbox'}
                  </Button>
                  {!acc.isDefault ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setDefault.mutate({ id: acc.id })}
                      disabled={setDefault.isPending}
                    >
                      Tornar padrão
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!confirm(`Remover "${acc.label}"?`)) return;
                      remove.mutate({ id: acc.id });
                    }}
                    disabled={remove.isPending}
                  >
                    Remover
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Connect MP form */}
      {showForm ? (
        <section
          id="mp-connect-form"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
        >
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="/gateways/mercadopago.png"
                alt="Mercado Pago"
                className="h-8 max-w-[100px] object-contain"
              />
              <Heading level={3}>Conectar Mercado Pago</Heading>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              Cancelar
            </Button>
          </div>
          <p className="mb-6 text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Pegue suas credenciais em{' '}
            <a
              href="https://www.mercadopago.com.br/developers/panel/app"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--color-brand-600)] underline"
            >
              mercadopago.com.br/developers
            </a>
            . O Access Token começa com <code>APP_USR-</code> em produção ou <code>TEST-</code> em
            sandbox.
          </p>
          <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField label="Apelido" className="sm:col-span-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Mercado Pago"
                className={inputClass}
              />
            </FormField>
            <FormField
              label="Public Key"
              hint="Chave pública usada pelo navegador do comprador para tokenizar cartões."
              className="sm:col-span-2"
            >
              <input
                type="text"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="APP_USR-... ou TEST-..."
                className={inputClass}
                autoComplete="off"
                required
              />
            </FormField>
            <FormField
              label="Access Token"
              hint="Chave secreta do backend. Nunca compartilhe — fica criptografada no nosso servidor."
              className="sm:col-span-2"
            >
              <input
                type="password"
                value={accessToken}
                onChange={(e) => handleAccessTokenChange(e.target.value)}
                placeholder="APP_USR-... ou TEST-..."
                className={inputClass}
                autoComplete="off"
                required
              />
            </FormField>
            <FormField
              label="Webhook Secret"
              hint="Chave de assinatura do painel MP (Webhooks → Configurar notificações → Chave secreta)."
              className="sm:col-span-2"
            >
              <input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Segredo HMAC do painel MP"
                className={inputClass}
                autoComplete="off"
              />
              {webhookSecret.trim().length === 0 ? (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)] px-3 py-2.5 text-[12px] text-[var(--color-warning)] leading-[1.5]">
                  <svg
                    className="mt-0.5 size-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    role="img"
                    aria-label="Atenção"
                  >
                    <title>Atenção</title>
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                  <span>
                    <b>Sem o webhook secret, pagamentos não confirmam sozinhos.</b> O Mercado Pago
                    assina cada notificação com esta chave; sem ela, toda confirmação de PIX/cartão
                    é rejeitada e o pedido fica preso em "aguardando pagamento". Configure antes de
                    vender.
                  </span>
                </div>
              ) : null}
            </FormField>
            <label className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[14px] text-[var(--color-fg-muted)] sm:col-span-2">
              <input
                type="checkbox"
                checked={isSandbox}
                onChange={(e) => {
                  setIsSandbox(e.target.checked);
                  setSandboxManuallySet(true);
                }}
                className="mt-0.5 size-4 accent-[var(--color-brand-500)]"
              />
              <span className="flex flex-1 flex-col gap-1">
                <span className="font-semibold text-[14px] text-[var(--color-fg)]">
                  Ambiente sandbox
                </span>
                <span className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">
                  Detectamos automaticamente pelo prefixo do Access Token:{' '}
                  <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">
                    APP_USR-
                  </code>{' '}
                  = produção,{' '}
                  <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">
                    TEST-
                  </code>{' '}
                  = sandbox. Marque manualmente se sua chave não seguir esse padrão.
                </span>
              </span>
            </label>

            {upsert.error ? (
              <p className="rounded-xl border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)] sm:col-span-2">
                {upsert.error.message}
              </p>
            ) : null}

            <div className="flex items-center gap-3 pt-2 sm:col-span-2">
              <Button type="submit" disabled={upsert.isPending}>
                {upsert.isPending ? 'Validando…' : 'Salvar e validar'}
              </Button>
              <p className="text-[12px] text-[var(--color-fg-subtle)]">
                A plataforma chama o Mercado Pago antes de salvar — se a chave estiver errada, você
                descobre agora.
              </p>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>cadeado</title>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function BadgeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
    >
      <title>selo</title>
      <circle cx="12" cy="12" r="8" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

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
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; label wraps the control via React composition.
    <label className={`flex flex-col gap-2 ${className ?? ''}`}>
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
