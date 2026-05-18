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
      // WORKING is the only happy terminal — stop polling there.
      // FAILED / STOPPED keep polling at 10s so external recovery
      // (operator restarts WAHA, retry mutation lands) flips the
      // UI without forcing the producer to reload.
      if (s === 'WORKING') return false;
      if (s === 'FAILED' || s === 'STOPPED') return 10_000;
      return 3_000;
    },
  });

  const utils = trpc.useUtils();
  const start = trpc.whatsapp.start.useMutation({
    onSuccess: () => {
      utils.whatsapp.me.invalidate();
      utils.whatsapp.status.invalidate();
      utils.whatsapp.qr.invalidate();
    },
  });
  const stop = trpc.whatsapp.stop.useMutation({
    onSuccess: () => utils.whatsapp.status.invalidate(),
  });
  const retry = trpc.whatsapp.retry.useMutation({
    onSuccess: () => {
      utils.whatsapp.status.invalidate();
      utils.whatsapp.qr.invalidate();
    },
  });
  const reset = trpc.whatsapp.reset.useMutation({
    onSuccess: () => {
      utils.whatsapp.me.invalidate();
      utils.whatsapp.status.invalidate();
      utils.whatsapp.qr.invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · whatsapp</Kicker>
        <Heading level={1}>Conecte seu WhatsApp.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Cada workspace tem sua própria sessão. Escolha um apelido curto, escaneie o QR-code com o
          seu celular e seus clientes começam a receber mensagens vindas do seu número — sem
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
          onRetry={() => retry.mutate()}
          onReset={() => {
            if (!confirm('Mudar nome apaga a sessão atual no WAHA. Tem certeza?')) return;
            reset.mutate();
          }}
          stopPending={stop.isPending}
          retryPending={retry.isPending}
          retryError={retry.error?.message ?? null}
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
      <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
        Nova sessão
      </p>
      <h2 className="mt-2 font-semibold text-[18px] text-[var(--color-fg)]">
        Dê um apelido para esta sessão
      </h2>
      <p className="mt-2 text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
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
          <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Apelido
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="vendas-loja"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
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
  onRetry,
  onReset,
  stopPending,
  retryPending,
  retryError,
  resetPending,
}: {
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'STOPPED' | null;
  phoneNumber: string | null;
  sessionName: string;
  onStop: () => void;
  onRetry: () => void;
  onReset: () => void;
  stopPending: boolean;
  retryPending: boolean;
  retryError: string | null;
  resetPending: boolean;
}) {
  const canRetry = status === 'FAILED' || status === 'STOPPED';
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
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
        <div className="flex flex-wrap gap-2">
          {status === 'WORKING' ? (
            <Button variant="danger" size="sm" onClick={onStop} disabled={stopPending}>
              {stopPending ? 'Desconectando…' : 'Desconectar'}
            </Button>
          ) : null}
          {canRetry ? (
            <Button size="sm" onClick={onRetry} disabled={retryPending || resetPending}>
              {retryPending ? 'Reiniciando…' : 'Tentar novamente'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={resetPending || retryPending}
          >
            {resetPending ? 'Limpando…' : 'Mudar nome'}
          </Button>
        </div>
      </div>

      {status === 'SCAN_QR_CODE' || status === 'STARTING' ? <QrBox status={status} /> : null}

      {status === 'WORKING' ? (
        <div className="mt-6 rounded-2xl border border-[rgba(0,135,90,0.2)] bg-[var(--color-success-bg)] p-5">
          <p className="text-[13px] text-[var(--color-success)] leading-[1.55]">
            ✓ WhatsApp conectado. Confirmações de pedido + recuperação de carrinho vão sair
            automaticamente do seu número.
          </p>
        </div>
      ) : null}

      {status === 'FAILED' ? (
        <div className="mt-6 rounded-2xl border border-[rgba(194,38,26,0.18)] bg-[var(--color-danger-bg)] p-5">
          <p className="text-[13px] text-[var(--color-danger)] leading-[1.55]">
            A sessão falhou no WAHA. Clique em <strong>Tentar novamente</strong> para reiniciar
            mantendo o mesmo apelido, ou <strong>Mudar nome</strong> para apagar e criar uma nova
            com outro apelido.
          </p>
          {retryError ? (
            <p className="mt-2 font-mono text-[12px] text-[var(--color-danger)]">{retryError}</p>
          ) : null}
        </div>
      ) : null}

      {status === 'STOPPED' ? (
        <div className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Sessão parada. Clique em <strong>Tentar novamente</strong> para reconectar mantendo o
            mesmo apelido.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function QrBox({ status }: { status: 'STARTING' | 'SCAN_QR_CODE' }) {
  // Poll the QR endpoint even while WAHA reports STARTING — the
  // backend returns `null` until the engine flips to SCAN_QR_CODE,
  // and once it does we want the QR on screen on the next tick (3s)
  // rather than waiting for the next 5s qr-tick.
  const qr = trpc.whatsapp.qr.useQuery(undefined, {
    refetchInterval: 3_000,
    retry: 2,
  });
  const waiting = status === 'STARTING' || !qr.data?.value;
  return (
    <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-6">
      <p className="text-center text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
        Abra o WhatsApp no seu celular → <strong>Aparelhos conectados</strong> →
        <strong> Conectar um aparelho</strong> e escaneie:
      </p>
      {qr.data?.value ? (
        <img
          src={`data:${qr.data.mimetype ?? 'image/png'};base64,${qr.data.value}`}
          alt="QR Code WhatsApp"
          className="h-72 w-72 rounded-xl bg-white p-3 shadow-sm"
        />
      ) : (
        <div className="grid h-72 w-72 animate-pulse place-items-center rounded-xl bg-[var(--color-surface)] p-4 text-center text-[12px] text-[var(--color-fg-subtle)] leading-[1.6]">
          {waiting
            ? 'Aguardando o WAHA renderizar o QR — o motor WEBJS pode levar até 30s para iniciar.'
            : 'Carregando QR…'}
        </div>
      )}
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        O QR muda automaticamente a cada 30s.
      </p>
    </div>
  );
}

const FALLBACK_BADGE_TONE = {
  bg: 'bg-[var(--color-surface-muted)]',
  fg: 'text-[var(--color-fg-subtle)]',
  ring: 'ring-[var(--color-border)]',
  label: 'Parada',
} as const;

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
  const tone = palette[status ?? 'STOPPED'] ?? FALLBACK_BADGE_TONE;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 font-medium text-[12px] uppercase tracking-wider ring-1',
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
