'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * WhatsApp integration page.
 *
 * Two phases:
 *  1. No session yet → name input + "Conectar" CTA.
 *  2. Session exists → status pill + (QR | phone | error) + actions.
 *
 * Polling cadence:
 *   - status: 3s while STARTING / SCAN_QR_CODE; off at terminal states.
 *   - qr: 5s only when status === 'SCAN_QR_CODE' (WAHA rotates QR).
 *
 * Recovery from failure (FAILED) or stuck state goes through
 * `whatsapp.reset` which deletes the WAHA session + the mirror row so
 * the producer can start over with a fresh name.
 */
export default function WhatsappIntegrationPage() {
  const me = trpc.whatsapp.me.useQuery();
  const status = trpc.whatsapp.status.useQuery(undefined, {
    enabled: !!me.data,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (!s) return 3_000;
      if (s === 'WORKING' || s === 'FAILED' || s === 'STOPPED') return false;
      return 3_000;
    },
  });

  const utils = trpc.useUtils();
  const start = trpc.whatsapp.start.useMutation({
    onSuccess: () => {
      utils.whatsapp.me.invalidate();
      utils.whatsapp.status.invalidate();
    },
  });
  const stop = trpc.whatsapp.stop.useMutation({
    onSuccess: () => utils.whatsapp.status.invalidate(),
  });
  const reset = trpc.whatsapp.reset.useMutation({
    onSuccess: () => {
      utils.whatsapp.me.invalidate();
      utils.whatsapp.status.invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · whatsapp</Kicker>
        <Heading level={1}>Conecte seu WhatsApp.</Heading>
        <p className="max-w-2xl text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
          Cada workspace tem sua própria sessão. Escolha um apelido curto, escaneie o QR-code com
          o seu celular e seus clientes começam a receber mensagens vindas do seu número — sem
          proxies, sem chip intermediário. Motor: <code className="font-mono">WEBJS</code>.
        </p>
      </header>

      {me.isPending ? (
        <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>
      ) : !me.data ? (
        <ConnectForm
          isPending={start.isPending}
          error={start.error?.message ?? null}
          onSubmit={(name) => start.mutate({ name })}
        />
      ) : (
        <SessionCard
          status={status.data?.status ?? null}
          phoneNumber={status.data?.phoneNumber ?? null}
          sessionName={me.data.sessionName}
          onStop={() => stop.mutate()}
          onReset={() => {
            if (!confirm('Recomeçar apaga a sessão atual no WAHA. Tem certeza?')) return;
            reset.mutate();
          }}
          stopPending={stop.isPending}
          resetPending={reset.isPending}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connect form                                                               */
/* -------------------------------------------------------------------------- */

function ConnectForm({
  isPending,
  error,
  onSubmit,
}: {
  isPending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const valid = /^[a-zA-Z0-9_-]{3,40}$/.test(trimmed);

  return (
    <section className="max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        Nova sessão
      </p>
      <h2 className="mt-2 text-[18px] font-semibold text-[var(--color-fg)]">
        Dê um apelido para esta sessão
      </h2>
      <p className="mt-2 text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
        Esse nome identifica sua conexão no WAHA. Use algo memorável como{' '}
        <code className="font-mono text-[12px]">vendas-loja</code> ou{' '}
        <code className="font-mono text-[12px]">whatsapp-principal</code>. 3 a 40 caracteres, sem
        espaços ou acentos.
      </p>

      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(trimmed);
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            Apelido
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="vendas-loja"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
        </label>

        {error ? (
          <p className="rounded-xl border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={!valid || isPending}>
          {isPending ? 'Criando sessão…' : 'Conectar WhatsApp'}
        </Button>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Active session card                                                        */
/* -------------------------------------------------------------------------- */

function SessionCard({
  status,
  phoneNumber,
  sessionName,
  onStop,
  onReset,
  stopPending,
  resetPending,
}: {
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'STOPPED' | null;
  phoneNumber: string | null;
  sessionName: string;
  onStop: () => void;
  onReset: () => void;
  stopPending: boolean;
  resetPending: boolean;
}) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            Sessão · <span className="font-mono text-[var(--color-fg)]">{sessionName}</span>
          </p>
          <div className="flex items-center gap-3">
            <StatusBadge status={status} />
            {phoneNumber ? (
              <span className="font-mono text-[13px] text-[var(--color-fg-muted)]">
                {phoneNumber}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {status === 'WORKING' ? (
            <Button variant="danger" size="sm" onClick={onStop} disabled={stopPending}>
              {stopPending ? 'Desconectando…' : 'Desconectar'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onReset} disabled={resetPending}>
            {resetPending ? 'Limpando…' : 'Recomeçar'}
          </Button>
        </div>
      </div>

      {status === 'SCAN_QR_CODE' ? <QrBox /> : null}

      {status === 'STARTING' ? (
        <p className="mt-5 text-[13px] text-[var(--color-fg-muted)]">
          Iniciando sessão WAHA — pode levar até 30 segundos.
        </p>
      ) : null}

      {status === 'WORKING' ? (
        <div className="mt-6 rounded-2xl border border-[rgba(0,135,90,0.2)] bg-[var(--color-success-bg)] p-5">
          <p className="text-[13px] leading-[1.55] text-[var(--color-success)]">
            ✓ WhatsApp conectado. Confirmações de pedido + recuperação de carrinho vão sair
            automaticamente do seu número.
          </p>
        </div>
      ) : null}

      {status === 'FAILED' ? (
        <div className="mt-6 rounded-2xl border border-[rgba(194,38,26,0.18)] bg-[var(--color-danger-bg)] p-5">
          <p className="text-[13px] leading-[1.55] text-[var(--color-danger)]">
            A sessão falhou ou foi removida do WAHA. Clique em <strong>Recomeçar</strong> para
            apagar a sessão atual e criar uma nova com outro apelido.
          </p>
        </div>
      ) : null}

      {status === 'STOPPED' ? (
        <p className="mt-5 text-[13px] text-[var(--color-fg-muted)]">
          Sessão parada. Clique em <strong>Recomeçar</strong> para conectar novamente.
        </p>
      ) : null}
    </section>
  );
}

function QrBox() {
  const qr = trpc.whatsapp.qr.useQuery(undefined, {
    refetchInterval: 5_000,
    retry: 1,
  });
  return (
    <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-6">
      <p className="text-center text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
        Abra o WhatsApp no seu celular → <strong>Aparelhos conectados</strong> →
        <strong> Conectar um aparelho</strong> e escaneie:
      </p>
      {qr.data?.value ? (
        // biome-ignore lint/performance/noImgElement: WAHA returns base64 PNG.
        <img
          src={`data:${qr.data.mimetype ?? 'image/png'};base64,${qr.data.value}`}
          alt="QR Code WhatsApp"
          className="h-72 w-72 rounded-xl bg-white p-3 shadow-sm"
        />
      ) : (
        <div className="grid h-72 w-72 animate-pulse place-items-center rounded-xl bg-[var(--color-surface)] text-[12px] text-[var(--color-fg-subtle)]">
          Carregando QR…
        </div>
      )}
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        O QR muda automaticamente a cada 30s.
      </p>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'STOPPED' | null;
}) {
  const palette: Record<string, { bg: string; fg: string; ring: string; label: string }> = {
    WORKING: {
      bg: 'bg-[var(--color-success-bg)]',
      fg: 'text-[var(--color-success)]',
      ring: 'ring-[rgba(0,135,90,0.18)]',
      label: 'Conectado',
    },
    SCAN_QR_CODE: {
      bg: 'bg-[var(--color-warning-bg)]',
      fg: 'text-[var(--color-warning)]',
      ring: 'ring-[rgba(183,110,0,0.18)]',
      label: 'Aguardando scan',
    },
    STARTING: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-muted)]',
      ring: 'ring-[var(--color-border)]',
      label: 'Iniciando',
    },
    FAILED: {
      bg: 'bg-[var(--color-danger-bg)]',
      fg: 'text-[var(--color-danger)]',
      ring: 'ring-[rgba(194,38,26,0.2)]',
      label: 'Falhou',
    },
    STOPPED: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-subtle)]',
      ring: 'ring-[var(--color-border)]',
      label: 'Parada',
    },
  };
  const tone = palette[status ?? 'STOPPED'] ?? palette.STOPPED!;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium uppercase tracking-wider ring-1',
        tone.bg,
        tone.fg,
        tone.ring,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {tone.label}
    </span>
  );
}
