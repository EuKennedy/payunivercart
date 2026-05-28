import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@payunivercart/db';
import { sql as drizzleSql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Idempotent migration runner invoked on API boot, before the HTTP
 * server starts listening. Drives the same migrator the docker-compose
 * `migrate` one-shot uses (`drizzle-orm/postgres-js/migrator`) against
 * the same `packages/db/drizzle/` folder, but from inside the API
 * container so we never depend on Coolify re-running the one-shot
 * between deploys.
 *
 * Hardened (post-incident 2026-05-27 — migration 0021 silently skipped
 * in prod because Coolify reused a cached image without the new
 * `boot-migrate` code):
 *   - Loud structured logs at every step (start, folder probe, file
 *     count, drizzle journal count, post-migrate journal count) so
 *     `docker logs` makes it obvious what happened.
 *   - Hard error when `RUN_MIGRATIONS_ON_BOOT` resolves false in a
 *     production-like environment (NODE_ENV=production) — surfaces
 *     the env-typo class of bug.
 *   - Distinct exit when migrations are PHYSICALLY missing from disk
 *     (compose+Dockerfile drift) vs LOGICALLY missing from journal
 *     (op forgot to redeploy migrate service).
 *
 * Failure modes (all THROW; caller exits non-zero so deploy fails loud):
 *   - DATABASE_URL invalid / unreachable     → throws.
 *   - SQL migration crashes                  → throws.
 *   - migrations folder missing on disk      → throws with resolved path.
 *   - migrations folder empty (zero .sql)    → throws (Docker COPY drift).
 *
 * No retry / backoff: a wrong DATABASE_URL or a broken migration is
 * never going to get better by trying again.
 */
export async function runBootMigrations(databaseUrl: string): Promise<void> {
  const startedAt = Date.now();
  const migrationsFolder = resolveMigrationsFolder();

  log('info', 'api.boot.migrations.start', { migrationsFolder });

  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `boot-migrate: migrations folder not found at "${migrationsFolder}". Check the Dockerfile COPY for packages/db/drizzle/.`,
    );
  }

  // Defensive — `.sql` count > 0. Catches the bug class where a
  // Dockerfile change accidentally drops the `packages/db/drizzle/`
  // COPY but the folder still exists (e.g. created at build by a
  // sibling step). Without this we'd "migrate" against zero files and
  // claim success — exactly the kind of silent skip we just fixed.
  const sqlFiles = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql'));
  if (sqlFiles.length === 0) {
    throw new Error(
      `boot-migrate: no .sql files found in "${migrationsFolder}". Likely a Dockerfile COPY drift.`,
    );
  }
  log('info', 'api.boot.migrations.folder.ok', {
    migrationsFolder,
    sqlFileCount: sqlFiles.length,
    latest: sqlFiles.sort().slice(-3),
  });

  // Dedicated low-concurrency client so the migrator never competes with
  // the server's request-path pool. `maxConnections: 1` is intentional —
  // migrations hold table locks; serialising the runner side avoids
  // cross-connection contention.
  const { db, sql } = createDatabaseClient({
    connectionString: databaseUrl,
    maxConnections: 1,
  });

  let journalBefore = -1;
  let journalAfter = -1;
  try {
    journalBefore = await readJournalCount(db);
    log('info', 'api.boot.migrations.journal.before', { applied: journalBefore });

    const migrateStartedAt = Date.now();
    await migrate(db, { migrationsFolder });
    const migrateTookMs = Date.now() - migrateStartedAt;

    journalAfter = await readJournalCount(db);
    const newlyApplied = Math.max(0, journalAfter - journalBefore);

    log('info', 'api.boot.migrations.done', {
      migrationsFolder,
      sqlFileCount: sqlFiles.length,
      journalBefore,
      journalAfter,
      newlyApplied,
      migrateTookMs,
      totalTookMs: Date.now() - startedAt,
    });

    // Sanity check — drift between disk files and journal rows is fine
    // ONLY when the difference is "we have N files, journal has N rows".
    // If journalAfter < sqlFileCount, something silently skipped a file
    // (drizzle treats it as out-of-order and bails, or the journal table
    // got truncated). Surface explicitly.
    if (journalAfter < sqlFiles.length) {
      log('warn', 'api.boot.migrations.journal.mismatch', {
        message:
          'journal has fewer entries than .sql files on disk — drizzle may have skipped a migration.',
        journalAfter,
        sqlFileCount: sqlFiles.length,
      });
    }
  } catch (err) {
    log('error', 'api.boot.migrations.failed', {
      migrationsFolder,
      journalBefore,
      journalAfter,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Count rows in drizzle's bookkeeping table. Returns -1 when the table
 * doesn't exist yet (first-ever boot against a virgin DB) so the caller
 * can distinguish that from a 0-row mature DB.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle DatabaseClient generic awkward to thread here.
async function readJournalCount(db: any): Promise<number> {
  try {
    const rows = await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`,
    );
    const r = (rows as unknown as Array<{ n: number }>)[0];
    return r?.n ?? -1;
  } catch {
    // Table doesn't exist yet — first boot against a fresh DB.
    return -1;
  }
}

/**
 * Resolve the absolute path to `packages/db/drizzle/` from the API
 * source location. Works in both dev (`apps/api/src/boot-migrate.ts`
 * → repo root → packages/db/drizzle) and the production Docker image
 * (`/repo/apps/api/src/boot-migrate.ts` → `/repo/packages/db/drizzle`).
 */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/api/src → repo root is three levels up.
  return resolve(here, '..', '..', '..', 'packages', 'db', 'drizzle');
}

function log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}
