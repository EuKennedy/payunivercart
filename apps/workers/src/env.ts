import { PayunivercartError } from '@payunivercart/shared';
import { z } from 'zod';

const PLACEHOLDER = '__REPLACE_ME__';

function noPlaceholder(name: string) {
  return (value: string) => {
    if (value.includes(PLACEHOLDER)) {
      throw new Error(`${name} still contains "${PLACEHOLDER}". Replace before booting.`);
    }
    return value;
  };
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url().transform(noPlaceholder('DATABASE_URL')),
  REDIS_URL: z.string().url().transform(noPlaceholder('REDIS_URL')),

  WAHA_BASE_URL: z.string().url().transform(noPlaceholder('WAHA_BASE_URL')),
  WAHA_API_KEY: z.string().min(8).transform(noPlaceholder('WAHA_API_KEY')),

  ENCRYPTION_KEYS: z.string().min(1).transform(noPlaceholder('ENCRYPTION_KEYS')),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),

  AUDIT_KEYS: z.string().min(1).transform(noPlaceholder('AUDIT_KEYS')),
  AUDIT_ACTIVE_KEY_ID: z.string().optional(),

  /** Worker concurrency per queue. */
  WORKERS_CONCURRENCY: z.coerce.number().int().positive().default(5),

  /** Public URL of the api service — used by the PIX cycle worker to
   *  feed gateway webhook URLs back to MP so the IPN lands on the right
   *  host. Optional; when empty the adapter falls back to whatever URL
   *  the producer set globally in their gateway dashboard. */
  API_PUBLIC_URL: z.string().url().optional(),

  /** Sentry DSN — no-op when empty. */
  SENTRY_DSN: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
});

export type WorkersEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkersEnv {
  const r = schema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `Invalid environment configuration:\n${issues}`,
    });
  }
  return r.data;
}
