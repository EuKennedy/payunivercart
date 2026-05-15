/**
 * Lightweight Result type for explicit error handling in payment flows where
 * thrown exceptions would mask root causes (gateway failures, invalid credentials).
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Wrap a promise into a `Result`. `mapError` is REQUIRED — the previous
 * default fell back to a double-cast (`e as unknown as E`) that lied to
 * the type system and silently lost the original error's structure. The
 * caller now declares exactly how a thrown value becomes its domain
 * error, which keeps `Result<T, E>` honest at every call site.
 *
 * For the common "just give me an Error" use case, pass `toError` (below)
 * explicitly:
 *
 *   const r = await fromPromise(saveOrder(), toError);
 */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(mapError(cause));
  }
}

/**
 * Helper for the common case where the caller wants to keep the
 * caught value as an `Error` instance, wrapping non-Error throws.
 *
 *   const r = await fromPromise(saveOrder(), toError);
 */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
