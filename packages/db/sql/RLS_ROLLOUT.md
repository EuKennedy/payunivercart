# RLS Rollout Plan

Current posture (live):
- `apps/api` connects as Postgres superuser → BYPASSRLS active
- Cross-tenant isolation enforced by **defense-in-depth**: every
  router includes `eq(workspaceId, ctx.workspaceId)` on SELECTs +
  UPDATEs
- RLS policies are written + loaded but DORMANT (superuser bypass)

Target posture:
- `apps/api` connects as `payunivercart_app` (non-superuser, no
  BYPASSRLS)
- `apps/workers` connects as `payunivercart_worker` (BYPASSRLS — sweep
  jobs are intentionally cross-tenant)
- `drizzle-kit` connects as `payunivercart_owner` (schema owner)
- RLS policies enforced at the storage layer; explicit predicates
  become belt-and-suspenders

## Files

- `02_rls_policies.sql` — policies for the original schema set
  (workspaces, orders, products, transactions, …)
- `03_rls_policies_pilars.sql` — policies for Pilar 1/2/4 + subs
- `04_roles.sql` — role provisioning + grants + ALTER DEFAULT

## Rollout (do NOT skip steps)

1. **Staging only — apply roles**
   ```
   psql $DATABASE_URL_OWNER -f packages/db/sql/04_roles.sql
   psql $DATABASE_URL_OWNER -f packages/db/sql/02_rls_policies.sql
   psql $DATABASE_URL_OWNER -f packages/db/sql/03_rls_policies_pilars.sql
   ```
2. **Audit every read path** in `apps/api/src/routers/*` —
   confirm each tenant query is either:
   - wrapped in `withWorkspace(...)` (preferred), OR
   - includes an explicit `eq(table.workspaceId, ctx.workspaceId)`
   - the marketplace browse path is the only `publicProcedure` that
     reads tenant tables — its anonymous SELECT relies on the
     permissive RLS policy in `03_rls_policies_pilars.sql`
3. **Smoke test in staging** with the restricted role:
   ```
   DATABASE_URL=postgres://payunivercart_app:...
   ```
   Run the full producer → buyer flow:
   - signup → workspace bootstrap (uses `payunivercart_worker` role
     for the cross-tenant bootstrap path; see `services.ts`)
   - configure gateway → create product → checkout → webhook → paid
   - affiliate invite → click → conversion
   - tracking pixel save → event fire
   - marketplace publish → public browse
4. **Cross-tenant probe** — sign in as workspace A, try to fetch
   workspace B's order id directly. Expected: NOT_FOUND, never the
   row from workspace B.
5. **Flip prod DATABASE_URL** to the restricted role only after
   staging passes 100%.

## Rollback

Flip `DATABASE_URL` back to the superuser. Policies remain loaded but
dormant. Zero data migration needed — RLS is a runtime guard, not a
schema change.
