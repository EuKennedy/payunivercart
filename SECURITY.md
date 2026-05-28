# Security Policy — Univercart

## Reporting a vulnerability

Encontrou uma falha de segurança? **Não abra issue público.** Email
direto pra:

```
security@univercart.com
```

Inclua:

- Descrição do problema (passos pra reproduzir, idealmente com curl ou screenshot).
- Impacto estimado (acesso a dados, escalation, DoS, etc.).
- Versão do código onde detectou (commit SHA se possível).
- Sua identidade pra atribuição responsável (opcional — anônimo também é aceito).

**SLA de resposta:**

- Confirmação de recebimento: **24 horas úteis**.
- Triagem inicial + severity: **48 horas úteis**.
- Patch + deploy (Critical/High): **7 dias corridos**.
- Patch + deploy (Medium/Low): **30 dias corridos**.

## Escopo

Em escopo:

- Domínios `*.univercart.com` (app, api, pay, admin, marketing).
- Repositório `EuKennedy/payunivercart` (código backend, frontend, workers, infra).
- Integrações Univercart Connect (parceiros).

Fora de escopo (não consideramos vulnerabilidade):

- Bugs que requerem acesso físico ao dispositivo do usuário.
- Engenharia social não-técnica (phishing manual, etc.).
- Rate-limiting de endpoints públicos não-críticos.
- Falta de SPF/DKIM/DMARC em subdomínios de teste.
- Issues em dependências de terceiros sem PoC funcional na plataforma.

## Programa de divulgação responsável

Reconhecemos publicamente (com permissão) quem reporta vulnerabilidades
válidas no Hall of Fame em `https://univercart.com/security/credits`
(quando o site público lançar).

**Não há bounty monetário no momento.** Mudanças na política serão
anunciadas aqui.

## Práticas internas

- Criptografia AES-256-GCM (libsodium) para credenciais e segredos em repouso.
- TLS 1.2+ obrigatório em todas as conexões públicas.
- Hash bcrypt cost 12+ para senhas.
- JWT de sessão com cookies HttpOnly + Secure + SameSite=Lax.
- 2FA TOTP disponível em todas as contas.
- Audit log append-only (HMAC-chained) para ações sensíveis — `events_audit`.
- Sentry com scrubbing automático de PII (email, CPF, CNPJ, phone, tokens).
- Backups diários do banco com retenção de 30 dias.
- CI: pnpm audit (prod + dev) + osv-scanner + gitleaks + trivy + CodeQL
  em todo push pra main + todo PR.

## Detalhes operacionais

- Política LGPD pública: <https://app.univercart.com/privacidade>
- Termos de Uso públicos: <https://app.univercart.com/termos>
- Encarregado de Dados (DPO): <privacidade@univercart.com>
- Resposta a incidente: ver `docs/incident-runbook.md` no repo
  (interno; comunicação à ANPD em até 72h conforme Art. 48 LGPD).

## Histórico

- 2026-05-28 — Versão inicial publicada.
