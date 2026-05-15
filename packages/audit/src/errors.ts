import { PayunivercartError } from '@payunivercart/shared';

export type AuditErrorCode =
  | 'CANONICAL_UNSUPPORTED_VALUE'
  | 'CANONICAL_CYCLE'
  | 'CHAIN_HASH_MISMATCH'
  | 'CHAIN_PREVIOUS_HASH_MISMATCH'
  | 'CHAIN_GENESIS_VIOLATION'
  | 'CHAIN_EMPTY_AFTER_BOOT'
  | 'KEY_WRONG_LENGTH'
  | 'INVALID_INPUT';

export class AuditError extends PayunivercartError {
  readonly auditCode: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string, details?: Record<string, unknown>) {
    super({
      code: 'INTERNAL',
      message,
      details: { auditCode: code, ...(details ?? {}) },
    });
    this.name = 'AuditError';
    this.auditCode = code;
  }
}
