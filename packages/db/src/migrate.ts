import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabaseClient } from './client';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const { db, sql } = createDatabaseClient({ connectionString, maxConnections: 1 });

  console.info('Running drizzle migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.info('Migrations complete.');

  await sql.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
