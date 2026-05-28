import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL_VERSIONS, TERMS_CHANGELOG } from '../../lib/legal';

export const metadata: Metadata = {
  title: 'Termos de Uso · Univercart',
  description: 'Termos de Uso da plataforma Univercart.',
  robots: { index: true, follow: true },
};

/**
 * Termos de Uso — público, indexável, sem auth.
 *
 * Versionado em `LEGAL_VERSIONS.terms`. Bumps materiais disparam o
 * banner de re-aceite no dashboard logado (LegalReAcceptBanner).
 */
export default function TermosPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2 border-[var(--color-border)] border-b pb-6">
        <Link href="/" className="text-[12px] text-[var(--color-fg-muted)] hover:underline">
          ← Univercart
        </Link>
        <h1 className="font-bold text-[32px] text-[var(--color-fg)] tracking-tight">
          Termos de Uso
        </h1>
        <p className="text-[13px] text-[var(--color-fg-subtle)]">
          Versão {LEGAL_VERSIONS.terms} · em vigor desde {LEGAL_VERSIONS.terms}
        </p>
      </header>

      <article className="prose prose-invert flex flex-col gap-6 text-[15px] text-[var(--color-fg)] leading-[1.7]">
        <Section title="1. Aceitação">
          <p>
            Ao criar uma conta, acessar ou utilizar a plataforma Univercart (“Plataforma”), você
            (“Usuário”) declara que leu, entendeu e concorda integralmente com estes Termos de Uso,
            com a{' '}
            <Link href="/privacidade" className="text-[var(--color-brand-500)] hover:underline">
              Política de Privacidade
            </Link>{' '}
            e com qualquer documento adicional aqui referenciado. Se você não concorda, NÃO utilize
            a Plataforma.
          </p>
        </Section>

        <Section title="2. Descrição do serviço">
          <p>
            A Univercart é uma plataforma SaaS de checkout e gestão de vendas digitais, voltada a
            produtores que comercializam produtos e serviços online. Oferecemos: integração com
            gateways de pagamento (Mercado Pago, Pagar.me, PagSeguro, Stripe), automações de
            cobrança, gestão de assinaturas, marketplace de afiliados, mensageria via WhatsApp e
            email, e demais ferramentas operacionais descritas no painel.
          </p>
        </Section>

        <Section title="3. Cadastro e segurança da conta">
          <p>
            O Usuário é integralmente responsável pela veracidade dos dados fornecidos e pelo sigilo
            de suas credenciais. Compartilhar acesso ou usar credenciais de terceiros é vedado.
            Recomendamos ativar autenticação em dois fatores (2FA) na conta.
          </p>
        </Section>

        <Section title="4. Responsabilidades do Usuário">
          <ul className="list-disc pl-5">
            <li>
              Garantir que produtos, serviços e descrições anunciados são lícitos, verdadeiros e
              cumprem o Código de Defesa do Consumidor.
            </li>
            <li>
              Cumprir suas obrigações tributárias, contábeis e regulatórias (incluindo emissão de
              nota fiscal quando aplicável).
            </li>
            <li>
              Tratar dados pessoais de clientes finais conforme a LGPD, atuando como controlador
              perante seus compradores.
            </li>
            <li>
              Não utilizar a Plataforma para venda de itens proibidos (substâncias controladas,
              armas, pirataria, conteúdo que viole direitos autorais, etc.).
            </li>
          </ul>
        </Section>

        <Section title="5. Risco operacional e disponibilidade (as-is)">
          <p>
            A Plataforma é fornecida “como está” (as-is). Embora trabalhemos com SLA-alvo de 99,5%
            de uptime, integrações com terceiros (gateways, WhatsApp via WAHA, serviços de email)
            podem apresentar instabilidade fora do nosso controle. Não garantimos disponibilidade
            ininterrupta nem ausência total de falhas.
          </p>
          <p>
            Especificamente quanto ao WhatsApp: o canal opera via WAHA usando a engine não-oficial
            do WhatsApp Web. Bloqueios temporários ou permanentes da conta pelo provedor são risco
            inerente; o Usuário concorda em manter números de contingência.
          </p>
        </Section>

        <Section title="6. Pagamentos e taxas">
          <p>
            As taxas da Univercart estão descritas no painel “Faturamento da plataforma”. As taxas
            cobradas pelos gateways de pagamento são repassadas ao Usuário e configuradas
            diretamente na conta do gateway.
          </p>
        </Section>

        <Section title="7. Privacidade e proteção de dados">
          <p>
            O tratamento de dados pessoais segue a{' '}
            <Link href="/privacidade" className="text-[var(--color-brand-500)] hover:underline">
              Política de Privacidade
            </Link>{' '}
            e a Lei Geral de Proteção de Dados (Lei nº 13.709/2018). O Usuário pode exercer seus
            direitos de titular pelos canais ali descritos.
          </p>
        </Section>

        <Section title="8. Limitação de responsabilidade">
          <p>
            Na medida máxima permitida pela legislação aplicável, a responsabilidade da Univercart
            por qualquer reclamação relacionada à Plataforma fica limitada ao valor total pago pelo
            Usuário nos últimos 12 (doze) meses à Univercart. A Univercart não é responsável por
            lucros cessantes, danos indiretos ou consequenciais.
          </p>
        </Section>

        <Section title="9. Encerramento da conta">
          <p>
            O Usuário pode encerrar a conta a qualquer momento pelo painel ou solicitando eliminação
            pelo endereço descrito na Política de Privacidade. A Univercart pode suspender ou
            encerrar contas que violem estes Termos, mediante notificação por email quando possível.
          </p>
        </Section>

        <Section title="10. Alterações destes Termos">
          <p>
            Estes Termos podem ser atualizados a qualquer momento. Mudanças materiais disparam um
            re-aceite ativo no painel do Usuário; mudanças cosméticas (ortografia, formatação) não
            disparam re-aceite. O histórico de versões está logo abaixo.
          </p>
        </Section>

        <Section title="11. Foro">
          <p>
            Fica eleito o foro da Comarca de São Paulo/SP para dirimir quaisquer dúvidas decorrentes
            destes Termos, com renúncia expressa a qualquer outro, por mais privilegiado que seja.
          </p>
        </Section>

        <Section title="12. Contato">
          <p>
            Dúvidas sobre estes Termos:{' '}
            <a
              href="mailto:suporte@univercart.com"
              className="text-[var(--color-brand-500)] hover:underline"
            >
              suporte@univercart.com
            </a>
            . Solicitações de privacidade:{' '}
            <a
              href="mailto:privacidade@univercart.com"
              className="text-[var(--color-brand-500)] hover:underline"
            >
              privacidade@univercart.com
            </a>
            .
          </p>
        </Section>
      </article>

      <section className="mt-12 flex flex-col gap-3 border-[var(--color-border)] border-t pt-6">
        <h2 className="font-semibold text-[14px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Histórico de versões
        </h2>
        <ul className="flex flex-col gap-2 text-[13px]">
          {TERMS_CHANGELOG.map((entry) => (
            <li key={entry.version} className="text-[var(--color-fg-muted)]">
              <span className="font-mono text-[var(--color-fg)]">{entry.version}</span>
              {' — '}
              {entry.highlights.join('; ')}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold text-[18px] text-[var(--color-fg)] tracking-tight">{title}</h2>
      <div className="flex flex-col gap-3 text-[15px] text-[var(--color-fg-muted)] leading-[1.7]">
        {children}
      </div>
    </section>
  );
}
