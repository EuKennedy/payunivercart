import { PayunivercartError } from '@payunivercart/shared';
import type { GatewayId } from '@payunivercart/shared';

/**
 * Canonical payment failure taxonomy. Adapter implementations translate their
 * vendor codes into this set; retry policy and customer-facing copy is keyed
 * off these values, not the vendor's.
 */
export const PAYMENT_DECLINE_CODES = [
  'INSUFFICIENT_FUNDS',
  'ISSUER_DECLINED',
  'FRAUD_SUSPECTED',
  'INVALID_CARD',
  'INVALID_CVC',
  'EXPIRED_CARD',
  'THREE_DS_REQUIRED',
  'CARD_NOT_SUPPORTED',
  'PROCESSING_ERROR',
  'GATEWAY_TIMEOUT',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'INVALID_REQUEST',
  'UNSUPPORTED_CURRENCY',
  'UNKNOWN',
] as const;
export type PaymentDeclineCode = (typeof PAYMENT_DECLINE_CODES)[number];

export interface PaymentErrorDetails {
  gatewayId: GatewayId;
  declineCode: PaymentDeclineCode;
  rawCode?: string;
  rawMessage?: string;
  retryable?: boolean;
}

export class PaymentError extends PayunivercartError {
  readonly gatewayId: GatewayId;
  readonly declineCode: PaymentDeclineCode;
  readonly rawCode: string | undefined;
  readonly rawMessage: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, details: PaymentErrorDetails, cause?: unknown) {
    super({
      code: 'GATEWAY_ERROR',
      message,
      cause,
      details: { ...details },
    });
    this.name = 'PaymentError';
    this.gatewayId = details.gatewayId;
    this.declineCode = details.declineCode;
    this.rawCode = details.rawCode;
    this.rawMessage = details.rawMessage;
    this.retryable = details.retryable ?? defaultRetryable(details.declineCode);
  }
}

function defaultRetryable(code: PaymentDeclineCode): boolean {
  switch (code) {
    case 'GATEWAY_TIMEOUT':
    case 'PROCESSING_ERROR':
    case 'RATE_LIMITED':
      return true;
    default:
      return false;
  }
}
