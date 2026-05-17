'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Heading, Kicker, Surface } from '../../../components/ui';
import { useSession } from '../../../lib/auth';

/**
 * Dashboard home — visão geral da operação.
 */
export default function DashboardHome() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/login');
  }, [session.isPending, session.data, router]);

  if (session.isPending) {
    return <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!session.data) return null;

  const firstName = (session.data.user.name ?? 'produtor').split(' ')[0];

  return (
    <div className="space-y-12">
      <header className="space-y-3">
        <Kicker>Visão geral</Kicker>
        <Heading level={1}>Olá, {firstName}.</Heading>
        <p className="max-w-2xl text-[16px] leading-[1.55] text-[var(--color-fg-muted)]">
          Sua operação aparece aqui assim que a primeira venda chegar. Comece conectando o WhatsApp
          e cadastrando seu produto.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="GMV hoje" value="R$ 0,00" trend="—" />
        <MetricCard label="Pedidos hoje" value="0" trend="—" />
        <MetricCard label="Taxa de conversão" value="—" trend="vs. ontem" />
      </section>

      <section>
        <div className="mb-5 flex items-baseline justify-between">
          <Heading level={3}>Próximos passos</Heading>
          <p className="text-[13px] text-[var(--color-fg-subtle)]">Recomendado para começar</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <NextStep
            n="01"
            href="/integrations/whatsapp"
            title="Conectar WhatsApp"
            body="Escanear QR code e ativar o canal de mensagens."
          />
          <NextStep
            n="02"
            href="/produtos"
            title="Cadastrar produto"
            body="Nome, preço, descrição. Link de checkout gerado automaticamente."
          />
          <NextStep
            n="03"
            href="/checkout"
            title="Personalizar checkout"
            body="Cor, logo, campos, métodos de pagamento."
          />
        </div>
      </section>
    </div>
  );
}

function MetricCard({ label, value, trend }: { label: string; value: string; trend: string }) {
  return (
    <Surface className="space-y-3">
      <p className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className="display text-[36px] font-semibold leading-none tracking-tight text-[var(--color-fg)]">
        {value}
      </p>
      <p className="text-[13px] text-[var(--color-fg-muted)]">{trend}</p>
    </Surface>
  );
}

function NextStep({
  n,
  href,
  title,
  body,
}: {
  n: string;
  href: string;
  title: string;
  body: ReactNode;
}) {
  return (
    <a href={href} className="surface-interactive group flex flex-col gap-3 p-6">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-brand-600)]">
        {n}
      </span>
      <p className="text-[16px] font-semibold tracking-tight text-[var(--color-fg)]">{title}</p>
      <p className="text-[14px] leading-[1.5] text-[var(--color-fg-muted)]">{body}</p>
      <span className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-fg)] transition group-hover:gap-2">
        Abrir
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-3">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </span>
    </a>
  );
}
