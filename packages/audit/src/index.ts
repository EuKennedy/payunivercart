export { canonicalize } from './canonical.js';
export { AuditError, type AuditErrorCode } from './errors.js';
export { computeChainHash, hashesEqual } from './hash.js';
export type { AuditPort, AuditRow, AuditRowInsert, AuditTx } from './port.js';
export {
  type AppendInput,
  type AppendResult,
  AuditService,
  type AuditServiceConfig,
  type AuditPayloadForHash,
  type VerifyFail,
  type VerifyOk,
  type VerifyOptions,
  type VerifyReport,
} from './service.js';
