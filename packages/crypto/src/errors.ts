import { PayunivercartError } from '@payunivercart/shared';

/**
 * All crypto package errors are `PayunivercartError` instances with a
 * `details.cryptoCode` that downstream code (audit log, observability) can
 * filter on without parsing message strings.
 */
export type CryptoErrorCode =
  | 'BLOB_TOO_SHORT'
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'BAD_KEY_ID'
  | 'KEY_NOT_FOUND'
  | 'KEY_WRONG_LENGTH'
  | 'DECRYPT_FAILED'
  | 'PLAINTEXT_TOO_LARGE'
  | 'ENV_MALFORMED';

export class CryptoError extends PayunivercartError {
  readonly cryptoCode: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, cause?: unknown) {
    super({
      code: 'INTERNAL',
      message,
      cause,
      details: { cryptoCode: code },
    });
    this.name = 'CryptoError';
    this.cryptoCode = code;
  }
}
