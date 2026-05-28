# Incident response — Univercart

Plano de resposta a incidente de segurança / privacidade. Tempo é
sequencial a partir de **T+0 = detecção do incidente**.

## T+0 — Detecção

Origem possível: alerta Sentry, reclamação de cliente, descoberta
interna em auditoria de logs, comunicado de terceiro (parceiro,
pesquisador via `security@univercart.com`).

**Ação imediata:**

1. Abrir war room (canal `#incidents` no Slack/Discord ou call dedicada).
2. Atribuir Incident Commander (IC) — a pessoa que vai dirigir até
   resolução. **Não acumule funções**: IC NÃO faz forense ao mesmo
   tempo.
3. Anotar T+0 timestamp em UTC.

## T+15min — Triagem

**IC decide severity:**

| Severity | Definição | Exemplo |
|----------|-----------|---------|
| SEV-1 | Comprometimento ativo de credenciais OU vazamento confirmado de dados pessoais | Token MP vazado em log público; dump de DB exposto |
| SEV-2 | Vulnerabilidade explorável OU degradação severa | RCE em endpoint público; webhook handler quebrado afetando 100% das vendas |
| SEV-3 | Bug com impacto limitado OU vulnerabilidade não-explorável | Permissão errada em rota pouco usada; CVE em dep dev |

**SEV-1 ⇒ continue todo o runbook. SEV-2/SEV-3 ⇒ acelere os passos.**

## T+1h — Contenção

Objetivo: parar a sangria, NÃO consertar ainda.

- [ ] Revogar credenciais comprometidas (Coolify → Settings → rotate).
- [ ] Forçar logout global se sessão foi comprometida (`DELETE FROM sessions;`).
- [ ] Bloquear origem se DDoS ou abuso massivo (Cloudflare / Coolify firewall).
- [ ] Desativar funcionalidade afetada se possível (feature flag).
- [ ] **Preservar logs** — copie `events_audit`, `webhooks_inbound`,
      `tracking_dispatches` da janela do incidente pra `/var/incidents/<ts>/`.

## T+6h — Forense inicial

- [ ] Escopo: quem foi afetado? Quantos workspaces, usuários, registros?
- [ ] Dados expostos: tipo + volume + sensibilidade. CPF? Senha? Token?
- [ ] Vetor: SQL injection? Credencial vazada? Bug de lógica?
- [ ] Janela: de quando até quando o vetor esteve disponível?
- [ ] Persistência: o atacante deixou backdoor / acesso?
- [ ] Documente tudo em `docs/incidents/YYYY-MM-DD-slug.md` no repo
      privado de operações.

## T+24h — Comunicação interna

- [ ] Time técnico inteiro briefado.
- [ ] Sócio / CEO informado pessoalmente (não por canal escrito apenas).
- [ ] Encarregado de Dados (DPO) acionado.
- [ ] Plano de comunicação aos titulares aprovado.

## T+48h — Comunicação aos titulares afetados

- [ ] Email direto e personalizado pra cada titular afetado (NÃO
      blast em massa — listas dão a impressão errada).
- [ ] Template em `docs/communications/incident-titular-template.md`.
- [ ] Conteúdo:
    - O que aconteceu (em português simples).
    - Quais dados foram afetados.
    - O que JÁ fizemos (contenção, patch, revogação).
    - O que o titular deve fazer (trocar senha, revogar 2FA, monitorar
      cartão se cabível).
    - Canal direto pra dúvidas (`privacidade@univercart.com`).

## T+72h — Notificação ANPD (Art. 48 LGPD)

**Obrigatório.** A ANPD pode multar por atraso ou omissão.

- [ ] Acesse <https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento>
- [ ] Use o canal "Comunicação de Incidente de Segurança".
- [ ] Anexar relatório do incidente:
    - Descrição.
    - Categorias e quantidade de titulares afetados.
    - Categorias e quantidade de dados afetados.
    - Medidas técnicas e organizacionais de segurança adotadas.
    - Riscos relacionados ao incidente.
    - Medidas adotadas para reverter ou mitigar.
    - Plano de comunicação aos titulares.
- [ ] Salvar protocolo da ANPD em `docs/incidents/YYYY-MM-DD-slug.md`.

## T+1 semana — Post-mortem

- [ ] Reunião blameless com time inteiro (max 90min).
- [ ] Documento `docs/incidents/YYYY-MM-DD-slug.md` finalizado com:
    - Timeline detalhada (T+0 até resolução).
    - Análise de causa raiz (5 Porquês).
    - Ações preventivas (mínimo 3, todas com responsável e prazo).
    - Lições aprendidas.
- [ ] Compartilhar resumo público no `/security/incidents` quando
      apropriado (transparência reforça confiança quando bem feita).

## Templates

- `docs/communications/incident-titular-template.md` — email pro titular.
- `docs/communications/anpd-template.md` — texto do formulário ANPD.

## Contatos críticos

| Função | Pessoa | Contato |
|--------|--------|---------|
| Incident Commander default | Kennedy | kennedy@univercart.com |
| DPO/Encarregado | Kennedy | privacidade@univercart.com |
| Jurídico | <a definir> | <a definir> |
| Comunicação | Kennedy | kennedy@univercart.com |

## Quando NÃO seguir este runbook

- Performance degradada sem vazamento (degradation, não incident).
- Bug funcional sem dimensão de segurança (use processo normal de bug fix).
- Vulnerabilidade reportada por terceiro sem PoC funcional (avalie via
  `security@univercart.com` triagem normal).
