/**
 * Domain-level error taxonomy. Every error thrown across the platform should
 * extend `PayunivercartError` so the API layer can translate them into stable
 * HTTP/tRPC responses and audit logs.
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'RATE_LIMITED'
  | 'GATEWAY_ERROR'
  | 'GATEWAY_INVALID_CREDENTIALS'
  | 'GATEWAY_UNAVAILABLE'
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_DUPLICATE'
  | 'PHONE_INVALID'
  | 'INTERNAL';

export interface PayunivercartErrorOptions {
  code: ErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
  httpStatus?: number;
}

export class PayunivercartError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(options: PayunivercartErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'PayunivercartError';
    this.code = options.code;
    if (options.details) this.details = options.details;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(options.code);
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'VALIDATION':
    case 'PHONE_INVALID':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'WEBHOOK_INVALID_SIGNATURE':
    case 'WEBHOOK_DUPLICATE':
      return 400;
    case 'GATEWAY_INVALID_CREDENTIALS':
      return 400;
    case 'GATEWAY_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}
