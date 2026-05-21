'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '../../lib/auth';
import { trpc } from '../../lib/trpc';

type AdminPartner = inferRouterOutputs<AppRouter>['partners']['adminList'][number];

/**
 * Univercart Connect — SaaS partner administration.
 *
 * Superuser-only surface for onboarding 3rd-party SaaS partners
 * (ZapGrup, etc.) onto the entitlement webhook platform. Each partner
 * carries:
 *
 *   - identity (slug, name, contact email, status, trial flag)
 *   - one or more API keys (test / live, hashed, listed with prefix)
 *   - one or more webhook endpoints (test / live, signing secret per
 *     endpoint, active toggle)
 *   - role catalogue (slug + display name) producers use when
 *     attaching subscription plans to the partner
 *   - delivery log (last 50 webhook attempts per partner)
 *
 * Layout: master list of partners on the left, detail accordion on
 * the right. Detail sections collapse independently so the operator
 * can keep "Keys" open while editing "Webhook endpoints".
 */
export default function PartnersAdminPage() {
  const router = useRouter();
  const session = useSession();
  const partners = trpc.partners.adminList.useQuery(undefined, {
    enabled: !!session.data,
    retry: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  useEffect(() => {
    if (!selectedId && partners.data && partners.data.length > 0) {
      const first = partners.data[0];
      if (first) setSelectedId(first.id);
    }
  }, [partners.data, selectedId]);

  if (session.isPending) {
    return <p className="p-8 text-[14px] text-[var(--color-fg-muted)]">Carregando sessão…</p>;
  }
  if (!session.data) return null;

  if (partners.error?.data?.code === 'FORBIDDEN') {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="flex max-w-md flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
          <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
            403
          </p>
          <h1 className="font-semibold text-[18px]">Sem permissão</h1>
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Sua conta não está na lista de operadores. Volte pra <Link href="/">home</Link>.
          </p>
        </div>
      </main>
    );
  }

  const selected = partners.data?.find((p) => p.id === selectedId) ?? null;

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
            univercart connect · admin
          </p>
          <h1 className="font-semibold text-[24px] tracking-tight">SaaS Partners</h1>
          <p className="max-w-2xl text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Catálogo de SaaS terceiros que recebem entitlements via webhook quando uma assinatura do
            Univercart é criada/mudada/cancelada.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
        >
          ← Voltar
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <PartnersList
          partners={partners.data ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        {selected ? (
          <PartnerDetail key={selected.id} partner={selected} />
        ) : (
          <div className="rounded-2xl border border-[var(--color-border)] border-dashed p-10 text-center text-[13px] text-[var(--color-fg-subtle)]">
            Selecione um partner ou crie o primeiro.
          </div>
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* PartnersList                                                                */
/* -------------------------------------------------------------------------- */

function PartnersList({
  partners,
  selectedId,
  onSelect,
}: {
  partners: AdminPartner[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const create = trpc.partners.adminCreate.useMutation({
    onSuccess: (res) => {
      utils.partners.adminList.invalidate();
      onSelect(res.id);
      setOpen(false);
    },
  });

  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [setupBaseUrl, setSetupBaseUrl] = useState('');
  const [trialAccessEnabled, setTrialAccessEnabled] = useState(true);

  return (
    <aside className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
          {partners.length} partner{partners.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-[var(--color-brand-500)] px-2.5 py-1 font-semibold text-[12px] text-white hover:bg-[var(--color-brand-600)]"
        >
          {open ? '×' : '+ Novo'}
        </button>
      </div>

      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ slug, name, contactEmail, setupBaseUrl, trialAccessEnabled });
          }}
          className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <Input label="Slug" value={slug} onChange={setSlug} placeholder="zapgrup" />
          <Input label="Nome" value={name} onChange={setName} placeholder="ZapGrup" />
          <Input
            label="Contato"
            value={contactEmail}
            onChange={setContactEmail}
            placeholder="dev@zapgrup.com.br"
          />
          <Input
            label="Setup URL"
            value={setupBaseUrl}
            onChange={setSetupBaseUrl}
            placeholder="https://zapgrup.com.br/connect/setup"
          />
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={trialAccessEnabled}
              onChange={(e) => setTrialAccessEnabled(e.target.checked)}
            />
            Libera durante trial
          </label>
          {create.error ? (
            <p className="text-[12px] text-[var(--color-danger)]">{create.error.message}</p>
          ) : null}
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg bg-[var(--color-brand-500)] py-1.5 font-semibold text-[12px] text-white hover:bg-[var(--color-brand-600)] disabled:opacity-60"
          >
            {create.isPending ? 'Criando…' : 'Criar partner'}
          </button>
        </form>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {partners.map((p) => {
          const active = p.id === selectedId;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                className={`flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition ${
                  active
                    ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[14px]">{p.name}</span>
                  <StatusBadge status={p.status} />
                </div>
                <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                  {p.slug}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* PartnerDetail                                                               */
/* -------------------------------------------------------------------------- */

function PartnerDetail({ partner }: { partner: AdminPartner }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex items-start justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div>
          <p className="font-mono text-[12px] text-[var(--color-fg-subtle)]">{partner.slug}</p>
          <h2 className="mt-1 font-semibold text-[20px] tracking-tight">{partner.name}</h2>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">{partner.contactEmail}</p>
        </div>
        <PartnerStatusActions partner={partner} />
      </header>

      <ApiKeysSection partnerId={partner.id} />
      <WebhookEndpointsSection partnerId={partner.id} />
      <RolesSection partnerId={partner.id} />
      <DeliveriesSection partnerId={partner.id} />
    </div>
  );
}

function PartnerStatusActions({ partner }: { partner: AdminPartner }) {
  const utils = trpc.useUtils();
  const update = trpc.partners.adminUpdate.useMutation({
    onSuccess: () => utils.partners.adminList.invalidate(),
  });
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={partner.trialAccessEnabled}
          onChange={(e) => update.mutate({ id: partner.id, trialAccessEnabled: e.target.checked })}
        />
        Trial libera
      </label>
      <select
        value={partner.status}
        onChange={(e) =>
          update.mutate({
            id: partner.id,
            status: e.target.value as 'pending' | 'active' | 'suspended',
          })
        }
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
      >
        <option value="pending">pending</option>
        <option value="active">active</option>
        <option value="suspended">suspended</option>
      </select>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ApiKeysSection                                                              */
/* -------------------------------------------------------------------------- */

function ApiKeysSection({ partnerId }: { partnerId: string }) {
  const utils = trpc.useUtils();
  const keys = trpc.partners.adminListApiKeys.useQuery({ partnerId });
  const create = trpc.partners.adminCreateApiKey.useMutation({
    onSuccess: (res) => {
      utils.partners.adminListApiKeys.invalidate({ partnerId });
      setRevealed(res.cleartext);
      setName('');
    },
  });
  const revoke = trpc.partners.adminRevokeApiKey.useMutation({
    onSuccess: () => utils.partners.adminListApiKeys.invalidate({ partnerId }),
  });
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [revealed, setRevealed] = useState<string | null>(null);

  return (
    <Card
      title="API keys"
      subtitle="Bearer tokens que o SaaS usa pra chamar /v1/*. Mostrados uma vez."
    >
      {revealed ? (
        <div className="mb-4 rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-3">
          <p className="font-semibold text-[12px] text-[var(--color-warning)]">
            Copie agora — não será mostrado de novo.
          </p>
          <code className="mt-2 block break-all rounded bg-[var(--color-surface-muted)] p-2 font-mono text-[12px]">
            {revealed}
          </code>
          <button
            type="button"
            onClick={() => setRevealed(null)}
            className="mt-2 text-[11px] text-[var(--color-fg-muted)] underline"
          >
            Fechar
          </button>
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          create.mutate({ partnerId, name: name.trim(), mode });
        }}
        className="mb-3 flex flex-wrap items-end gap-2"
      >
        <Input label="Nome" value={name} onChange={setName} placeholder="Production" />
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
            Mode
          </span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'test' | 'live')}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
          >
            <option value="test">test</option>
            <option value="live">live</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded-lg bg-[var(--color-brand-500)] px-3 py-1.5 font-semibold text-[12px] text-white hover:bg-[var(--color-brand-600)] disabled:opacity-60"
        >
          Mintar
        </button>
      </form>

      <Table
        rows={keys.data ?? []}
        empty="Sem keys."
        cols={[
          { label: 'Nome', render: (k) => k.name },
          {
            label: 'Mode',
            render: (k) => (
              <span
                className={`rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase ${
                  k.mode === 'live'
                    ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                    : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
                }`}
              >
                {k.mode}
              </span>
            ),
          },
          {
            label: 'Prefix',
            render: (k) => <code className="font-mono text-[11px]">{k.prefix}…</code>,
          },
          {
            label: 'Último uso',
            render: (k) => (k.lastUsedAt ? fmtDate(k.lastUsedAt) : '—'),
          },
          {
            label: 'Status',
            render: (k) =>
              k.revokedAt ? (
                <span className="text-[12px] text-[var(--color-danger)]">revogada</span>
              ) : (
                <span className="text-[12px] text-[var(--color-success)]">ativa</span>
              ),
          },
          {
            label: '',
            render: (k) =>
              k.revokedAt ? null : (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Revogar a key "${k.name}"? Quem usa essa chave parará IMEDIATAMENTE.`,
                      )
                    )
                      revoke.mutate({ id: k.id });
                  }}
                  className="text-[11px] text-[var(--color-danger)] hover:underline"
                >
                  Revogar
                </button>
              ),
          },
        ]}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* WebhookEndpointsSection                                                     */
/* -------------------------------------------------------------------------- */

function WebhookEndpointsSection({ partnerId }: { partnerId: string }) {
  const utils = trpc.useUtils();
  const endpoints = trpc.partners.adminListWebhookEndpoints.useQuery({ partnerId });
  const create = trpc.partners.adminCreateWebhookEndpoint.useMutation({
    onSuccess: () => {
      utils.partners.adminListWebhookEndpoints.invalidate({ partnerId });
      setUrl('');
      setDescription('');
    },
  });
  const toggle = trpc.partners.adminToggleWebhookEndpoint.useMutation({
    onSuccess: () => utils.partners.adminListWebhookEndpoints.invalidate({ partnerId }),
  });
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [description, setDescription] = useState('');

  return (
    <Card
      title="Webhook endpoints"
      subtitle="URLs do SaaS que recebem entitlement.*. Signing secret único por endpoint."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          create.mutate({
            partnerId,
            url: url.trim(),
            mode,
            description: description.trim() || null,
          });
        }}
        className="mb-3 flex flex-wrap items-end gap-2"
      >
        <Input
          label="URL"
          value={url}
          onChange={setUrl}
          placeholder="https://zapgrup.com.br/univercart-webhook"
          wide
        />
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
            Mode
          </span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'test' | 'live')}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
          >
            <option value="test">test</option>
            <option value="live">live</option>
          </select>
        </div>
        <Input
          label="Descrição"
          value={description}
          onChange={setDescription}
          placeholder="Produção"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded-lg bg-[var(--color-brand-500)] px-3 py-1.5 font-semibold text-[12px] text-white hover:bg-[var(--color-brand-600)] disabled:opacity-60"
        >
          Cadastrar
        </button>
      </form>

      <Table
        rows={endpoints.data ?? []}
        empty="Sem endpoints."
        cols={[
          {
            label: 'URL',
            render: (e) => (
              <code className="block max-w-[400px] truncate font-mono text-[11px]">{e.url}</code>
            ),
          },
          {
            label: 'Mode',
            render: (e) => (
              <span
                className={`rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase ${
                  e.mode === 'live'
                    ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                    : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
                }`}
              >
                {e.mode}
              </span>
            ),
          },
          {
            label: 'Secret',
            render: (e) => (
              <code className="font-mono text-[11px]">{e.signingSecret.slice(0, 16)}…</code>
            ),
          },
          {
            label: 'Status',
            render: (e) =>
              e.isActive ? (
                <span className="text-[12px] text-[var(--color-success)]">ativo</span>
              ) : (
                <span className="text-[12px] text-[var(--color-fg-muted)]">desativado</span>
              ),
          },
          {
            label: '',
            render: (e) => (
              <button
                type="button"
                onClick={() => toggle.mutate({ id: e.id, isActive: !e.isActive })}
                className="text-[11px] text-[var(--color-fg-muted)] hover:underline"
              >
                {e.isActive ? 'Desativar' : 'Ativar'}
              </button>
            ),
          },
        ]}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* RolesSection                                                                */
/* -------------------------------------------------------------------------- */

function RolesSection({ partnerId }: { partnerId: string }) {
  const utils = trpc.useUtils();
  const roles = trpc.partners.adminListAllRoles.useQuery({ partnerId });
  const create = trpc.partners.adminCreateRole.useMutation({
    onSuccess: () => {
      utils.partners.adminListAllRoles.invalidate({ partnerId });
      setSlug('');
      setDisplayName('');
    },
  });
  const remove = trpc.partners.adminDeleteRole.useMutation({
    onSuccess: () => utils.partners.adminListAllRoles.invalidate({ partnerId }),
  });
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');

  return (
    <Card
      title="Roles"
      subtitle="Slugs que producers escolhem nos planos. Ex: entry · medium · ultra."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!slug.trim() || !displayName.trim()) return;
          create.mutate({
            partnerId,
            slug: slug.trim(),
            displayName: displayName.trim(),
          });
        }}
        className="mb-3 flex flex-wrap items-end gap-2"
      >
        <Input label="Slug" value={slug} onChange={setSlug} placeholder="entry" />
        <Input label="Nome" value={displayName} onChange={setDisplayName} placeholder="Entrada" />
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded-lg bg-[var(--color-brand-500)] px-3 py-1.5 font-semibold text-[12px] text-white hover:bg-[var(--color-brand-600)] disabled:opacity-60"
        >
          Adicionar
        </button>
      </form>

      <Table
        rows={roles.data ?? []}
        empty="Sem roles."
        cols={[
          { label: 'Slug', render: (r) => <code className="font-mono text-[12px]">{r.slug}</code> },
          { label: 'Nome', render: (r) => r.displayName },
          {
            label: '',
            render: (r) => (
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `Excluir role "${r.slug}"? Planos que apontam pra ela vão parar de provisionar.`,
                    )
                  )
                    remove.mutate({ id: r.id });
                }}
                className="text-[11px] text-[var(--color-danger)] hover:underline"
              >
                Excluir
              </button>
            ),
          },
        ]}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* DeliveriesSection                                                           */
/* -------------------------------------------------------------------------- */

function DeliveriesSection({ partnerId }: { partnerId: string }) {
  const deliveries = trpc.partners.adminListDeliveries.useQuery({ partnerId });
  const utils = trpc.useUtils();
  const retry = trpc.partners.adminRetryDelivery.useMutation({
    onSuccess: () => utils.partners.adminListDeliveries.invalidate({ partnerId }),
  });
  return (
    <Card
      title="Delivery log"
      subtitle="Últimas 50 tentativas de entrega. Botão retry coloca pra reprocessar no próximo sweep."
    >
      <Table
        rows={deliveries.data ?? []}
        empty="Sem deliveries."
        cols={[
          {
            label: 'Evento',
            render: (d) => <code className="font-mono text-[11px]">{d.eventType}</code>,
          },
          {
            label: 'URL',
            render: (d) => (
              <code className="block max-w-[260px] truncate font-mono text-[11px]">
                {d.endpointUrl}
              </code>
            ),
          },
          {
            label: 'Status',
            render: (d) => <DeliveryStatusBadge status={d.status} />,
          },
          {
            label: 'Tentativas',
            render: (d) => <span className="text-[12px]">{d.attempts}</span>,
          },
          {
            label: 'HTTP',
            render: (d) => <span className="text-[12px]">{d.lastResponseStatus ?? '—'}</span>,
          },
          {
            label: 'Quando',
            render: (d) => <span className="text-[11px]">{fmtDate(d.createdAt)}</span>,
          },
          {
            label: '',
            render: (d) =>
              d.status === 'dead_letter' || d.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() => retry.mutate({ deliveryId: d.deliveryId })}
                  className="text-[11px] text-[var(--color-brand-600)] hover:underline"
                >
                  Reprocessar
                </button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Reusable UI primitives                                                      */
/* -------------------------------------------------------------------------- */

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <header className="mb-4 flex flex-col gap-0.5">
        <h3 className="font-semibold text-[15px] text-[var(--color-fg)]">{title}</h3>
        {subtitle ? (
          <p className="text-[12px] text-[var(--color-fg-subtle)] leading-[1.5]">{subtitle}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] ${
          wide ? 'min-w-[320px]' : 'min-w-[140px]'
        }`}
      />
    </label>
  );
}

function Table<T>({
  rows,
  cols,
  empty,
}: {
  rows: T[];
  cols: { label: string; render: (row: T) => React.ReactNode }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] border-dashed p-4 text-center text-[12px] text-[var(--color-fg-subtle)]">
        {empty}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
      <table className="w-full text-[12px]">
        <thead className="bg-[var(--color-surface-muted)] text-left text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
          <tr>
            {cols.map((c) => (
              <th key={c.label || Math.random().toString(36)} className="px-3 py-2 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((row, rowIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, no stable id at this layer
            <tr key={`row-${rowIdx}`}>
              {cols.map((c) => (
                <td key={`${c.label || 'col'}-${rowIdx}`} className="px-3 py-2.5 align-middle">
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map = {
    active: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    pending: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    suspended: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  } as const;
  const cls = map[status as keyof typeof map] ?? map.pending;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold text-[9px] uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function DeliveryStatusBadge({ status }: { status: string }) {
  const map = {
    delivered: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
    pending: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
    failed: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    dead_letter: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  } as const;
  const cls = map[status as keyof typeof map] ?? map.pending;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold text-[10px] uppercase tracking-wider ${cls}`}
    >
      {status === 'dead_letter' ? 'dead-letter' : status}
    </span>
  );
}

function fmtDate(d: Date | string | null): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
