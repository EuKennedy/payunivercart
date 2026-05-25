import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import { schema } from '@payunivercart/db';
import * as Sentry from '@sentry/node';
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { recordClick } from './affiliates/tracker';
import { mountConnectApi } from './connect/router';
import { loadEnv } from './env';
import { authRateLimit, checkoutRateLimit, webhookRateLimit } from './rate-limit';
import { appRouter } from './routers/index';
import { buildServices } from './services';
import type { TrpcContext } from './trpc';
import { mountGatewayWebhooks } from './webhooks/gateways';
import { mountWahaWebhook } from './webhooks/waha';
import { listOrProvisionMemberships } from './workspace-lookup';

/**
 * Hono entry point. Boot order:
 *   1. Load + validate env (`loadEnv` exits the process on failure).
 *   2. Build process-wide services (DB, crypto, WAHA).
 *   3. Mount middleware: secure headers → CORS → logger.
 *   4. Mount health HTTP endpoint (no tRPC overhead — used by k8s/coolify).
 *   5. Mount tRPC on /trpc/* using the @hono/trpc-server adapter.
 *   6. Listen.
 */

const env = loadEnv();

// Initialise Sentry before any service builds so anything that throws
// during boot also reports. No-op when `SENTRY_DSN` is empty — keeps
// local + sandbox deploys silent without the SDK complaining.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    environment: env.NODE_ENV,
    serverName: 'payunivercart-api',
    // Keep tracing off by default. We're optimising for crash visibility
    // first; performance + replay can light up when we wire pino +
    // workspace-level metrics in the same block.
    tracesSampleRate: 0,
    // Drop tRPC's input from breadcrumbs — buyer PII (CPF, phone) on
    // checkout endpoints must not leak into the Sentry UI.
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
        if (breadcrumb.data && 'input' in breadcrumb.data) {
          breadcrumb.data.input = undefined;
        }
      }
      return breadcrumb;
    },
  });
}

const services = buildServices(env);

const app = new Hono();

app.use(
  '*',
  secureHeaders({
    // CSP defaults; tightened per app when the dashboard/checkout serve from
    // the same origin. The API itself only emits JSON; default-src 'none'
    // is correct.
    contentSecurityPolicy: { defaultSrc: ["'none'"] },
    // HSTS only in production (local dev runs on http://).
    strictTransportSecurity:
      env.NODE_ENV === 'production' ? 'max-age=63072000; includeSubDomains; preload' : false,
    // The `/img/*` endpoints intentionally serve PNG/JPEG/WEBP to the
    // dashboard (`app.univercart.com`) and the public checkout
    // (`pay.univercart.com`) — both are different origins from the api
    // host. Hono's secureHeaders default `crossOriginResourcePolicy:
    // 'same-origin'` lets `fetch()` succeed (it doesn't enforce CORP)
    // but blocks `<img src=...>` embedding cross-origin, which is why
    // bytes were arriving but the browser refused to decode them.
    // Setting `cross-origin` re-enables `<img>` embedding for every
    // route; the only binary response we expose is `/img/*` which is
    // already public by design (UUID-keyed, no auth).
    crossOriginResourcePolicy: 'cross-origin',
  }),
);

app.use(
  '*',
  cors({
    origin: env.AUTH_TRUSTED_ORIGINS,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
  }),
);

if (env.NODE_ENV !== 'production') {
  app.use('*', logger());
}

/**
 * Plain HTTP health check. The orchestrator (Coolify) polls this with no
 * Accept/Authorization headers; we avoid the tRPC envelope.
 */
app.get('/health', (c) => c.json({ status: 'ok', uptimeSeconds: process.uptime() }));

/**
 * Public affiliate-link landing. The buyer clicks
 * `https://api.univercart.com/a/<slug>` (or wherever this host is
 * exposed); we record the click, drop a 1st-party cookie so the
 * checkout's `createOrder` can resolve attribution later, and 302 to
 * the product checkout (or platform home when the link is
 * workspace-wide).
 *
 * No rate-limit middleware applied — captured separately by the
 * webhook tier above (this path is /a/, not /webhooks/). Bots can spam
 * but the dedupe in `recordClick` collapses same-day same-IP hits to
 * one row.
 */
app.get('/a/:slug', async (c) => {
  const slug = c.req.param('slug');
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip')?.trim() ??
    'unknown';
  const result = await recordClick({
    services,
    slug,
    ip,
    fingerprint: c.req.header('x-fingerprint') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    referrer: c.req.header('referer') ?? null,
    country: c.req.header('cf-ipcountry') ?? null,
    // Audit HMAC keys are guaranteed present (env validator); reuse
    // the first as the IP-hash salt so we don't add yet another
    // secret to .env.
    saltSecret: env.AUDIT_KEYS.split(',')[0]?.split(':')[1] ?? env.AUTH_SECRET,
  });
  if (!result) {
    // Unknown slug, expired link, or program off. Redirect to platform
    // home so the buyer isn't dead-ended.
    const fallback = env.CHECKOUT_PUBLIC_URL ?? 'https://pay.univercart.com';
    return c.redirect(fallback, 302);
  }
  // 1st-party cookie. Max-Age = attribution window so the cookie expires
  // exactly when the producer's window would. SameSite=Lax = follows the
  // buyer when they click through to the checkout subdomain.
  c.header(
    'Set-Cookie',
    `payuniv_aff=${encodeURIComponent(result.cookieSlug)}; Path=/; Max-Age=${result.windowDays * 24 * 60 * 60}; SameSite=Lax; Secure; HttpOnly=false`,
  );
  return c.redirect(result.redirectTo, 302);
});

// Rate-limit sensitive surfaces. Order matters: middleware mounted
// before the handler short-circuits the request once the cap is hit.
//   - auth      : credential stuffing, OTP spam, signup enumeration
//   - webhooks  : misbehaving gateway retrying every second
//   - checkout  : bot mass-creating pending_payment rows / Pix QRs
// Other tRPC procedures (workspaceProcedure) are auth-scoped so the
// abuse surface is bounded by the session; we add per-user limits
// later if needed.
app.use('/api/auth/*', authRateLimit(env.REDIS_URL));
app.use('/webhooks/*', webhookRateLimit(env.REDIS_URL));
app.use('/trpc/checkout.*', checkoutRateLimit(env.REDIS_URL));

// Better-Auth handler. Mounted under `/api/auth/*` so the Better-Auth
// browser client's default `baseURL` resolves without remapping. All
// sign-in, sign-up, OTP, and session endpoints live here.
app.all('/api/auth/*', (c) => services.auth.handler(c.req.raw));

/**
 * Plain HTTP membership probe — used by the dashboard's `(app)` layout
 * RSC to gate access without going through the tRPC URL-encoding
 * dance. Returns 401 when the session cookie is missing/invalid, 403
 * when the user has no memberships (shouldn't happen post-Block-19),
 * 200 with the active workspace + role otherwise.
 */
app.get('/me/workspace', async (c) => {
  const session = await services.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  const rows = await listOrProvisionMemberships(services.db.db, session.user.id);
  if (rows.length === 0) {
    return c.json({ error: 'no_workspace' }, 403);
  }
  const headerWs = c.req.header('x-workspace-id') ?? null;
  const selected = headerWs ? rows.find((r) => r.workspaceId === headerWs) : rows[0];
  if (!selected) {
    return c.json({ error: 'not_a_member' }, 403);
  }
  return c.json({
    workspaceId: selected.workspaceId,
    name: selected.name,
    slug: selected.slug,
    role: selected.role,
  });
});

/**
 * Public binary endpoints for branding + product cover. UUID-keyed so
 * enumeration is infeasible; no auth because the checkout (and any
 * shared link) needs to render the image without a session. We send a
 * conservative Cache-Control: a stale logo for 5 minutes is fine, and
 * the producer flushes by re-uploading (which the dashboard can do via
 * `updateBranding` / `products.update`).
 */
function bytesToImageResponse(bytes: Uint8Array, mime: string): Response {
  // Drizzle hands the bytea back as a Uint8Array (or Node Buffer)
  // which IS a typed-array view. Passing the view directly to
  // `new Response(...)` worked under @hono/node-server in some
  // versions but broke after the runtime upgrade — the browser
  // received zero bytes. Slicing into a fresh, offset-zero
  // ArrayBuffer is the safe path that works across every fetch
  // backend we can plausibly land on.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(ab, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=300',
      // Browsers don't enforce CORS on plain <img>, but a permissive
      // header lets a future `<canvas>` pipeline (e.g., admin avatar
      // crop) consume the bytes without a separate proxy.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
app.get('/img/workspace/:id/logo', async (c) => {
  const id = c.req.param('id');
  // Validate id shape so a bogus path doesn't hit Postgres with a
  // string Drizzle would refuse anyway.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.notFound();
  }
  const [row] = await services.db.db
    .select({
      logo: schema.workspaces.brandLogo,
      mime: schema.workspaces.brandLogoMime,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, id))
    .limit(1);
  if (!row?.logo || !row.mime) return c.notFound();
  return bytesToImageResponse(row.logo, row.mime);
});

app.get('/img/product/:id/cover', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.notFound();
  }
  const [row] = await services.db.db
    .select({
      cover: schema.products.coverImage,
      mime: schema.products.coverImageMime,
    })
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .limit(1);
  if (!row?.cover || !row.mime) return c.notFound();
  return bytesToImageResponse(row.cover, row.mime);
});

mountWahaWebhook(app, services);
mountGatewayWebhooks(app, services);
mountConnectApi(app, services);

app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    // The Hono adapter types `createContext` as `Record<string, unknown>`;
    // we shape the actual `TrpcContext` and cast at the boundary. The
    // procedure-level `ctx` typing is enforced by `initTRPC.context<>()`.
    createContext: async (_opts, c) => {
      // Resolve the current Better-Auth session from cookies. The auth
      // handler reads the same cookie the dashboard set; null when
      // unauthenticated. tRPC procedures decide whether to enforce
      // (see `authedProcedure` / `workspaceProcedure` in `trpc.ts`).
      //
      // `workspaceId` and `role` are left null here; `workspaceProcedure`
      // populates them from the user's memberships once it asserts the
      // session. Procedures that don't need a tenant (health, workspace
      // discovery) skip the lookup entirely.
      const session = await services.auth.api.getSession({
        headers: c.req.raw.headers,
      });
      return {
        services,
        honoCtx: c,
        workspaceId: null,
        role: null,
        userId: session?.user?.id ?? null,
      } satisfies TrpcContext as unknown as Record<string, unknown>;
    },
  }),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Boot log is intentionally structured. We use `process.stdout.write`
// instead of `console.log` so the workspace lint rule (`noConsole`)
// doesn't flag it — request-path logging will come from a real logger
// (pino) when `apps/api` grows beyond the smoke-test footprint.
process.stdout.write(
  `${JSON.stringify({ level: 'info', event: 'api.boot', port: env.PORT, nodeEnv: env.NODE_ENV })}\n`,
);

serve({ fetch: app.fetch, port: env.PORT });
