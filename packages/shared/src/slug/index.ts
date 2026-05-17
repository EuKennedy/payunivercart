/**
 * URL-safe slug helpers. Pure functions, no DB / no IO.
 *
 * Used at signup time to mint the `organizations.slug` value from the
 * producer's email local-part, plus a random 4-hex suffix to keep slugs
 * unique without coordination. The unique index on `organizations.slug`
 * is the source of truth — collisions are surfaced as `23505` and the
 * caller retries with a fresh suffix.
 */

const NON_URL_SAFE = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_DASHES = /^-+|-+$/g;

/**
 * Normalize an email local-part into a URL-safe slug fragment.
 *
 *   "Diego Rodrigues" → "diego-rodrigues"
 *   "kennedy_R+2026"  → "kennedy-r-2026"
 *   "@@@@"            → "user"  (last-resort fallback)
 *
 * Capped at 32 chars so the final slug (with a 4-hex suffix) stays well
 * under DNS-label limits if it ever gets surfaced in a hostname.
 */
export function slugifyEmailLocalPart(email: string): string {
  const local = (email.split('@')[0] ?? 'user').toLowerCase();
  const cleaned = local.replace(NON_URL_SAFE, '-').replace(LEADING_OR_TRAILING_DASHES, '').slice(0, 32);
  return cleaned.length > 0 ? cleaned : 'user';
}

/**
 * 4 hexadecimal characters drawn from `crypto.randomUUID()`. The 65,536
 * suffix space combined with the email-local-part scope makes the
 * single-retry strategy (one collision is already a 1-in-65k event)
 * effectively bulletproof for the foreseeable user count.
 */
export function randomSlugSuffix(): string {
  // `globalThis.crypto.randomUUID()` is available on Node 19+ and every
  // modern browser. No `node:crypto` import — keeps this module isomorphic.
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
}

/**
 * Mint a candidate organization slug. The caller is responsible for
 * persisting and retrying on unique-violation.
 */
export function mintOrganizationSlug(email: string): string {
  return `${slugifyEmailLocalPart(email)}-${randomSlugSuffix()}`;
}
