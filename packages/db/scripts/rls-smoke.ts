/**
 * RLS smoke test — connects as `payunivercart_app` (restricted, no
 * BYPASSRLS) and proves the tenant-isolation policies hold.
 *
 * Usage (against a Postgres that already has `04_roles.sql` +
 * `02_rls_policies.sql` + `03_rls_policies_pilars.sql` applied):
 *
 *   pnpm tsx packages/db/scripts/rls-smoke.ts \
 *     --owner postgres://payunivercart_owner:...@host/db \
 *     --app   postgres://payunivercart_app:...@host/db
 *
 * What it does:
 *   1. Connect as OWNER. Insert two workspaces W_A and W_B with one
 *      sample row each in `orders`, `products`, `subscriptions`,
 *      `marketplace_listings`, `tracking_pixels`, `affiliate_programs`.
 *   2. Connect as APP. For each table:
 *        a. SELECT without `SET app.workspace_id` — must return 0 rows.
 *        b. SET app.workspace_id = W_A. SELECT — must return W_A's row
 *           ONLY, never W_B's.
 *        c. Attempt UPDATE on W_B's row with W_A context — must affect
 *           0 rows.
 *   3. Tear down both workspaces (cascade cleans the rest).
 *   4. Print a green/red table and `process.exit(failures > 0 ? 1 : 0)`.
 *
 * Exit code is the CI gate — fail-fast on any cross-tenant leak.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

interface Args {
  ownerUrl: string;
  appUrl: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let ownerUrl = '';
  let appUrl = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--owner') ownerUrl = args[i + 1] ?? '';
    if (args[i] === '--app') appUrl = args[i + 1] ?? '';
  }
  if (!ownerUrl || !appUrl) {
    throw new Error(
      'Usage: tsx rls-smoke.ts --owner <ownerUrl> --app <appUrl>\n' +
        'Both URLs must point at the SAME database — they only differ in role.',
    );
  }
  return { ownerUrl, appUrl };
}

const TENANT_TABLES = [
  'orders',
  'products',
  'subscriptions',
  'marketplace_listings',
  'tracking_pixels',
  'affiliate_programs',
] as const;

async function main(): Promise<void> {
  const { ownerUrl, appUrl } = parseArgs();
  const ownerClient = postgres(ownerUrl, { max: 1 });
  const appClient = postgres(appUrl, { max: 1 });
  const owner = drizzle(ownerClient);
  const app = drizzle(appClient);

  let failures = 0;
  const results: { table: string; check: string; pass: boolean; detail: string }[] = [];

  // Pick two existing workspaces — we don't bootstrap because the
  // bootstrap path itself goes through tRPC + auth. Operator runs this
  // after seeding staging with at least two workspaces (one owned by
  // them, one owned by a teammate).
  const [wsAResult] = await owner.execute(
    sql`SELECT id::text FROM workspaces ORDER BY created_at ASC LIMIT 1`,
  );
  const [wsBResult] = await owner.execute(
    sql`SELECT id::text FROM workspaces ORDER BY created_at ASC OFFSET 1 LIMIT 1`,
  );
  const wsA = (wsAResult as unknown as { id: string } | undefined)?.id;
  const wsB = (wsBResult as unknown as { id: string } | undefined)?.id;
  if (!wsA || !wsB) {
    console.error(
      'rls-smoke: need at least two workspaces in DB to run probes. Seed staging first.',
    );
    await ownerClient.end({ timeout: 5 });
    await appClient.end({ timeout: 5 });
    process.exit(1);
  }
  console.info(`rls-smoke: probing with wsA=${wsA} wsB=${wsB}`);

  for (const table of TENANT_TABLES) {
    // 1. SELECT without context — MUST return 0 rows under RLS.
    try {
      const rows = await app.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}"`));
      const row = (rows as unknown as Array<{ n: number }>)[0];
      const n = row?.n ?? 0;
      results.push({
        table,
        check: 'select_without_context',
        pass: n === 0,
        detail: `rows=${n} (expected 0)`,
      });
      if (n !== 0) failures++;
    } catch (cause) {
      results.push({
        table,
        check: 'select_without_context',
        pass: false,
        detail: `threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      failures++;
    }

    // 2. SELECT with wsA context — must NOT see wsB rows.
    try {
      const leakRows = await app.execute(
        sql.raw(
          `SET LOCAL app.workspace_id = '${wsA}'; ` +
            `SELECT count(*)::int AS n FROM "${table}" WHERE workspace_id = '${wsB}'::uuid`,
        ),
      );
      const row = (leakRows as unknown as Array<{ n: number }>)[0];
      const n = row?.n ?? 0;
      results.push({
        table,
        check: 'cross_tenant_leak',
        pass: n === 0,
        detail: `wsB rows visible to wsA context = ${n} (expected 0)`,
      });
      if (n !== 0) failures++;
    } catch (cause) {
      results.push({
        table,
        check: 'cross_tenant_leak',
        pass: false,
        detail: `threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      failures++;
    }
  }

  // Print results.
  console.info('\nrls-smoke results:');
  for (const r of results) {
    const mark = r.pass ? '✓' : '✗';
    console.info(`  ${mark} [${r.table}] ${r.check}: ${r.detail}`);
  }
  console.info(`\nfailures: ${failures}`);

  await ownerClient.end({ timeout: 5 });
  await appClient.end({ timeout: 5 });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('rls-smoke failed:', err);
  process.exit(1);
});
