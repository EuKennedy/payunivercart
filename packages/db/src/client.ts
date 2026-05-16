import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export interface DatabaseClientOptions {
  connectionString: string;
  /** Postgres connection pool size. */
  maxConnections?: number;
  /** Statement timeout in ms; protects against runaway queries. */
  statementTimeoutMs?: number;
  /** Idle timeout in ms before a pooled connection is closed. */
  idleTimeoutMs?: number;
  /** Enable SSL for managed providers (Neon, RDS); set false for local Docker. */
  ssl?: boolean;
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>['db'];

export function createDatabaseClient(options: DatabaseClientOptions) {
  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    idle_timeout: Math.ceil((options.idleTimeoutMs ?? 30_000) / 1000),
    connect_timeout: 10,
    prepare: true,
    ssl: options.ssl ?? false,
    types: {
      bigint: postgres.BigInt,
    },
  });

  const db = drizzle(sql, {
    schema,
    casing: 'snake_case',
    logger: process.env.NODE_ENV === 'development',
  });

  return { db, sql };
}

export type { Schema };
type Schema = typeof schema;
