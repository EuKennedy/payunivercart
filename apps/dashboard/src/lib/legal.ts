/**
 * Univercart — versionamento dos documentos legais.
 *
 * Quando um documento muda materialmente (não só ortografia), bumpe a
 * versão aqui. O banner de re-aceite usa o valor pra detectar usuários
 * com `acceptedTermsVersion`/`acceptedPrivacyVersion` desatualizada e
 * pede aceite explícito antes de liberar o app.
 *
 * Formato da versão: `YYYY-MM-DD`. Um deploy por dia (no máximo) muda
 * a versão — basta refletir o dia que o texto novo entrou em vigor.
 *
 * Mudanças cosméticas (typo, formatação) NÃO bumpam — o aceite anterior
 * continua válido, sem incomodar o usuário.
 */

export const LEGAL_VERSIONS = {
  terms: '2026-05-28',
  privacy: '2026-05-28',
} as const;

export const TERMS_CHANGELOG = [
  {
    version: '2026-05-28',
    date: '2026-05-28',
    highlights: ['Versão inicial publicada.'],
  },
] as const;

export const PRIVACY_CHANGELOG = [
  {
    version: '2026-05-28',
    date: '2026-05-28',
    highlights: ['Versão inicial publicada.'],
  },
] as const;

/**
 * Operadores (sub-processadores) atuais. Exposto no `/privacidade`
 * pra cumprir Art. 6º (transparência) + Art. 18 VII (informação sobre
 * compartilhamento) da LGPD.
 *
 * Atualize a lista (e bumpe `LEGAL_VERSIONS.privacy`) sempre que
 * Univercart contratar um operador novo que processe dados pessoais.
 */
export const SUB_PROCESSORS = [
  {
    name: 'Coolify',
    purpose: 'Hospedagem das aplicações e bancos de dados',
    region: 'Brasil',
  },
  {
    name: 'Mercado Pago',
    purpose: 'Processamento de pagamentos (cartão, PIX, boleto)',
    region: 'Brasil',
  },
  {
    name: 'Resend',
    purpose: 'Envio de emails transacionais',
    region: 'Estados Unidos',
  },
  {
    name: 'WAHA (WhatsApp HTTP API)',
    purpose: 'Envio de mensagens WhatsApp',
    region: 'Brasil',
  },
  {
    name: 'Sentry',
    purpose: 'Telemetria de erros (dados pessoais são removidos antes do envio)',
    region: 'Estados Unidos',
  },
  {
    name: 'GitHub Actions',
    purpose: 'CI/CD do código-fonte',
    region: 'Estados Unidos',
  },
] as const;

export type SubProcessor = (typeof SUB_PROCESSORS)[number];
