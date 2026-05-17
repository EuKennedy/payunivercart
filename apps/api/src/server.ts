import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { loadEnv } from './env';
import { appRouter } from './routers/index';
import { buildServices } from './services';
import type { TrpcContext } from './trpc';
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

mountWahaWebhook(app, services);

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
