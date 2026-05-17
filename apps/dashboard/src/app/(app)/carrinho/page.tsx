'use client';

import { Button, Heading, Kicker } from '../../../components/ui';
import { formatCents } from '../../../lib/money';
import { trpc } from '../../../lib/trpc';

/**
 * Recuperação de carrinho — cadence health + activity feed.
 *
 * Block 25 ships read-only step view + a 30s-refreshing activity
 * table of the last attempts. The cadence editor (delays +
 * templates) lands in a follow-up block.
 */
export default function CarrinhoPage() {
  const campaign = trpc.recovery.activeCampaign.useQuery();
  const recent = trpc.recovery.recentAttempts.useQuery(
    { limit: 30 },
    { staleTime: 15_000, refetchInterval: 30_000 },
  );
  const utils = trpc.useUtils();
  const toggle = trpc.recovery.setActive.useMutation({
    onSuccess: () => utils.recovery.activeCampaign.invalidate(),
  });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>recuperação · carrinho abandonado</Kicker>
        <Heading level={1}>Não perca a venda no Pix.</Heading>
        <p className="max-w-2xl text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
          Toda vez que um cliente gera Pix mas não paga, a plataforma manda mensagens automáticas
          do seu WhatsApp no melhor momento. Os intervalos abaixo são os padrões que melhor
          converteram em testes em produtos digitais brasileiros.
        </p>
      </header>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
              Campanha ativa
            </p>
            <h2 className="text-[18px] font-semibold text-[var(--color-fg)]">
              {campaign.data?.name ?? 'Padrão'}
            </h2>
            <p className="text-[12px] text-[var(--color-fg-subtle)]">
              {campaign.data?.steps.length ?? 0} toques · roda automaticamente assim que o pedido
              entra em <strong>pendente</strong>.
            </p>
          </div>
          {campaign.data ? (
            <Button
              variant={campaign.data.isActive ? 'secondary' : 'primary'}
              size="sm"
              onClick={() =>
                toggle.mutate({
                  campaignId: campaign.data!.id,
                  isActive: !campaign.data!.isActive,
                })
              }
              disabled={toggle.isPending}
            >
              {toggle.isPending
                ? 'Atualizando…'
                : campaign.data.isActive
                ? 'Pausar campanha'
                : 'Ativar campanha'}
            </Button>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col gap-3">
          {(campaign.data?.steps ?? []).map((step, idx) => (
            <div
              key={idx}
              className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-4"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-success-bg)] text-[12px] font-semibold text-[var(--color-success)]">
                {idx + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--color-fg)]">
                  Depois de {formatDelay(step.delayMinutes)}
                  <span className="ml-2 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                    {step.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                  </span>
                </p>
                <p className="mt-1 text-[12px] leading-[1.55] text-[var(--color-fg-muted)]">
                  {step.template}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-5 flex items-baseline justify-between">
          <Heading level={3}>Disparos recentes</Heading>
          <p className="text-[13px] text-[var(--color-fg-subtle)]">Atualiza a cada 30s</p>
        </div>
        {recent.isPending ? (
          <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>
        ) : !recent.data || recent.data.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
            <p className="text-[14px] text-[var(--color-fg-muted)]">
              Nenhum disparo ainda. Assim que um cliente gerar Pix e não pagar, os toques aparecem
              aqui.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-muted)] text-left text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                <tr>
                  <th className="px-5 py-3 font-semibold">Pedido</th>
                  <th className="px-5 py-3 font-semibold">Cliente</th>
                  <th className="px-5 py-3 font-semibold">Toque</th>
                  <th className="px-5 py-3 font-semibold">Quando</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {recent.data.map((row) => (
                  <tr
                    key={row.id}
                    className="transition hover:bg-[var(--color-surface-muted)]/50"
                  >
                    <td className="px-5 py-3">
                      <div className="flex flex-col">
                        <span className="font-mono text-[12px] text-[var(--color-fg)]">
                          {row.publicReference}
                        </span>
                        <span className="text-[11px] text-[var(--color-fg-subtle)]">
                          {formatCents(row.totalCents, row.currency)}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--color-fg)]">
                          {row.customerName}
                        </span>
                        <span className="text-[12px] text-[var(--color-fg-subtle)]">
                          {row.customerEmail}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-[var(--color-fg-muted)]">
                      <span className="font-medium text-[var(--color-fg)]">
                        Toque {row.stepIndex + 1}
                      </span>
                      <span className="ml-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                        · {row.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-[var(--color-fg-subtle)]">
                      {row.sentAt ? (
                        <>Enviado {fmtDate(row.sentAt)}</>
                      ) : (
                        <>Agendado {fmtDate(row.scheduledFor)}</>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusPill status={row.status} failureReason={row.failureReason} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusPill({
  status,
  failureReason,
}: {
  status: string;
  failureReason: string | null;
}) {
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    queued: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-muted)]',
      label: 'Aguardando',
    },
    processing: {
      bg: 'bg-[var(--color-warning-bg)]',
      fg: 'text-[var(--color-warning)]',
      label: 'Enviando',
    },
    sent: {
      bg: 'bg-[var(--color-success-bg)]',
      fg: 'text-[var(--color-success)]',
      label: 'Enviado',
    },
    skipped: {
      bg: 'bg-[var(--color-surface-muted)]',
      fg: 'text-[var(--color-fg-subtle)]',
      label: 'Não disparou',
    },
    failed: {
      bg: 'bg-[var(--color-danger-bg)]',
      fg: 'text-[var(--color-danger)]',
      label: 'Falhou',
    },
  };
  const tone = palette[status] ?? palette.queued!;
  return (
    <span
      title={failureReason ?? undefined}
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${tone.bg} ${tone.fg}`}
    >
      {tone.label}
    </span>
  );
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60);
    return `${h} h`;
  }
  const d = Math.round(minutes / (60 * 24));
  return `${d} dia${d === 1 ? '' : 's'}`;
}

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
