'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Privacy & data — LGPD self-service page (`/configuracoes/privacidade`).
 *
 * Two actions exposed to the authenticated user:
 *   - Exportar meus dados (Art. 18 II + V).
 *   - Apagar minha conta (Art. 18 VI).
 *
 * Both call the `account` tRPC router. Delete demands a literal
 * confirmation phrase + redirect to login on success (session is
 * invalidated by the cascade).
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export default function PrivacidadePage() {
  const router = useRouter();
  const exportData = trpc.account.exportData.useQuery(undefined, { enabled: false });
  const deleteAccount = trpc.account.deleteAccount.useMutation({
    onSuccess: () => {
      toast.success('Conta apagada. Você será redirecionado.');
      setTimeout(() => router.replace('/login'), 1500);
    },
    onError: (err) => toast.error(err.message),
  });

  const [confirmText, setConfirmText] = useState('');

  const triggerExport = async () => {
    const res = await exportData.refetch();
    if (!res.data) {
      toast.error('Não foi possível gerar o export.');
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `univercart-meus-dados-${res.data.user?.id ?? 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Export pronto — baixado em formato JSON.');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-10"
    >
      <header className="flex flex-col gap-3">
        <Kicker>configurações · privacidade</Kicker>
        <Heading level={1}>Privacidade e dados.</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Direitos LGPD self-service. Para qualquer outra solicitação (correção de dados históricos
          de pedidos, revogação seletiva de consentimento, etc.), fale com o DPO em{' '}
          <a
            href="mailto:privacidade@univercart.com"
            className="text-[var(--color-brand-500)] hover:underline"
          >
            privacidade@univercart.com
          </a>
          .
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-[18px] text-[var(--color-fg)] tracking-tight">
            Exportar meus dados
          </h2>
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Baixa um JSON com tudo que mantemos sobre você na plataforma — perfil, memberships,
            identidade de afiliado. Art. 18 II + V da LGPD.
          </p>
        </div>
        <div>
          <Button onClick={triggerExport} disabled={exportData.isFetching}>
            {exportData.isFetching ? 'Gerando…' : 'Baixar JSON'}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-bg)]/30 p-6">
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-[18px] text-[var(--color-danger)] tracking-tight">
            Apagar minha conta
          </h2>
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-[1.55]">
            Hard-delete da sua conta + cascading rows (sessões, memberships). Workspaces em que você
            é o único owner permanecem (cleanup manual via DPO). Esta ação é{' '}
            <strong className="text-[var(--color-danger)]">irreversível</strong>. Art. 18 VI da
            LGPD.
          </p>
          <p className="text-[12px] text-[var(--color-fg-subtle)]">
            Digite{' '}
            <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono">
              APAGAR MINHA CONTA
            </code>{' '}
            abaixo para confirmar.
          </p>
        </div>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="APAGAR MINHA CONTA"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-danger)] focus:outline-none"
        />
        <div>
          <Button
            variant="danger"
            disabled={confirmText !== 'APAGAR MINHA CONTA' || deleteAccount.isPending}
            onClick={() => deleteAccount.mutate({ confirm: 'APAGAR MINHA CONTA' })}
          >
            {deleteAccount.isPending ? 'Apagando…' : 'Apagar minha conta permanentemente'}
          </Button>
        </div>
      </section>

      <footer className="flex flex-col gap-2 border-[var(--color-border)] border-t pt-6 text-[12px] text-[var(--color-fg-subtle)]">
        <p>
          Documentos legais:{' '}
          <Link href="/termos" className="text-[var(--color-fg-muted)] hover:underline">
            Termos de Uso
          </Link>
          {' · '}
          <Link href="/privacidade" className="text-[var(--color-fg-muted)] hover:underline">
            Política de Privacidade
          </Link>
        </p>
      </footer>
    </motion.div>
  );
}
