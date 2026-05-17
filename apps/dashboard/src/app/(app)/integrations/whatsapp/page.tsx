'use client';

import clsx from 'clsx';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * WhatsApp integration page — Apple-tier light surface.
 *
 * Multi-tenant: every workspace owns its own WAHA session, identified
 * server-side as `ws_<workspaceId-without-dashes>`. The polling cadence
 * matches the transient states only: STARTING / SCAN_QR_CODE update
 * every 3 s, terminal states (WORKING / FAILED / STOPPED) stop polling.
 */
export default function WhatsappIntegrationPage() {
  const status = trpc.whatsapp.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === 'WORKING' || s === 'FAILED' || s === 'STOPPED') return false;
      return 3_000;
    },
  });

  const qr = trpc.whatsapp.qr.useQuery(undefined, {
    enabled: status.data?.status === 'SCAN_QR_CODE',
    refetchInterval: 5_000,
  });

  const startMut = trpc.whatsapp.start.useMutation({
    onSuccess: () => status.refetch(),
  });
  const stopMut = trpc.whatsapp.stop.useMutation({
    onSuccess: () => status.refetch(),
  });

  const current = status.data?.status;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · whatsapp</Kicker>
        <Heading level={1}>Conecte seu WhatsApp.</Heading>
        <p className="max-w-2xl text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
          Cada workspace tem sua própria sessão. Escaneie o QR-code com o seu celular e seus
          clientes começam a receber mensagens vindas do seu número — sem proxies, sem chip
          intermediário.
        </p>
      </header>

      {/* Status card */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
              Status atual
            </p>
            <div className="flex items-center gap-3">
              <StatusBadge status={current ?? 'STOPPED'} />
              {status.data?.phoneNumber ? (
                <span className="font-mono text-[13px] text-[var(--color-fg-muted)]">
                  {status.data.phoneNumber}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex gap-3">
            {current !== 'WORKING' ? (
              <Button onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                {startMut.isPending
                  ? 'Iniciando…'
                  : current === 'SCAN_QR_CODE'
                  ? 'Atualizar QR'
                  : 'Conectar WhatsApp'}
              </Button>
            ) : (
              <Button
                variant="danger"
                onClick={() => stopMut.mutate()}
                disabled={stopMut.isPending}
              >
                {stopMut.isPending ? 'Desconectando…' : 'Desconectar'}
              </Button>
            )}
          </div>
        </div>

        {current === 'SCAN_QR_CODE' ? (
          <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-6">
            <p className="text-center text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
              Abra o WhatsApp no seu celular → <strong>Aparelhos conectados</strong> →
              <strong> Conectar um aparelho</strong> e escaneie:
            </p>
            {qr.data?.value ? (
              // biome-ignore lint/performance/noImgElement: WAHA returns base64 PNG, no static optimization needed.
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
        ) : null}

        {current === 'STARTING' ? (
          <p className="mt-5 text-[13px] text-[var(--color-fg-muted)]">
            Iniciando sessão WAHA — aguarde alguns segundos…
          </p>
        ) : null}

        {current === 'WORKING' ? (
          <div className="mt-6 rounded-2xl border border-[rgba(0,135,90,0.2)] bg-[var(--color-success-bg)] p-5">
            <p className="text-[13px] leading-[1.55] text-[var(--color-success)]">
              ✓ WhatsApp conectado. Confirmações de pedido + recuperação de carrinho vão sair
              automaticamente do seu número.
            </p>
          </div>
        ) : null}

        {current === 'FAILED' ? (
          <div className="mt-6 rounded-2xl border border-[rgba(194,38,26,0.18)] bg-[var(--color-danger-bg)] p-5">
            <p className="text-[13px] leading-[1.55] text-[var(--color-danger)]">
              A sessão falhou. Desconecte e tente novamente. Se persistir, abra o painel WAHA e
              cheque o estado do banco interno.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Apple-tier status pill. Each state gets a distinct tone (success /
 * warning / info / muted) — not the dim emerald-on-black of the legacy
 * design.
 */
function StatusBadge({ status }: { status: string }) {
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
      label: 'Desconectado',
    },
  };
  const tone = palette[status] ?? palette.STOPPED!;
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
