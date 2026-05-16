export { canonicalize } from './canonical';
export { AuditError, type AuditErrorCode } from './errors';
export { computeChainHash, hashesEqual } from './hash';
export type { AuditPort, AuditRow, AuditRowInsert, AuditTx } from './port';
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
} from './service';
