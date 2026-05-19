'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Heading, Kicker } from '../../../../components/ui';
import { useSession } from '../../../../lib/auth';

/**
 * Email integration — Resend-powered transactional channel.
 *
 * The infra side is already shipping: B27 wired `packages/emails` and
 * the gateway webhook fires `sendOrderPaid` on every paid order. This
 * page surfaces three things to the producer:
 *   1. Status of the Resend connection.
 *   2. Transactional templates the platform sends on their behalf.
 *   3. "Em breve" rail for the editor surface (custom templates,
 *      broadcasts, A/B testing).
 *
 * Producer-supplied SMTP / custom-domain "send-as-me" lands in a
 * follow-up — MVP path is the platform's verified domain so producers
 * get reliable delivery without DKIM/SPF homework.
 */

interface TemplateRow {
  id: string;
  name: string;
  trigger: string;
  preview: string;
  status: 'ativo' | 'em-breve';
}

const TEMPLATES: TemplateRow[] = [
  {
    id: 'otp',
    name: 'Código de acesso',
    trigger: 'login OTP (Better-Auth)',
    preview: 'Use o código abaixo no app pra continuar. Válido por 10 minutos.',
    status: 'ativo',
  },
  {
    id: 'order-paid',
    name: 'Pagamento confirmado',
    trigger: 'gateway webhook · transação paid',
    preview: 'Recebemos o pagamento do seu pedido. Aqui está o resumo + número.',
    status: 'ativo',
  },
  {
    id: 'cart-recovery',
    name: 'Recuperação de carrinho',
    trigger: 'cron workers · order pending_payment',
    preview: 'Faltou só o pagamento — separamos sua vaga. Conclui em segundos.',
    status: 'ativo',
  },
  {
    id: 'invoice-failed',
    name: 'Cobrança falhou',
    trigger: 'platform billing · invoice payment_failed',
    preview: 'Sua assinatura está com pagamento pendente. Atualize seu método.',
    status: 'em-breve',
  },
  {
    id: 'broadcast',
    name: 'Broadcast / campanhas',
    trigger: 'manual · dashboard',
    preview: 'Envie comunicação segmentada pra base de compradores.',
    status: 'em-breve',
  },
];

export default function EmailIntegrationPage() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) return <p className="text-[var(--color-fg-muted)]">Carregando…</p>;
  if (!session.data) return null;

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · email</Kicker>
        <Heading level={1}>Email transacional.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          A plataforma dispara confirmações de pagamento, recuperação de carrinho e códigos de
          acesso pelo Resend — entrega monitorada, sem você precisar configurar SPF/DKIM. Os
          domínios <code className="font-mono text-[13px]">@payunivercart.com</code> já vêm
          autenticados.
        </p>
      </header>

      {/* Provider status card */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-black">
              <span className="font-semibold text-[14px] text-white">R</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-[18px] text-[var(--color-fg)]">Resend</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success-bg)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-success)] uppercase tracking-wider">
                  <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
                  Ativo
                </span>
              </div>
              <p className="max-w-md text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
                Provedor de email transacional gerenciado pela plataforma. Você não precisa
                configurar — toda mensagem sai daqui com SPF + DKIM corretos.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-right">
            <dt className="text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              Remetente
            </dt>
            <dd className="font-mono text-[12px] text-[var(--color-fg)]">
              no-reply@payunivercart.com
            </dd>
            <dt className="text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              SPF/DKIM
            </dt>
            <dd className="font-mono text-[12px] text-[var(--color-success)]">verificados</dd>
            <dt className="text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              Limite
            </dt>
            <dd className="text-[12px] text-[var(--color-fg)]">100k/mês incluso</dd>
          </dl>
        </div>
      </section>

      {/* Templates list */}
      <section className="flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h2 className="font-semibold text-[16px] text-[var(--color-fg)]">Templates ativos</h2>
          <span className="text-[12px] text-[var(--color-fg-subtle)]">
            {TEMPLATES.filter((t) => t.status === 'ativo').length} ativos ·{' '}
            {TEMPLATES.filter((t) => t.status === 'em-breve').length} em breve
          </span>
        </header>
        <ul className="grid gap-3 md:grid-cols-2">
          {TEMPLATES.map((tmpl) => {
            const active = tmpl.status === 'ativo';
            return (
              <li
                key={tmpl.id}
                className={
                  active
                    ? 'flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5'
                    : 'flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 opacity-70'
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <h3 className="font-semibold text-[14px] text-[var(--color-fg)]">
                      {tmpl.name}
                    </h3>
                    <p className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                      {tmpl.trigger}
                    </p>
                  </div>
                  <span
                    className={
                      active
                        ? 'rounded-full bg-[var(--color-success-bg)] px-2.5 py-1 font-medium text-[10px] text-[var(--color-success)] uppercase tracking-wider'
                        : 'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-1 font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider'
                    }
                  >
                    {active ? (
                      'Ativo'
                    ) : (
                      <>
                        <LockIcon size={10} /> Em breve
                      </>
                    )}
                  </span>
                </div>
                <blockquote className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-3 py-2 text-[12px] text-[var(--color-fg-muted)] italic leading-[1.5]">
                  “{tmpl.preview}”
                </blockquote>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Editor — em breve */}
      <section className="rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface)] p-6">
        <div className="flex items-start gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]">
            <LockIcon size={16} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-semibold text-[16px] text-[var(--color-fg)]">
              Editor de templates · em breve
            </h2>
            <p className="max-w-xl text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
              Personalize cada email com a sua marca, variáveis dinâmicas e A/B test de assunto. Por
              enquanto os emails saem com o template padrão neutro da plataforma — já entregam, mas
              sem branding seu.
            </p>
          </div>
        </div>
      </section>

      <button
        type="button"
        onClick={() => router.push('/dashboard')}
        className="self-start rounded-xl px-4 py-2 text-[13px] text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
      >
        ← Voltar ao dashboard
      </button>
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
