import type { GatewayId, Money, PaymentMethod, TransactionStatus } from '@payunivercart/shared';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Common types                                                              */
/* -------------------------------------------------------------------------- */

export interface CustomerInfo {
  name: string;
  email: string;
  document: string;
  phoneE164: string;
  ipAddress?: string;
}

export interface BillingAddress {
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface CardToken {
  /** Gateway-issued single-use token from the browser SDK. */
  token: string;
  /** Optional saved card if the producer opted into card-on-file. */
  customerId?: string;
  cardId?: string;
  /** Holder name as printed on the card. */
  holderName: string;
}

export interface CreatePixInput {
  workspaceId: string;
  orderId: string;
  amount: Money;
  customer: CustomerInfo;
  description?: string;
  expiresInSeconds?: number;
  metadata?: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

export interface CreateCardInput {
  workspaceId: string;
  orderId: string;
  amount: Money;
  customer: CustomerInfo;
  card: CardToken;
  installments: number;
  description?: string;
  billingAddress?: BillingAddress;
  metadata?: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

export interface CreateBoletoInput {
  workspaceId: string;
  orderId: string;
  amount: Money;
  customer: CustomerInfo;
  billingAddress: BillingAddress;
  description?: string;
  dueDate: Date;
  metadata?: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

export interface RefundInput {
  transactionId: string;
  gatewayChargeId: string;
  /** Omit for full refund. */
  amount?: Money;
  reason?: string;
  idempotencyKey: string;
}

export interface PaymentResult {
  gatewayId: GatewayId;
  gatewayChargeId: string;
  gatewayRequestId?: string;
  status: TransactionStatus;
  method: PaymentMethod;
  amount: Money;
  /** Pix-specific. */
  pixQrCode?: string;
  pixQrCodeImage?: string;
  pixCopyPaste?: string;
  pixExpiresAt?: Date;
  /** Boleto-specific. */
  boletoUrl?: string;
  boletoBarcode?: string;
  boletoDueDate?: Date;
  /** Card-specific. */
  cardBrand?: string;
  cardLast4?: string;
  cardThreeDsRedirectUrl?: string;
  /** Raw gateway payload for audit/debugging. */
  raw: unknown;
}

export interface RefundResult {
  gatewayRefundId: string;
  status: TransactionStatus;
  amount: Money;
  raw: unknown;
}

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

export interface WebhookEvent {
  gatewayId: GatewayId;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  /** The id of the charge/payment/order the event refers to. */
  resourceId: string;
  raw: unknown;
}

/* -------------------------------------------------------------------------- */
/*  Credentials                                                               */
/* -------------------------------------------------------------------------- */

export const mercadoPagoCredentialsSchema = z
  .object({
    accessToken: z.string().min(8),
    publicKey: z.string().min(8),
    webhookSecret: z.string().min(8).optional(),
    isSandbox: z.boolean().default(false),
  })
  .strict();
export type MercadoPagoCredentials = z.infer<typeof mercadoPagoCredentialsSchema>;

export const pagarmeCredentialsSchema = z
  .object({
    secretKey: z.string().min(8),
    publicKey: z.string().min(8),
    webhookEndpointSecret: z.string().min(8).optional(),
    isSandbox: z.boolean().default(false),
  })
  .strict();
export type PagarmeCredentials = z.infer<typeof pagarmeCredentialsSchema>;

export const pagSeguroCredentialsSchema = z
  .object({
    bearerToken: z.string().min(8),
    publicKey: z.string().min(8).optional(),
    webhookToken: z.string().min(8).optional(),
    isSandbox: z.boolean().default(false),
  })
  .strict();
export type PagSeguroCredentials = z.infer<typeof pagSeguroCredentialsSchema>;

export const stripeCredentialsSchema = z
  .object({
    secretKey: z.string().min(8),
    publishableKey: z.string().min(8),
    webhookSecret: z.string().min(8).optional(),
    isSandbox: z.boolean().default(false),
  })
  .strict();
export type StripeCredentials = z.infer<typeof stripeCredentialsSchema>;

/* -------------------------------------------------------------------------- */
/*  Gateway contract                                                          */
/* -------------------------------------------------------------------------- */

export interface PaymentGateway<TCredentials = unknown> {
  readonly id: GatewayId;
  parseCredentials(input: unknown): TCredentials;
  validateCredentials(credentials: TCredentials): Promise<void>;
  createPix?(credentials: TCredentials, input: CreatePixInput): Promise<PaymentResult>;
  createCard?(credentials: TCredentials, input: CreateCardInput): Promise<PaymentResult>;
  createBoleto?(credentials: TCredentials, input: CreateBoletoInput): Promise<PaymentResult>;
  refund(credentials: TCredentials, input: RefundInput): Promise<RefundResult>;
  getCharge(credentials: TCredentials, chargeId: string): Promise<PaymentResult>;
  verifyWebhook(credentials: TCredentials, request: WebhookRequest): WebhookEvent;
}
