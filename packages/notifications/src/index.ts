/**
 * Channel-agnostic transactional notification toolkit.
 *
 * Three layers:
 *
 *   1. `defaults` — hard-coded catalogue of every customisable
 *      transactional + its variable contract. Single source of truth
 *      for the editor UI, the renderer, and the per-call resolver.
 *
 *   2. `render` — pure `{var}` substitution. No DB, no IO. Trivially
 *      unit-testable.
 *
 *   3. `resolver` — DB-aware: looks up a workspace override and falls
 *      back to the default. The Email/WAHA wrappers consume this so a
 *      producer's edits land in production without any extra plumbing.
 *
 * This package owns the schema-coupled vocabulary; `@payunivercart/emails`
 * and the API webhook handlers depend on it.
 */

export * from './defaults';
export * from './render';
export * from './resolver';
