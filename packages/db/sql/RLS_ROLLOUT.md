# RLS Rollout Plan

## Current posture (production today)

- `apps/api` connects as the schema-owner Postgres role (superuser-equivalent
  for the database). `BYPASSRLS` is implicit.
- `apps/workers` connects as the same role; cross-tenant by design.
- Cross-tenant isolation is enforced **only** by defence-in-depth in
  `apps/api/src/routers/*` (every tenant query carries
  `eq(workspaceId, ctx.workspaceId)`).
- The RLS policies in `02_rls_policies.sql` + `03_rls_policies_pilars.sql`
  are **loaded but dormant** because the superuser-role bypass eats them.
- `04_roles.sql` is a one-shot that provisions the restricted runtime
  roles. It does NOT run automatically in production — the operator
  invokes it once (see Phase 1 below).

## Target posture (post-rollout)

| Role | Privileges | Used by | DATABASE_URL env |
|------|------------|---------|------------------|
| `payunivercart_owner` | Schema owner; `FORCE ROW LEVEL SECURITY`. | `drizzle-kit` migrations, never the runtime apps. | `DATABASE_URL_OWNER` (compose `migrate` service only). |
| `payunivercart_app` | `INSERT, SELECT, UPDATE, DELETE` on tenant tables. **NO `BYPASSRLS`**. | `apps/api` — every customer-facing request. Calls `withWorkspace(...)` per request. | `DATABASE_URL` of the `api` service. |
| `payunivercart_worker` | `BYPASSRLS`. | `apps/workers` — sweep jobs (recovery, outbox, tracking dispatch, marketplace rollup, PIX subscription cycle, etc.). MUST NOT serve user requests. | `DATABASE_URL` of the `workers` service. |

The dormant policies in `02_rls_policies.sql` + `03_rls_policies_pilars.sql`
become **enforced** the moment `apps/api` connects as `payunivercart_app`
(non-superuser).

## Rollout — do NOT skip steps

### Phase 0 — code already in place

Nothing to do here. These pieces shipped in previous commits:

- [x] Policies (`02_*.sql` + `03_*.sql`) loaded against staging + prod.
- [x] Role-provisioning script (`04_roles.sql`) idempotent + parameterised by
  `:app_pw` + `:worker_pw` psql variables.
- [x] Compose `migrate` service runs steps 1-5 (drizzle → policies-core →
  policies-pilars → roles → audit-lockdown) so a fresh deploy gets the
  full set.
- [x] `packages/db/scripts/rls-smoke.ts` probes the restricted role + fails
  loud on cross-tenant leak.
- [x] CI workflow `rls-smoke.yml` runs the probe against staging on cron +
  on demand.

### Phase 1 — STAGING — apply roles

1. Provision passwords for the runtime roles:
   ```sh
   ROLE_PASSWORD_APP=$(openssl rand -base64 32 | tr -d '=+/')
   ROLE_PASSWORD_WORKER=$(openssl rand -base64 32 | tr -d '=+/')
   ```
2. Inject them into the staging compose `migrate` service (env block) +
   the api / workers services' `DATABASE_URL`:
   ```
   DATABASE_URL_OWNER=postgres://payunivercart_owner:...@host/db   # migrate only
   DATABASE_URL=postgres://payunivercart_app:$ROLE_PASSWORD_APP@host/db   # api
   DATABASE_URL_WORKER=postgres://payunivercart_worker:$ROLE_PASSWORD_WORKER@host/db   # workers
   ```
3. Trigger a staging redeploy. The compose `migrate` step 4 sees both
   passwords set and runs `04_roles.sql`.
4. Verify the three roles exist:
   ```sql
   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
   WHERE rolname LIKE 'payunivercart_%';
   ```

### Phase 2 — STAGING — smoke + audit

1. **Audit every read path.** Walk `apps/api/src/routers/*` and confirm
   each tenant query either:
   - wraps in `withWorkspace(...)` (preferred), OR
   - carries an explicit `eq(table.workspaceId, ctx.workspaceId)`.
2. The marketplace `browse` + `bySlug` public procedures rely on the
   permissive policy in `03_rls_policies_pilars.sql`. Confirm those still
   return rows after the flip — they're the only public surface.
3. Run the rls-smoke probe (manual or scheduled):
   ```sh
   pnpm db rls:smoke \
     --owner "$DATABASE_URL_OWNER" \
     --app "$DATABASE_URL"
   ```
   Expected: every probe returns 0 rows for the cross-tenant case.
4. Run the full producer → buyer happy path end-to-end:
   - signup → workspace bootstrap (uses `payunivercart_worker` role)
   - configure gateway → create product → checkout PIX → webhook → paid
   - affiliate invite → click → conversion → commission row
   - tracking pixel save → event fire → dispatch ledger row
   - marketplace publish → public browse → click recorded
5. **Cross-tenant probe.** Sign in as workspace A, try to fetch workspace
   B's order id directly via tRPC. Expected: `NOT_FOUND`, never B's row.

### Phase 3 — PROD — flip

1. Provision passwords in prod the same way as Phase 1.
2. Update prod env (Coolify → service api → environment):
   ```
   DATABASE_URL=postgres://payunivercart_app:$ROLE_PASSWORD_APP@host/db
   ```
   And workers:
   ```
   DATABASE_URL=postgres://payunivercart_worker:$ROLE_PASSWORD_WORKER@host/db
   ```
3. Redeploy. Compose `migrate` step 4 provisions roles if they don't exist
   yet (idempotent).
4. Tail the api logs for the first ~5 minutes:
   ```
   docker logs -f payunivercart-api
   ```
   Watch for `permission denied for table` — that means a query used a
   path the new role isn't granted. Fix at the grant level
   (`04_roles.sql`), not by widening the role.
5. Run rls-smoke against prod (with the staging probe URL pointed at
   prod, owner role).

## Rollback

1. Flip `DATABASE_URL` back to the schema-owner role.
2. Redeploy api + workers.
3. Policies stay loaded but dormant (superuser bypass).
4. Zero data migration needed — RLS is a runtime guard, not a schema
   change.

## Why each phase exists

- Phase 1 sets up roles **without** changing app behaviour, so a typo in
  the password generator caught here doesn't take prod down.
- Phase 2's smoke probe catches the class of bug where a router was added
  AFTER the policies were written and forgot the `workspaceId` predicate.
  The new role can't read those rows, so the endpoint 500s with
  `permission denied`. Fix at the router, not by relaxing RLS.
- Phase 3 is the only step that touches prod, and it's reversible in
  under a minute.

## File map

- `02_rls_policies.sql` — core schema (workspaces, users, products, orders,
  transactions, customers, recovery, notifications).
- `03_rls_policies_pilars.sql` — Pilar 1/2/4 + subscriptions tables added
  after the core: affiliates, marketplace, tracking, subscription_plans,
  subscriptions, entitlements.
- `04_roles.sql` — role CREATE + grants + ALTER DEFAULT PRIVILEGES.
  Parameterised by `:app_pw` + `:worker_pw` psql variables (compose
  passes those from `ROLE_PASSWORD_APP` + `ROLE_PASSWORD_WORKER` env).
