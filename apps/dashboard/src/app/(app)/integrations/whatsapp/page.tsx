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
          // Status pode vir do `me` (sync reativo no GET) ou do
          // `status` query separado (que poll a cada 3s). Priorizamos
          // o polling porque é mais fresh; cai pro `me` quando o
          // polling ainda nao chegou.
          status={status.data?.status ?? me.data.status ?? null}
          phoneNumber={status.data?.phoneNumber ?? me.data.phoneNumber ?? null}
          sessionName={me.data.sessionName}
          connectedAt={me.data.connectedAt}
          disconnectedAt={me.data.disconnectedAt}
          createdAt={me.data.createdAt}
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
  connectedAt,
  disconnectedAt,
  createdAt,
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
  connectedAt: Date | string | null;
  disconnectedAt: Date | string | null;
  createdAt: Date | string;
  onStop: () => void;
  onRetry: () => void;
  onReset: () => void;
  stopPending: boolean;
  retryPending: boolean;
  retryError: string | null;
  resetPending: boolean;
}) {
  const canRetry = status === 'FAILED' || status === 'STOPPED';
  const isWorking = status === 'WORKING';

  return (
    <div className="flex flex-col gap-5">
      {/* ─── HERO — número, status ao vivo, identidade da sessão. ─── */}
      <section
        className={clsx(
          'relative overflow-hidden rounded-3xl border bg-[var(--color-surface)] p-7',
          isWorking ? 'border-[rgba(0,135,90,0.25)]' : 'border-[var(--color-border)]',
        )}
      >
        {isWorking ? (
          <div
            className="-translate-y-1/2 pointer-events-none absolute top-0 right-0 h-64 w-64 translate-x-1/3 rounded-full bg-[var(--color-success)] opacity-[0.07] blur-3xl"
            aria-hidden
          />
        ) : null}

        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-center gap-5">
            {/* Avatar — ícone WhatsApp grande com indicador de status */}
            <div className="relative">
              <div
                className={clsx(
                  'grid size-16 place-items-center rounded-2xl shadow-[var(--shadow-md)]',
                  isWorking
                    ? 'bg-gradient-to-br from-[#25D366] to-[#128C7E]'
                    : 'bg-[var(--color-surface-muted)]',
                )}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className={clsx(
                    'size-9',
                    isWorking ? 'text-white' : 'text-[var(--color-fg-subtle)]',
                  )}
                  aria-hidden
                >
                  <title>WhatsApp</title>
                  <path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5 0-.1-.7-1.7-.9-2.3-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4 0 1.4 1 2.8 1.2 3 .1.2 2 3 4.8 4.2 1.7.7 2.3.7 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2 0-.1-.2-.2-.5-.3zM12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 5L2 22l5.2-1.3c1.5.8 3.1 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2z" />
                </svg>
              </div>
              {/* Status dot — pulsa quando ativo */}
              <span
                className={clsx(
                  'absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border-2 border-[var(--color-surface)]',
                  isWorking
                    ? 'bg-[var(--color-success)]'
                    : status === 'FAILED'
                      ? 'bg-[var(--color-danger)]'
                      : 'bg-[var(--color-warning)]',
                )}
              >
                {isWorking ? <span className="size-2 animate-pulse rounded-full bg-white" /> : null}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.16em]">
                {isWorking ? 'Número ativo' : 'Sessão'}
              </p>
              <h2 className="font-semibold text-[22px] text-[var(--color-fg)] tabular-nums">
                {phoneNumber ? formatPhoneBR(phoneNumber) : '—'}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={status} />
                <span className="font-mono text-[12px] text-[var(--color-fg-subtle)]">
                  {sessionName}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {isWorking ? (
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

        {/* ─── Metrics row — 4 cards de info. ─── */}
        {isWorking ? (
          <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricTile label="Status" value="Conectado" tone="success" />
            <MetricTile
              label="Conectado em"
              value={connectedAt ? formatRelativeShort(connectedAt) : '—'}
            />
            <MetricTile label="Motor" value="WEBJS" />
            <MetricTile label="Criada em" value={formatDateShort(createdAt)} />
          </div>
        ) : null}

        {/* ─── Action: enviar mensagem de teste — só quando WORKING. ─── */}
        {isWorking ? <SendTestForm /> : null}
      </section>

      {/* ─── Estados não-conectados — QR / erro / parada ─── */}
      {status === 'SCAN_QR_CODE' || status === 'STARTING' ? (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <QrBox status={status} />
        </section>
      ) : null}

      {status === 'FAILED' ? (
        <section className="rounded-2xl border border-[rgba(194,38,26,0.18)] bg-[var(--color-danger-bg)] p-5">
          <p className="font-semibold text-[12px] text-[var(--color-danger)] uppercase tracking-[0.14em]">
            Sessão falhou no WAHA
          </p>
          <p className="mt-2 text-[13px] text-[var(--color-danger)] leading-[1.55]">
            Clique em <strong>Tentar novamente</strong> pra reiniciar mantendo o apelido, ou{' '}
            <strong>Mudar nome</strong> pra apagar e criar uma com outro apelido.
          </p>
          {retryError ? (
            <p className="mt-2 font-mono text-[12px] text-[var(--color-danger)]">{retryError}</p>
          ) : null}
        </section>
      ) : null}

      {status === 'STOPPED' ? (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-5">
          <p className="font-semibold text-[12px] text-[var(--color-fg-muted)] uppercase tracking-[0.14em]">
            Sessão parada
            {disconnectedAt ? ` · ${formatRelativeShort(disconnectedAt)}` : ''}
          </p>
          <p className="mt-2 text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Clique em <strong>Tentar novamente</strong> pra reconectar mantendo o apelido.
          </p>
        </section>
      ) : null}

      {/* ─── O que dispara automaticamente — info copy clarividente. ─── */}
      {isWorking ? (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
            Automações ligadas
          </p>
          <ul className="mt-3 space-y-2 text-[13px] text-[var(--color-fg)]">
            <AutomationItem
              label="Confirmação de pedido"
              body="Mensagem instantânea após o pagamento aprovado."
            />
            <AutomationItem
              label="Recuperação de carrinho"
              body="Cadência de até 3 disparos pra leads que abriram o checkout e não finalizaram."
            />
            <AutomationItem
              label="Magic link Univercart Connect"
              body="Login automático no SaaS parceiro quando o plano tem Connect configurado."
            />
            <AutomationItem
              label="Ping do produtor"
              body="Notificação privada toda vez que uma venda nova é aprovada."
            />
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ─── Helper components ──────────────────────────────────────────────────────

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success';
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-3 py-2.5">
      <p className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-[0.12em]">
        {label}
      </p>
      <p
        className={clsx(
          'mt-1 font-semibold text-[14px]',
          tone === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-fg)]',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function AutomationItem({ label, body }: { label: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-1 inline-flex h-2 w-2 shrink-0 rounded-full bg-[var(--color-success)]" />
      <span className="leading-[1.55]">
        <span className="font-medium text-[var(--color-fg)]">{label}</span>{' '}
        <span className="text-[var(--color-fg-muted)]">— {body}</span>
      </span>
    </li>
  );
}

function SendTestForm() {
  const [target, setTarget] = useState('');
  const [text, setText] = useState('Olá! Mensagem de teste do payunivercart.');
  const send = trpc.whatsapp.sendTest.useMutation();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    send.mutate({
      text: text.trim() || undefined,
      targetPhone: target.trim() || undefined,
    });
  };

  return (
    <div className="relative mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-[var(--color-brand-50)] text-[var(--color-brand-700)]">
          <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
            <title>Teste</title>
            <path
              d="M2.5 8h11M9 4.5L13.5 8 9 11.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <p className="font-semibold text-[12px] text-[var(--color-fg)] uppercase tracking-[0.14em]">
          Enviar mensagem de teste
        </p>
      </div>
      <p className="mt-1 text-[12px] text-[var(--color-fg-subtle)] leading-[1.55]">
        Confirma que sua sessão tá viva sem precisar esperar um cliente comprar. Sem alvo, manda pro
        seu número cadastrado em Configurações → Empresa.
      </p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <input
            type="tel"
            placeholder="+55 31 99999-9999 (opcional)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {send.isSuccess ? (
              <p className="text-[var(--color-success)]">
                ✓ Mensagem enviada pra {send.data.target}. Veja seu WhatsApp.
              </p>
            ) : send.error ? (
              <p className="text-[var(--color-danger)]">{send.error.message}</p>
            ) : (
              <p className="text-[var(--color-fg-subtle)]">
                Resposta da WAHA aparece aqui ao enviar.
              </p>
            )}
          </div>
          <Button type="submit" size="sm" disabled={send.isPending}>
            {send.isPending ? 'Enviando…' : 'Enviar teste'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function formatPhoneBR(raw: string): string {
  // Aceita "+5531984956383", "5531984956383", "31984956383" etc.
  const digits = raw.replace(/\D+/g, '');
  // Brasil: 55 + DDD (2) + número (8 ou 9)
  if (digits.length >= 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 9) return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8) return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function formatRelativeShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'agora há pouco';
  if (diffSec < 3600) return `há ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86_400) return `há ${Math.floor(diffSec / 3600)} h`;
  if (diffSec < 2_592_000) return `há ${Math.floor(diffSec / 86_400)} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function formatDateShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
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
