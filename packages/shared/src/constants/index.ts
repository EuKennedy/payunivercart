export const PLATFORM_NAME = 'payunivercart' as const;

export const SUPPORTED_LOCALES = ['pt-BR', 'en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

export const GATEWAY_IDS = ['mercadopago', 'pagarme', 'pagseguro', 'stripe'] as const;
export type GatewayId = (typeof GATEWAY_IDS)[number];

export const PAYMENT_METHODS = ['pix', 'credit_card', 'boleto', 'stripe_card_usd'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const TRANSACTION_STATUSES = [
  'pending',
  'processing',
  'authorized',
  'paid',
  'refunded',
  'partially_refunded',
  'chargedback',
  'failed',
  'cancelled',
  'expired',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const WORKSPACE_MONTHLY_PRICE_BRL = 99.9 as const;

export const OTP_TTL_SECONDS = 300;
export const OTP_LENGTH = 6;
export const OTP_CHANNELS = ['whatsapp', 'email'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

export const WEBHOOK_OUTBOX_MAX_ATTEMPTS = 12;
