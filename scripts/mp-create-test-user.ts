/**
 * MP sandbox test-user generator.
 *
 * MP preapproval (`/preapproval`) rejects card tokens unless the
 * `payer_email` belongs to a Test User registered under the same
 * sandbox account that owns the access token. This script reaches
 * into the default sandbox credential of a workspace, decrypts the
 * MP accessToken via the same CryptoService used by the api, then
 * POSTs `https://api.mercadopago.com/users/test` to mint a fresh
 * test user.
 *
 * Usage (inside the Coolify api container):
 *
 *   pnpm tsx scripts/mp-create-test-user.ts \
 *     --workspace "Univer Tech"
 *
 * Prints the test user email + password to stdout. Use the email in
 * the checkout form to make MP accept the subscription.
 */
import 'dotenv/config';
import { CryptoService, loadKeyRegistryFromEnv } from '@payunivercart/crypto';
import { createDatabaseClient, schema } from '@payunivercart/db';
import { and, eq } from 'drizzle-orm';

function arg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error(`Missing --${name}`);
  }
  return process.argv[idx + 1] as string;
}

async function main() {
  const workspaceName = arg('workspace');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  if (!process.env.ENCRYPTION_KEYS) throw new Error('ENCRYPTION_KEYS required');

  const { db } = createDatabaseClient({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  const cryptoSvc = new CryptoService(
    loadKeyRegistryFromEnv({
      keysEnv: process.env.ENCRYPTION_KEYS,
      activeKeyIdEnv: process.env.ENCRYPTION_ACTIVE_KEY_ID,
      envVarName: 'ENCRYPTION_KEYS',
    }),
  );

  const [credRow] = await db
    .select({
      credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
      isSandbox: schema.gatewayCredentials.isSandbox,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.gatewayCredentials)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.gatewayCredentials.workspaceId))
    .where(
      and(
        eq(schema.workspaces.name, workspaceName),
        eq(schema.gatewayCredentials.gatewayId, 'mercadopago'),
        eq(schema.gatewayCredentials.isDefault, true),
      ),
    )
    .limit(1);

  if (!credRow) {
    throw new Error(`No default MP gateway credential for workspace "${workspaceName}"`);
  }
  if (!credRow.isSandbox) {
    throw new Error(
      'Default MP credential is PROD (is_sandbox=false). Test users only work with sandbox credentials.',
    );
  }

  const creds = cryptoSvc.unsealJson<{ accessToken: string; publicKey: string }>(
    credRow.credentialsEncrypted,
  );
  if (!creds.accessToken) {
    throw new Error('Decrypted credentials missing accessToken');
  }

  console.info(
    `[mp] workspace=${credRow.workspaceName} accessToken=${creds.accessToken.slice(0, 12)}...`,
  );

  const res = await fetch('https://api.mercadopago.com/users/test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ site_id: 'MLB' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MP /users/test failed (HTTP ${res.status}): ${body.slice(0, 400)}`);
  }
  const user = (await res.json()) as {
    id: number;
    nickname: string;
    password: string;
    email: string;
    site_status: string;
  };

  console.info('\n========================================');
  console.info('MP SANDBOX TEST USER CREATED');
  console.info('========================================');
  console.info(`Email     : ${user.email}`);
  console.info(`Nickname  : ${user.nickname}`);
  console.info(`Password  : ${user.password}`);
  console.info(`MP user id: ${user.id}`);
  console.info(`Status    : ${user.site_status}`);
  console.info('========================================');
  console.info('Use o Email acima no checkout. Senha só serve');
  console.info('se você precisar logar no MP do test user.');
  console.info('========================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
