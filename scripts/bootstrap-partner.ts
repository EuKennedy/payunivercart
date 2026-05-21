/**
 * Bootstrap script — cria um Univercart Connect partner sem precisar
 * passar pelo admin UI. Usado quando o admin auth ainda não está
 * funcional ou pra automação CI/CD.
 *
 * Uso (de dentro do container api ou local com DATABASE_URL apontando
 * pra base correta):
 *
 *   pnpm tsx scripts/bootstrap-partner.ts \
 *     --slug zapgrup \
 *     --name "ZapGrup" \
 *     --contact dev@zapgrup.com.br \
 *     --setup-url https://zapgrup.com.br/connect/setup \
 *     --webhook-url https://zapgrup.com.br/univercart-webhook \
 *     --roles entry,medium,ultra
 *
 * Imprime os 4 secrets no stdout — copie e cole no .env do partner
 * imediatamente, eles NUNCA mais aparecem em lugar nenhum.
 */
import 'dotenv/config';
import { mintApiKey, mintJwtSecret, mintWebhookSecret } from '@payunivercart/connect';
import { createDatabaseClient, schema } from '@payunivercart/db';
import { eq } from 'drizzle-orm';

function arg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error(`Missing --${name}`);
  }
  return process.argv[idx + 1] as string;
}

async function main() {
  const slug = arg('slug');
  const name = arg('name');
  const contact = arg('contact');
  const setupUrl = arg('setup-url');
  const webhookUrl = arg('webhook-url');
  const rolesCsv = arg('roles');
  const roles = rolesCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const { db } = createDatabaseClient({ connectionString: process.env.DATABASE_URL, ssl: false });

  // 1. Partner — upsert by slug
  const jwtSecret = mintJwtSecret();
  const existing = await db
    .select({
      id: schema.partnerAccounts.id,
      jwtSigningSecret: schema.partnerAccounts.jwtSigningSecret,
    })
    .from(schema.partnerAccounts)
    .where(eq(schema.partnerAccounts.slug, slug))
    .limit(1);

  let partnerId: string;
  let usedJwtSecret: string;
  if (existing.length > 0) {
    const existingRow = existing[0];
    if (!existingRow) throw new Error('unreachable');
    partnerId = existingRow.id;
    usedJwtSecret = existingRow.jwtSigningSecret;
    await db
      .update(schema.partnerAccounts)
      .set({
        name,
        contactEmail: contact,
        setupBaseUrl: setupUrl,
        status: 'active',
      })
      .where(eq(schema.partnerAccounts.id, partnerId));
    console.info(`[partner] reused id=${partnerId} (slug=${slug} existed)`);
  } else {
    const inserted = await db
      .insert(schema.partnerAccounts)
      .values({
        slug,
        name,
        contactEmail: contact,
        status: 'active',
        trialAccessEnabled: false,
        setupBaseUrl: setupUrl,
        jwtSigningSecret: jwtSecret,
      })
      .returning({ id: schema.partnerAccounts.id });
    if (!inserted[0]) throw new Error('partner insert failed');
    partnerId = inserted[0].id;
    usedJwtSecret = jwtSecret;
    console.info(`[partner] created id=${partnerId} slug=${slug}`);
  }

  // 2. Roles — insert any that don't exist
  for (const roleSlug of roles) {
    const exists = await db
      .select({ id: schema.partnerRoles.id })
      .from(schema.partnerRoles)
      .where(eq(schema.partnerRoles.partnerId, partnerId))
      .limit(50);
    if (exists.some((r) => r.id && r.id.length > 0)) {
      // crude — verify by re-querying
    }
    try {
      await db.insert(schema.partnerRoles).values({
        partnerId,
        slug: roleSlug,
        displayName: roleSlug.charAt(0).toUpperCase() + roleSlug.slice(1),
      });
      console.info(`[role] created ${roleSlug}`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        console.info(`[role] ${roleSlug} already exists, skipped`);
      } else {
        throw err;
      }
    }
  }

  // 3. API key — always mint a fresh live key
  const key = mintApiKey('secret', 'live');
  await db.insert(schema.partnerApiKeys).values({
    partnerId,
    name: 'Production',
    mode: 'live',
    prefix: key.prefix,
    hash: key.hash,
  });

  // 4. Webhook endpoint — only insert if URL not registered yet
  const existingEndpoint = await db
    .select({ id: schema.partnerWebhookEndpoints.id })
    .from(schema.partnerWebhookEndpoints)
    .where(eq(schema.partnerWebhookEndpoints.partnerId, partnerId))
    .limit(50);
  let webhookSecret: string;
  if (existingEndpoint.length === 0) {
    webhookSecret = mintWebhookSecret();
    await db.insert(schema.partnerWebhookEndpoints).values({
      partnerId,
      url: webhookUrl,
      mode: 'live',
      signingSecret: webhookSecret,
      eventTypes: [
        'entitlement.granted',
        'entitlement.role_changed',
        'entitlement.suspended',
        'entitlement.reactivated',
        'entitlement.revoked',
      ],
    });
    console.info('[webhook] created');
  } else {
    webhookSecret = '<existing — fetch from DB or admin UI>';
    console.info('[webhook] already exists, not modified');
  }

  // 5. PRINT SECRETS
  console.info('\n========================================');
  console.info('UNIVERCART CONNECT — PARTNER SECRETS');
  console.info('========================================');
  console.info(`PARTNER_SLUG=${slug}`);
  console.info(`UNIVERCART_API_KEY=${key.cleartext}`);
  console.info(`UNIVERCART_WEBHOOK_SECRET=${webhookSecret}`);
  console.info(`UNIVERCART_JWT_SECRET=${usedJwtSecret}`);
  console.info('========================================');
  console.info('Copie AGORA — secrets nunca mais aparecem.');
  console.info('========================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
