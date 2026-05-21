import { parseApiKey, verifyApiKey } from '@payunivercart/connect';
import { schema } from '@payunivercart/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppServices } from '../services';

/**
 * Bearer-token auth for Univercart Connect partner endpoints.
 *
 * The header is `Authorization: Bearer sk_<test|live>_<body>`. We
 * parse mode+kind from the prefix, look up the matching row in
 * `partner_api_keys` by `prefix` (indexed unique), then bcrypt-verify
 * the full cleartext against the stored hash.
 *
 * On success we attach the partner + key to `c.get('connect')` so
 * downstream handlers can scope queries by `partnerId` and the route's
 * declared `mode` (live keys can't touch test data, vice versa).
 */

export interface ConnectAuthContext {
  partnerId: string;
  partnerSlug: string;
  partnerName: string;
  jwtSigningSecret: string;
  apiKeyId: string;
  mode: 'test' | 'live';
}

declare module 'hono' {
  interface ContextVariableMap {
    connect: ConnectAuthContext;
  }
}

export function partnerAuth(services: AppServices): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      return unauthorized(c, 'missing_api_key', 'Authorization: Bearer header required.');
    }
    const cleartext = header.slice(7).trim();
    const parsed = parseApiKey(cleartext);
    if (!parsed || parsed.kind !== 'secret') {
      return unauthorized(c, 'invalid_api_key', 'Only sk_* keys are accepted on this endpoint.');
    }
    const prefix = cleartext.slice(0, 12);

    const [row] = await services.db.db
      .select({
        keyId: schema.partnerApiKeys.id,
        hash: schema.partnerApiKeys.hash,
        partnerId: schema.partnerApiKeys.partnerId,
        partnerSlug: schema.partnerAccounts.slug,
        partnerName: schema.partnerAccounts.name,
        partnerStatus: schema.partnerAccounts.status,
        jwtSigningSecret: schema.partnerAccounts.jwtSigningSecret,
      })
      .from(schema.partnerApiKeys)
      .innerJoin(
        schema.partnerAccounts,
        eq(schema.partnerAccounts.id, schema.partnerApiKeys.partnerId),
      )
      .where(and(eq(schema.partnerApiKeys.prefix, prefix), isNull(schema.partnerApiKeys.revokedAt)))
      .limit(1);

    if (!row) {
      return unauthorized(c, 'invalid_api_key', 'API key not recognised or revoked.');
    }
    if (row.partnerStatus === 'suspended') {
      return unauthorized(c, 'partner_suspended', 'Partner account is suspended.');
    }

    const ok = verifyApiKey(cleartext, row.hash, { kind: 'secret', mode: parsed.mode });
    if (!ok) {
      return unauthorized(c, 'invalid_api_key', 'API key not recognised or revoked.');
    }

    // Fire-and-forget last_used touch — no need to block the request.
    void services.db.db
      .update(schema.partnerApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.partnerApiKeys.id, row.keyId))
      .catch(() => {
        /* swallow — telemetry, not auth */
      });

    c.set('connect', {
      partnerId: row.partnerId,
      partnerSlug: row.partnerSlug,
      partnerName: row.partnerName,
      jwtSigningSecret: row.jwtSigningSecret,
      apiKeyId: row.keyId,
      mode: parsed.mode,
    });

    await next();
    // Return undefined explicitly so TS sees a path on every branch.
    return undefined;
  };
}

function unauthorized(c: Context, code: string, message: string) {
  return c.json(
    {
      error: {
        code,
        message,
        request_id: c.req.header('x-request-id') ?? null,
      },
    },
    401,
  );
}
