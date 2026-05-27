import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@payunivercart/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Idempotent migration runner invoked on API boot, before the HTTP
 * server starts listening. Drives the same migrator the docker-compose
 * `migrate` one-shot uses (`drizzle-orm/postgres-js/migrator`) against
 * the same `packages/db/drizzle/` folder, but from inside the API
 * container so we never depend on Coolify re-running the one-shot
 * between deploys.
 *
 * Failure modes:
 *   - DATABASE_URL invalid / unreachable     → throws, API refuses boot.
 *   - SQL migration crashes                  → throws, API refuses boot.
 *   - migrations folder missing on disk      → throws with the resolved
 *                                              path so the operator can
 *                                              tell whether the Docker
 *                                              copy step was wrong.
 *
 * No retry / backoff: a wrong DATABASE_URL or a broken migration is
 * never going to get better by trying again. We want the deploy to fail
 * loudly so the producer sees the redeploy failed instead of getting a
 * silently-half-migrated DB.
 */
export async function runBootMigrations(databaseUrl: string): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `boot-migrate: migrations folder not found at "${migrationsFolder}". Check the Dockerfile COPY for packages/db/drizzle/.`,
    );
  }

  // Dedicated low-concurrency client so the migrator never competes with
  // the server's request-path pool. `maxConnections: 1` is intentional —
  // migrations hold table locks; serialising the runner side avoids
  // cross-connection contention.
  const { db, sql } = createDatabaseClient({
    connectionString: databaseUrl,
    maxConnections: 1,
  });
  const started = Date.now();
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
  const took = Date.now() - started;
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: 'api.boot.migrations.done',
      migrationsFolder,
      tookMs: took,
    })}\n`,
  );
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
