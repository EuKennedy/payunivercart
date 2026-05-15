# Deploy — Coolify on VPS

Target: `pay.univercart.com` running on a Coolify-managed VPS.

## Local boot (verify before pushing)

```bash
# 1. Create .env with real values
cp .env.example .env
# Replace every __REPLACE_ME__ marker — the api refuses to boot otherwise.

# Generate the secrets:
echo "AUTH_SECRET=$(openssl rand -hex 32)"            >> .env  # ≥64 hex chars
echo "WAHA_WEBHOOK_SECRET=$(openssl rand -hex 32)"    >> .env

# 32-byte KEKs (one each, base64-encoded):
ENC_KEY=$(openssl rand -base64 32)
AUD_KEY=$(openssl rand -base64 32)
echo "ENCRYPTION_KEYS=v1:${ENC_KEY}"                  >> .env
echo "AUDIT_KEYS=v1:${AUD_KEY}"                       >> .env

# 2. Bring up the full stack
pnpm docker:up

# 3. Watch the boot
pnpm docker:logs

# 4. Smoke test
curl -fsS http://localhost/health
# => {"status":"ok","uptimeSeconds":...}

# 5. tRPC health (envelope shape)
curl -fsS 'http://localhost/trpc/health.live'
```

The `migrate` service runs once and exits — it applies:

1. The Drizzle-generated SQL (`packages/db/drizzle/0000_init.sql`).
2. `packages/db/sql/02_rls_policies.sql` (RLS).
3. `packages/audit/sql/01_lockdown.sql` (append-only triggers).

After it exits successfully, `api` starts.

## Coolify deploy

1. **Create the project** in Coolify pointing at
   `https://github.com/EuKennedy/payunivercart` (branch `main`).
2. **Build pack:** Docker Compose.
3. **Compose file:** `docker/docker-compose.yml`.
4. **Secrets:** add every env var from `.env.example` in Coolify's
   secrets UI. None of them may contain `__REPLACE_ME__`.
5. **Domain:** point `pay.univercart.com` at the Coolify host; Coolify
   issues the Let's Encrypt cert automatically. The nginx service
   inside the compose listens on port 80 — Coolify's outer proxy
   terminates TLS.
6. **Deploy.** Coolify pulls, builds, runs the migrate service, starts
   api + waha + postgres + redis + nginx. `nginx` only publishes port
   80 internally; Coolify's edge proxy is what is reachable from the
   internet.
7. **Smoke test:**
   ```bash
   curl -fsS https://pay.univercart.com/health
   ```

## Provision the three Postgres roles (one-time, after first migrate)

```bash
docker compose -f docker/docker-compose.yml exec postgres \
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

After roles exist, switch the api's `DATABASE_URL` to use
`payunivercart_app` (no BYPASSRLS) and restart the service.

## Rollback

Coolify keeps the previous image. If a deploy goes bad:
1. Coolify dashboard → Deployments → "Redeploy" the previous build.
2. If the schema changed irrevocably and rolling forward is faster, fix
   on `main` and let CI + Coolify ship.

There is no automatic schema rollback — Drizzle migrations are
forward-only. Always test on a staging branch first when the migration
touches existing tables.

## Pending pieces (will land in later blocks)

- `apps/dashboard`, `apps/checkout`, `apps/admin`, `apps/workers` — not
  yet in `docker-compose.yml`. Add the same `build` block + healthcheck
  pattern when they ship.
- Real Stripe / MP / Pagar.me / PagSeguro HTTP integration in the
  payment adapters (MP / Pagar.me / PagSeguro currently throw 501).
- Better-Auth wiring + OTP via WAHA.
- Sentry + PostHog wiring.
