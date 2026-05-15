import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { loadEnv } from './env.js';
import { appRouter } from './routers/index.js';
import { buildServices } from './services.js';
import type { TrpcContext } from './trpc.js';

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

app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    // The Hono adapter types `createContext` as `Record<string, unknown>`;
    // we shape the actual `TrpcContext` and cast at the boundary. The
    // procedure-level `ctx` typing is enforced by `initTRPC.context<>()`.
    createContext: (_opts, c) =>
      ({
        services,
        honoCtx: c,
        // TODO: wire Better-Auth session resolution + workspace header parsing
        // when the auth package lands. Both stay null until then.
        workspaceId: c.req.header('x-workspace-id') ?? null,
        userId: null,
      }) satisfies TrpcContext as unknown as Record<string, unknown>,
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
