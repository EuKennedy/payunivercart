# Deploy — Coolify on VPS

Target: `pay.univercart.com` running on a Coolify-managed VPS.

## Stack overview

Eight services boot from `docker-compose.yml`:

| Service     | Port (internal) | Purpose |
|-------------|-----------------|---------|
| `postgres`  | 5432            | Primary database (Postgres 17). |
| `redis`     | 6379            | BullMQ queues + caches. |
| `migrate`   | one-shot        | Runs Drizzle migrations + RLS + audit lockdown then exits. |
| `api`       | 4000            | Hono + tRPC backend, Better-Auth, webhook receivers. |
| `dashboard` | 3000            | Next.js producer dashboard. |
| `checkout`  | 3001            | Next.js public checkout. |
| `admin`     | 3002            | Next.js super-admin (operator only — gate by IP allowlist). |
| `workers`   | (no port)       | BullMQ processors (webhooks, recovery, audit verify). |
| `nginx`     | 80              | Reverse proxy; routes hosts to the matching service. |
| `waha`      | (profile only)  | Local WAHA, only when `--profile local-waha` is on. |

## Local boot

```bash
# 1. Create .env with real values
cp .env.example .env
# Replace every __REPLACE_ME__ marker — every service refuses to start
# while the sentinel is present.

# 2. Generate secrets (run on the VPS over SSH — keep secrets off
#    development machines):
openssl rand -hex 32       # AUTH_SECRET, WAHA_WEBHOOK_SECRET
openssl rand -base64 32    # ENCRYPTION_KEYS value, AUDIT_KEYS value

# 3. Bring up the stack
pnpm docker:up

# 4. Watch the boot
pnpm docker:logs

# 5. Smoke
curl -fsS http://localhost/health
# => {"status":"ok","uptimeSeconds":...}

# 6. tRPC envelope
curl -fsS 'http://localhost/trpc/health.live'
```

The `migrate` service runs once and exits — it applies:
1. `packages/db/drizzle/0000_init.sql`
2. `packages/db/sql/02_rls_policies.sql` (RLS)
3. `packages/audit/sql/01_lockdown.sql` (append-only triggers)

After it exits successfully, every other service starts.

## Coolify deploy

1. **Create the project** in Coolify pointing at
   `https://github.com/EuKennedy/payunivercart` (branch `main`).
2. **Build pack:** Docker Compose.
3. **Compose file:** `docker-compose.yml`.
4. **Secrets:** add every env var from `.env.example` in Coolify's
   secrets UI. None of them may contain `__REPLACE_ME__`.
5. **Domains** — point each subdomain at this VPS in DNS, then add
   them in Coolify's project domains:
   - `pay.univercart.com` → `dashboard` (port 3000)
   - `checkout.univercart.com` → `checkout` (port 3001)
   - `admin.univercart.com` → `admin` (port 3002, with an IP allowlist!)
   Coolify issues a Let's Encrypt cert per domain. The internal nginx
   handles the `/api/`, `/trpc/`, `/webhooks/` paths regardless of which
   subdomain hits it.
6. **Deploy.** Coolify pulls, builds, runs the migrate one-shot, starts
   the long-lived services. The first boot takes ~5 min because all
   four Next.js apps build from scratch; subsequent deploys hit the
   build cache.
7. **Smoke test:**
   ```bash
   curl -fsS https://pay.univercart.com/health
   ```

## Postgres roles (one-time, after first migrate)

```bash
docker compose exec postgres \
  psql -U payunivercart -d payunivercart <<'SQL'
CREATE ROLE payunivercart_app    LOGIN PASSWORD :'app_pwd';
CREATE ROLE payunivercart_worker LOGIN PASSWORD :'worker_pwd' BYPASSRLS;

GRANT CONNECT ON DATABASE payunivercart TO payunivercart_app, payunivercart_worker;
GRANT USAGE   ON SCHEMA   public        TO payunivercart_app, payunivercart_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;
GRANT EXECUTE ON FUNCTION public.current_workspace_id()
  TO payunivercart_app, payunivercart_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO payunivercart_app, payunivercart_worker;
SQL
```

After roles exist, switch `DATABASE_URL` (for `api`, `dashboard`,
`checkout`, `admin`) to `payunivercart_app` (no BYPASSRLS) and
`workers`' `DATABASE_URL` to `payunivercart_worker`, then redeploy.

## Rollback

Coolify keeps the previous image. If a deploy goes bad:
1. Coolify dashboard → Deployments → "Redeploy" the previous build.
2. If the schema changed irrevocably and rolling forward is faster, fix
   on `main` and let CI + Coolify ship.

There is no automatic schema rollback — Drizzle migrations are
forward-only. Always test on a staging branch first when the migration
touches existing tables.

## Pending pieces (will land in later blocks)

- Real cart-recovery handler logic in `apps/workers/src/processors.ts`.
- Audit verifier Drizzle port + alert sink.
- Producer-facing webhook outbox dispatcher (signs + retries).
- Stripe-USD checkout path in `apps/checkout`.
- Sentry + PostHog wiring.
