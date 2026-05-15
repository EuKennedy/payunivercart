# `packages/db/sql/` — out-of-band Postgres migrations

These SQL files run **after** the Drizzle-generated migration that creates
the schema. They handle two things Drizzle does not express cleanly:

1. **Row-level security policies** (`02_rls_policies.sql`).
   Drizzle 0.36's `pgPolicy()` helper exists but its API has churned across
   point releases; raw SQL is auditable and version-stable. The companion
   helper in `packages/db/src/rls.ts` enforces the per-transaction
   `SET LOCAL app.workspace_id = <uuid>` contract that these policies rely
   on.

2. **Role provisioning** (this README — env-specific, not committed).
   Three roles must exist before the policies engage:

| Role | Privileges | Used by |
|------|------------|---------|
| `payunivercart_owner` | Schema owner; `FORCE ROW LEVEL SECURITY` keeps it tenant-scoped on day-to-day queries. | Migrations (run once per deploy). |
| `payunivercart_app` | `INSERT, SELECT, UPDATE, DELETE` on tenant tables. **No `BYPASSRLS`**. Every customer-facing request runs as this role. | `apps/api` worker pool. |
| `payunivercart_worker` | `BYPASSRLS`. Cross-tenant batch jobs (outbox dispatch, audit verifier, webhook tenant resolver). | `apps/workers` only — must not serve user requests. |

Provisioning template (Coolify / local docker exec):

```sql
CREATE ROLE payunivercart_owner LOGIN PASSWORD '...' CREATEDB;
CREATE ROLE payunivercart_app LOGIN PASSWORD '...';
CREATE ROLE payunivercart_worker LOGIN PASSWORD '...' BYPASSRLS;

GRANT CONNECT ON DATABASE payunivercart TO payunivercart_app, payunivercart_worker;
GRANT USAGE ON SCHEMA public TO payunivercart_app, payunivercart_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;
GRANT EXECUTE ON FUNCTION public.current_workspace_id()
  TO payunivercart_app, payunivercart_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO payunivercart_app, payunivercart_worker;

-- events_audit lockdown overrides this for UPDATE/DELETE/TRUNCATE
-- (see packages/audit/sql/01_lockdown.sql).
```

Run order
---------

1. `pnpm db:generate` — produce the first Drizzle migration from the schema.
2. `pnpm db:migrate` — apply it (creates every table).
3. `psql ... -f packages/db/sql/02_rls_policies.sql` — enable RLS.
4. `psql ... -f packages/audit/sql/01_lockdown.sql` — append-only triggers.

Steps 3 and 4 will be wired into the `pnpm db:migrate` chain when
`apps/api` lands; until then they are run manually as documented.
