import { AuditError } from './errors';

/**
 * Deterministic JSON serialization for the audit hash chain.
 *
 * `JSON.stringify` does not guarantee key ordering across runtimes (V8 has
 * a specific insertion-order behavior, but the spec leaves it free), and
 * it permits `undefined`, `NaN`, `Infinity`, and other values that would
 * silently fork the chain across implementations. The hash chain MUST be
 * a pure function of the inputs, so we hand-roll a serializer that:
 *
 *   1. Sorts object keys lexicographically (UTF-16 code-unit order).
 *   2. Rejects `undefined`, `NaN`, `Infinity`, `-Infinity`, functions,
 *      symbols, bigints — anything whose JSON image is implementation-
 *      defined or absent.
 *   3. Detects cycles and refuses to serialize them (no `[Circular]`
 *      placeholder).
 *   4. Emits no whitespace.
 *
 * The output is the canonical bytes the hash chain consumes. Two runs
 * of `canonicalize(equivalentInput)` produce byte-equal strings.
 */
export function canonicalize(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<unknown>): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);

  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new AuditError(
        'CANONICAL_UNSUPPORTED_VALUE',
        `non-finite number (${n}) cannot appear in an audit payload`,
      );
    }
    return jsonNumber(n);
  }

  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new AuditError(
      'CANONICAL_UNSUPPORTED_VALUE',
      `value of type "${type}" cannot appear in an audit payload`,
    );
  }

  if (value instanceof Date) {
    // ISO-8601 with millisecond precision, always UTC.
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw cycle();
    seen.add(value);
    const out = `[${value.map((v) => write(v, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }

  if (type === 'object') {
    if (seen.has(value)) throw cycle();
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      // Match JSON.stringify semantics: keys whose value is `undefined`
      // are skipped rather than rejected, so call sites can pass partial
      // objects (`{ foo, bar }`) without manually filtering.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${write(v, seen)}`);
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }

  // Unreachable for the standard primitives; defensive throw.
  throw new AuditError('CANONICAL_UNSUPPORTED_VALUE', `unhandled value type "${type}"`);
}

function cycle(): AuditError {
  return new AuditError('CANONICAL_CYCLE', 'audit payload contains a circular reference');
}

/**
 * Stable numeric formatting:
 *   - integers stay integers
 *   - floats use `JSON.stringify`'s default IEEE-754 shortest representation
 *   - `-0` is normalized to `0` (their hashes differ otherwise)
 */
function jsonNumber(n: number): string {
  if (Object.is(n, -0)) return '0';
  return JSON.stringify(n);
}
