'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, GlassCard, Heading, StatusPill } from '../../../../components/ui';
import { useSession } from '../../../../lib/auth';
import { trpc } from '../../../../lib/trpc';

/**
 * WhatsApp integration page. Multi-tenant: every workspace has its own
 * WAHA session, identified server-side as `ws_<workspaceId-without-dashes>`.
 *
 * Flow:
 *   1. Auth-guard; redirect to /login if no session.
 *   2. Read status via `whatsapp.status`. Poll every 3 s while the
 *      session is in a transient state (STARTING / SCAN_QR_CODE).
 *   3. If status is SCAN_QR_CODE, fetch & render the QR via
 *      `whatsapp.qr`, also poll-refresh every 5 s (WAHA rotates the
 *      QR periodically).
 *   4. Producer scans with their phone -> WAHA emits
 *      `session.status -> WORKING`. The webhook handler in api
 *      records it; the next status poll surfaces WORKING and we stop
 *      polling.
 */
export default function WhatsappIntegrationPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  const status = trpc.whatsapp.status.useQuery(undefined, {
    enabled: !!session.data,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      // Stop polling once we reach a terminal state.
      if (s === 'WORKING' || s === 'FAILED' || s === 'STOPPED') return false;
      return 3_000;
    },
  });

  const qr = trpc.whatsapp.qr.useQuery(undefined, {
    enabled: !!session.data && status.data?.status === 'SCAN_QR_CODE',
    refetchInterval: 5_000,
  });

  const startMut = trpc.whatsapp.start.useMutation({
    onSuccess: () => status.refetch(),
  });
  const stopMut = trpc.whatsapp.stop.useMutation({
    onSuccess: () => status.refetch(),
  });

  if (session.isPending) {
    return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  const current = status.data?.status;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Heading>Integração WhatsApp</Heading>
        <p className="text-[var(--color-fg-muted)]">
          Conecte seu número de WhatsApp escaneando o QR-code abaixo. Seu cliente receberá mensagens
          vindas <span className="font-medium">do seu número</span>.
        </p>
      </header>

      <GlassCard className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Status atual
            </p>
            <div className="mt-2 flex items-center gap-3">
              {current ? <StatusPill status={current} /> : <StatusPill status="—" />}
              {status.data?.phoneNumber && (
                <span className="text-sm text-[var(--color-fg-muted)]">
                  {status.data.phoneNumber}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-3">
            {current !== 'WORKING' && (
              <Button onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                {startMut.isPending ? 'Iniciando…' : 'Conectar WhatsApp'}
              </Button>
            )}
            {current === 'WORKING' && (
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

        {current === 'SCAN_QR_CODE' && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-black/30 p-6">
            <p className="text-sm text-[var(--color-fg-muted)]">
              Abra o WhatsApp no seu celular → <strong>Aparelhos conectados</strong> →
              <strong> Conectar um aparelho</strong> e escaneie:
            </p>
            {qr.data?.value ? (
              <img
                src={`data:${qr.data.mimetype ?? 'image/png'};base64,${qr.data.value}`}
                alt="QR Code WhatsApp"
                className="size-72 rounded-xl bg-white p-2"
              />
            ) : (
              <div className="grid size-72 place-items-center rounded-xl bg-white/[0.02] text-sm text-[var(--color-fg-subtle)]">
                Carregando QR…
              </div>
            )}
            <p className="text-xs text-[var(--color-fg-subtle)]">
              O QR muda automaticamente a cada 30s.
            </p>
          </div>
        )}

        {current === 'STARTING' && (
          <p className="text-sm text-[var(--color-fg-muted)]">
            Iniciando sessão WAHA — aguarde alguns segundos.
          </p>
        )}

        {current === 'WORKING' && (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-5">
            <p className="text-sm">
              ✓ WhatsApp conectado. Suas notificações e disparos de recuperação de carrinho vão sair
              daqui.
            </p>
          </div>
        )}

        {current === 'FAILED' && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/[0.05] p-5 text-sm text-red-200">
            A sessão falhou. Tente desconectar e conectar de novo. Se persistir, abra o painel WAHA
            e verifique o status do banco interno.
          </div>
        )}
      </GlassCard>
    </div>
  );
}
