import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL_VERSIONS, PRIVACY_CHANGELOG, SUB_PROCESSORS } from '../../lib/legal';

export const metadata: Metadata = {
  title: 'Política de Privacidade · Univercart',
  description: 'Política de Privacidade da plataforma Univercart conforme LGPD.',
  robots: { index: true, follow: true },
};

/**
 * Política de Privacidade — público, sem auth. Conformidade LGPD
 * (Lei 13.709/2018): Art. 9º (informação), Art. 18 (direitos do
 * titular), Art. 41 (DPO/encarregado).
 */
export default function PrivacidadePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2 border-[var(--color-border)] border-b pb-6">
        <Link href="/" className="text-[12px] text-[var(--color-fg-muted)] hover:underline">
          ← Univercart
        </Link>
        <h1 className="font-bold text-[32px] text-[var(--color-fg)] tracking-tight">
          Política de Privacidade
        </h1>
        <p className="text-[13px] text-[var(--color-fg-subtle)]">
          Versão {LEGAL_VERSIONS.privacy} · em vigor desde {LEGAL_VERSIONS.privacy}
        </p>
      </header>

      <article className="flex flex-col gap-6 text-[15px] text-[var(--color-fg)] leading-[1.7]">
        <Section title="1. Quem somos">
          <p>
            Esta Política de Privacidade descreve como a <strong>Univercart</strong> (controladora)
            coleta, usa, compartilha e protege dados pessoais ao operar a plataforma SaaS disponível
            em <code>univercart.com</code>.
          </p>
        </Section>

        <Section title="2. Dados que coletamos">
          <p>Coletamos dois conjuntos de dados:</p>
          <p>
            <strong>2.1. Dados do produtor</strong> — fornecidos no cadastro e na operação da conta:
            nome, email, telefone, CPF/CNPJ, dados da empresa, credenciais de gateway (cifradas em
            AES-256-GCM), URL de produto, dados de pagamento (taxa SaaS, método), preferências de
            marca.
          </p>
          <p>
            <strong>2.2. Dados importados</strong> — quando o produtor opera a Plataforma, recebemos
            dados pessoais dos compradores finais (nome, email, telefone, CPF, endereço de cobrança,
            IP, user-agent, informações de transação). Atuamos como <strong>operador</strong> destes
            dados; o produtor é o controlador perante seus compradores.
          </p>
        </Section>

        <Section title="3. Finalidades do tratamento">
          <ul className="list-disc pl-5 marker:text-[var(--color-brand-500)]">
            <li>Autenticação, gestão de conta e suporte.</li>
            <li>
              Processamento de pagamentos via gateways integrados (cartão, PIX, boleto, assinaturas
              recorrentes).
            </li>
            <li>Envio de notificações transacionais por email e WhatsApp.</li>
            <li>Operação de marketplace de afiliados e cálculo de comissões.</li>
            <li>Métricas agregadas, antifraude e melhoria contínua.</li>
            <li>Cumprimento de obrigações legais, regulatórias e contratuais.</li>
          </ul>
        </Section>

        <Section title="4. Bases legais (Art. 7º LGPD)">
          <ul className="list-disc pl-5 marker:text-[var(--color-brand-500)]">
            <li>
              <strong>Execução de contrato</strong> (Art. 7º V): operação da conta SaaS contratada.
            </li>
            <li>
              <strong>Cumprimento de obrigação legal</strong> (Art. 7º II): retenção fiscal,
              tributária, antifraude.
            </li>
            <li>
              <strong>Legítimo interesse</strong> (Art. 7º IX): segurança da Plataforma, métricas de
              uso agregado, telemetria de erros.
            </li>
            <li>
              <strong>Consentimento</strong> (Art. 7º I): comunicações de marketing e cookies não
              essenciais.
            </li>
          </ul>
        </Section>

        <Section title="5. Compartilhamento — operadores (sub-processadores)">
          <p>
            Compartilhamos dados pessoais com os operadores listados abaixo, exclusivamente para
            executar as finalidades descritas. Todos atuam sob contrato de processamento de dados
            (DPA) ou equivalente.
          </p>
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--color-surface-muted)]/60">
                <tr className="text-left">
                  <th className="px-4 py-2 font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase">
                    Operador
                  </th>
                  <th className="px-4 py-2 font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase">
                    Finalidade
                  </th>
                  <th className="px-4 py-2 font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase">
                    Região
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {SUB_PROCESSORS.map((p) => (
                  <tr key={p.name}>
                    <td className="px-4 py-2 font-medium text-[var(--color-fg)]">{p.name}</td>
                    <td className="px-4 py-2 text-[var(--color-fg-muted)]">{p.purpose}</td>
                    <td className="px-4 py-2 text-[var(--color-fg-muted)]">{p.region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Transferências internacionais (operadores fora do Brasil) ocorrem sob salvaguardas
            contratuais conformes Art. 33 da LGPD.
          </p>
        </Section>

        <Section title="6. Seus direitos (Art. 18 LGPD)">
          <p>O titular pode, a qualquer momento e gratuitamente:</p>
          <ul className="list-disc pl-5 marker:text-[var(--color-brand-500)]">
            <li>
              <strong>Confirmar existência de tratamento</strong> (I) — via painel “Conta”.
            </li>
            <li>
              <strong>Acessar os dados</strong> (II) — endpoint <code>/api/auth/export</code>{' '}
              retorna JSON com tudo que mantemos.
            </li>
            <li>
              <strong>Corrigir dados incompletos, inexatos ou desatualizados</strong> (III) — via
              painel “Conta &gt; Perfil”.
            </li>
            <li>
              <strong>Anonimizar, bloquear ou eliminar</strong> (IV) — solicitação por email.
            </li>
            <li>
              <strong>Portabilidade</strong> (V) — mesmo endpoint do (II), formato JSON aberto.
            </li>
            <li>
              <strong>Eliminação</strong> (VI) — endpoint <code>/api/auth/delete</code> ou
              solicitação por email; respeitando obrigações legais de retenção mínima.
            </li>
            <li>
              <strong>Informação sobre compartilhamento</strong> (VII) — esta Seção 5.
            </li>
            <li>
              <strong>Negar consentimento</strong> (VIII) — banner de cookies + opt-out de
              marketing.
            </li>
            <li>
              <strong>Revogar consentimento</strong> (IX) — via “Conta &gt; Preferências”.
            </li>
          </ul>
        </Section>

        <Section title="7. Retenção de dados">
          <p>
            Conservamos dados pelo prazo necessário às finalidades acima ou até a eliminação
            solicitada pelo titular. Dados fiscais e tributários (notas, transações, comprovantes)
            são retidos pelo prazo legal mínimo de 5 (cinco) anos. Após o prazo, são anonimizados ou
            destruídos.
          </p>
        </Section>

        <Section title="8. Segurança técnica e organizacional (Art. 46)">
          <ul className="list-disc pl-5 marker:text-[var(--color-brand-500)]">
            <li>Criptografia AES-256-GCM para credenciais e segredos em repouso.</li>
            <li>TLS 1.2+ obrigatório em todas as conexões.</li>
            <li>Senhas armazenadas com bcrypt cost 12+.</li>
            <li>JWT de sessão com cookies HttpOnly + Secure + SameSite=Lax.</li>
            <li>
              Sessões 2FA TOTP disponíveis e recomendadas para todas as contas administrativas.
            </li>
            <li>
              Logs operacionais com remoção automática de PII via filtros (Sentry, dispatch
              ledgers).
            </li>
            <li>Backups diários do banco de dados com retenção de 30 dias.</li>
            <li>
              Auditoria append-only de ações sensíveis (criação/modificação/exclusão) — ver{' '}
              <code>audit_log</code>.
            </li>
          </ul>
        </Section>

        <Section title="9. Cookies">
          <p>
            Usamos cookies estritamente necessários (sessão, autenticação, CSRF) por base legal de
            legítimo interesse. Cookies analíticos e de marketing são opt-in via banner. Recusar
            cookies não-essenciais não impede o uso da Plataforma.
          </p>
        </Section>

        <Section title="10. Crianças e adolescentes">
          <p>
            A Plataforma destina-se exclusivamente a maiores de 18 anos. Não coletamos
            conscientemente dados de menores. Caso identifiquemos coleta indevida, eliminaremos
            imediatamente os dados e a conta.
          </p>
        </Section>

        <Section title="11. DPO / Encarregado">
          <p>
            Canal LGPD (DPO/Encarregado):{' '}
            <a
              href="mailto:privacidade@univercart.com"
              className="text-[var(--color-brand-500)] hover:underline"
            >
              privacidade@univercart.com
            </a>
            . Respondemos toda solicitação em até 15 (quinze) dias corridos, conforme Art. 19 da
            LGPD.
          </p>
        </Section>

        <Section title="12. Incidentes">
          <p>
            Em caso de incidente de segurança que possa acarretar risco ou dano relevante aos
            titulares, comunicaremos a ANPD e os titulares afetados em até 72 horas, com descrição
            do ocorrido, dados envolvidos, medidas adotadas e recomendações de proteção.
          </p>
        </Section>

        <Section title="13. Mudanças nesta Política">
          <p>
            Esta Política pode ser atualizada. Mudanças materiais disparam re-aceite ativo no
            painel; o histórico abaixo é mantido permanentemente.
          </p>
        </Section>
      </article>

      <section className="mt-12 flex flex-col gap-3 border-[var(--color-border)] border-t pt-6">
        <h2 className="font-semibold text-[14px] text-[var(--color-fg-subtle)] uppercase tracking-[0.14em]">
          Histórico de versões
        </h2>
        <ul className="flex flex-col gap-2 text-[13px]">
          {PRIVACY_CHANGELOG.map((entry) => (
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
