/**
 * One-shot bootstrap — registra o belezaki como partner + produto vendável no
 * Univercart, com 2 planos. Idempotente: rode quantas vezes quiser, não duplica.
 *
 * Cria/garante:
 *   1. partnerAccount  slug=belezaki  (active)
 *   2. partnerRoles    entry, premium
 *   3. partnerApiKey   live (só minta se ainda não existe nenhuma)
 *   4. webhook endpoint (só insere se URL ainda não cadastrada) — opcional
 *   5. product         "Belezaki" (type=subscription) no workspace de venda
 *   6. 2 planos:
 *        Entry    R$ 49,90/mês  → partnerRoleSlug=entry
 *        Premium  R$ 99,00/mês  → partnerRoleSlug=premium
 *      ambos partnerAccountId=belezaki, paymentMethod=both
 *
 * Os secrets do partner (API key / webhook / jwt) são impressos UMA vez quando
 * minтados — copie pro .env do belezaki.
 *
 * Uso (dentro do container api, DATABASE_URL=prod):
 *
 *   <tsx> scripts/bootstrap-belezaki.ts \
 *     --workspace-slug <slug-do-seu-workspace-de-venda> \
 *     --setup-url   https://app.belezaki.com.br/connect/setup \
 *     --webhook-url https://api.belezaki.com.br/webhooks/univercart \
 *     [--logo /caminho/para/belezaki-logo.png]
 *
 * `--workspace-id <uuid>` no lugar de `--workspace-slug` também serve.
 * `--logo` é opcional (pode subir a capa pelo dashboard depois).
 *
 * NOTA preço "de/por": o plano guarda só o preço cobrado (amountCents). O valor
 * riscado ("de R$99,90") não é campo nativo — fica na descrição do produto.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { mintApiKey, mintJwtSecret, mintWebhookSecret } from '@payunivercart/connect';
import { createDatabaseClient, schema } from '@payunivercart/db';
import { and, eq } from 'drizzle-orm';

const PARTNER_SLUG = 'belezaki';
const PARTNER_NAME = 'Belezaki';
const PRODUCT_SLUG = 'belezaki';
const PRODUCT_NAME = 'Belezaki';
const PRODUCT_DESCRIPTION =
  'Sistema de gestão para salões e clínicas de estética. ' +
  'Entry: de R$ 99,90 por R$ 49,90/mês. Premium: de R$ 199,00 por R$ 99,00/mês.';

const ROLES = [
  { slug: 'entry', displayName: 'Entry' },
  { slug: 'premium', displayName: 'Premium' },
];

const PLANS = [
  { name: 'Entry', amountCents: 4990n, roleSlug: 'entry', sortOrder: 0, highlighted: false },
  { name: 'Premium', amountCents: 9900n, roleSlug: 'premium', sortOrder: 1, highlighted: true },
];

function arg(name: string, required = true): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) {
    if (required) throw new Error(`Missing --${name}`);
    return undefined;
  }
  return process.argv[idx + 1];
}

function mimeFromExt(path: string): string {
  const e = extname(path).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function main() {
  const workspaceSlug = arg('workspace-slug', false);
  const workspaceIdArg = arg('workspace-id', false);
  const workspaceNameArg = arg('workspace-name', false);
  const setupUrl = arg('setup-url');
  const webhookUrl = arg('webhook-url', false);
  const logoPath = arg('logo', false);
  if (!workspaceSlug && !workspaceIdArg && !workspaceNameArg)
    throw new Error('Missing --workspace-slug, --workspace-id or --workspace-name');

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const { db } = createDatabaseClient({ connectionString: process.env.DATABASE_URL, ssl: false });

  // 0. Workspace de venda (onde o produto vive). Resolve por id, slug ou nome.
  const workspaceWhere = workspaceIdArg
    ? eq(schema.workspaces.id, workspaceIdArg)
    : workspaceSlug
      ? eq(schema.workspaces.slug, workspaceSlug)
      : eq(schema.workspaces.name, workspaceNameArg as string);
  const matches = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(workspaceWhere)
    .limit(5);
  if (matches.length === 0) {
    throw new Error(`workspace not found (${workspaceIdArg ?? workspaceSlug ?? workspaceNameArg})`);
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous workspace name — ${matches.length} matches: ${matches
        .map((m) => `${m.name} [slug=${m.slug} id=${m.id}]`)
        .join('; ')}. Re-run with --workspace-id <uuid>.`,
    );
  }
  const ws = matches[0];
  const workspaceId = ws.id;

  const printSecrets: string[] = [];

  // 1. Partner — upsert por slug.
  const [existingPartner] = await db
    .select({ id: schema.partnerAccounts.id, jwt: schema.partnerAccounts.jwtSigningSecret })
    .from(schema.partnerAccounts)
    .where(eq(schema.partnerAccounts.slug, PARTNER_SLUG))
    .limit(1);

  let partnerId: string;
  let jwtSecret: string;
  if (existingPartner) {
    partnerId = existingPartner.id;
    jwtSecret = existingPartner.jwt;
    await db
      .update(schema.partnerAccounts)
      .set({ name: PARTNER_NAME, status: 'active', setupBaseUrl: setupUrl })
      .where(eq(schema.partnerAccounts.id, partnerId));
    console.info(`[partner] reused ${partnerId}`);
  } else {
    jwtSecret = mintJwtSecret();
    const [row] = await db
      .insert(schema.partnerAccounts)
      .values({
        slug: PARTNER_SLUG,
        name: PARTNER_NAME,
        contactEmail: 'dev@belezaki.com.br',
        status: 'active',
        trialAccessEnabled: false,
        setupBaseUrl: setupUrl,
        jwtSigningSecret: jwtSecret,
      })
      .returning({ id: schema.partnerAccounts.id });
    if (!row) throw new Error('partner insert failed');
    partnerId = row.id;
    printSecrets.push(`UNIVERCART_JWT_SECRET=${jwtSecret}`);
    console.info(`[partner] created ${partnerId}`);
  }

  // 2. Roles.
  for (const role of ROLES) {
    const [hit] = await db
      .select({ id: schema.partnerRoles.id })
      .from(schema.partnerRoles)
      .where(
        and(eq(schema.partnerRoles.partnerId, partnerId), eq(schema.partnerRoles.slug, role.slug)),
      )
      .limit(1);
    if (!hit) {
      await db
        .insert(schema.partnerRoles)
        .values({ partnerId, slug: role.slug, displayName: role.displayName });
      console.info(`[role] created ${role.slug}`);
    }
  }

  // 3. API key — só minta se não existe nenhuma.
  const existingKeys = await db
    .select({ id: schema.partnerApiKeys.id })
    .from(schema.partnerApiKeys)
    .where(eq(schema.partnerApiKeys.partnerId, partnerId))
    .limit(1);
  if (existingKeys.length === 0) {
    const key = mintApiKey('secret', 'live');
    await db.insert(schema.partnerApiKeys).values({
      partnerId,
      name: 'Production',
      mode: 'live',
      prefix: key.prefix,
      hash: key.hash,
    });
    printSecrets.push(`UNIVERCART_API_KEY=${key.cleartext}`);
    console.info('[apikey] created');
  } else {
    console.info('[apikey] already exists — not minting (use existing or revoke+rerun)');
  }

  // 4. Webhook endpoint — opcional, só se URL passada e ainda não cadastrada.
  if (webhookUrl) {
    const [endpoint] = await db
      .select({ id: schema.partnerWebhookEndpoints.id })
      .from(schema.partnerWebhookEndpoints)
      .where(
        and(
          eq(schema.partnerWebhookEndpoints.partnerId, partnerId),
          eq(schema.partnerWebhookEndpoints.url, webhookUrl),
        ),
      )
      .limit(1);
    if (!endpoint) {
      const secret = mintWebhookSecret();
      await db.insert(schema.partnerWebhookEndpoints).values({
        partnerId,
        url: webhookUrl,
        mode: 'live',
        signingSecret: secret,
        eventTypes: [
          'entitlement.granted',
          'entitlement.role_changed',
          'entitlement.suspended',
          'entitlement.reactivated',
          'entitlement.revoked',
        ],
      });
      printSecrets.push(`UNIVERCART_WEBHOOK_SECRET=${secret}`);
      console.info('[webhook] created');
    } else {
      console.info('[webhook] url already registered — not modified');
    }
  }

  // 5. Product — upsert por (workspace, slug).
  const logoBytes = logoPath ? readFileSync(logoPath) : null;
  const [existingProduct] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(
      and(eq(schema.products.workspaceId, workspaceId), eq(schema.products.slug, PRODUCT_SLUG)),
    )
    .limit(1);

  let productId: string;
  if (existingProduct) {
    productId = existingProduct.id;
    await db
      .update(schema.products)
      .set({
        name: PRODUCT_NAME,
        description: PRODUCT_DESCRIPTION,
        type: 'subscription',
        isSubscription: true,
        isActive: true,
        ...(logoBytes
          ? { coverImage: logoBytes, coverImageMime: mimeFromExt(logoPath as string) }
          : {}),
      })
      .where(eq(schema.products.id, productId));
    console.info(`[product] reused ${productId}`);
  } else {
    const [row] = await db
      .insert(schema.products)
      .values({
        workspaceId,
        slug: PRODUCT_SLUG,
        name: PRODUCT_NAME,
        description: PRODUCT_DESCRIPTION,
        type: 'subscription',
        isSubscription: true,
        isActive: true,
        ...(logoBytes
          ? { coverImage: logoBytes, coverImageMime: mimeFromExt(logoPath as string) }
          : {}),
      })
      .returning({ id: schema.products.id });
    if (!row) throw new Error('product insert failed');
    productId = row.id;
    console.info(`[product] created ${productId}`);
  }

  // 6. Plans — upsert por (product, name). Mapeados ao partner + role.
  for (const plan of PLANS) {
    const [existingPlan] = await db
      .select({ id: schema.subscriptionPlans.id })
      .from(schema.subscriptionPlans)
      .where(
        and(
          eq(schema.subscriptionPlans.productId, productId),
          eq(schema.subscriptionPlans.name, plan.name),
        ),
      )
      .limit(1);
    const values = {
      workspaceId,
      productId,
      name: plan.name,
      billingPeriod: 'monthly',
      amountCents: plan.amountCents,
      currency: 'BRL' as const,
      trialDays: 0,
      isActive: true,
      sortOrder: plan.sortOrder,
      paymentMethod: 'both' as const,
      isHighlighted: plan.highlighted,
      partnerAccountId: partnerId,
      partnerRoleSlug: plan.roleSlug,
    };
    if (existingPlan) {
      await db
        .update(schema.subscriptionPlans)
        .set(values)
        .where(eq(schema.subscriptionPlans.id, existingPlan.id));
      console.info(
        `[plan] updated ${plan.name} (R$ ${(Number(plan.amountCents) / 100).toFixed(2)})`,
      );
    } else {
      await db.insert(schema.subscriptionPlans).values(values);
      console.info(
        `[plan] created ${plan.name} (R$ ${(Number(plan.amountCents) / 100).toFixed(2)})`,
      );
    }
  }

  // 7. Output.
  console.info('\n========================================');
  console.info('BELEZAKI — 100% integrado no Univercart');
  console.info('========================================');
  console.info(`workspace   = ${ws.name} (${workspaceId})`);
  console.info(`partner     = ${PARTNER_SLUG} (${partnerId})`);
  console.info(`product     = ${PRODUCT_NAME} (${productId})`);
  console.info(`planos      = Entry R$49,90 · Premium R$99,00 (mensal, both)`);
  console.info(`roles       = entry, premium`);
  if (printSecrets.length > 0) {
    console.info('\n--- SECRETS (copie pro .env do belezaki AGORA — não reaparecem) ---');
    console.info(`UNIVERCART_API_BASE=https://api.univercart.com`);
    console.info(`UNIVERCART_PARTNER_SLUG=${PARTNER_SLUG}`);
    for (const s of printSecrets) console.info(s);
  } else {
    console.info('\n(secrets já existiam — não reimpressos)');
  }
  console.info('========================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Bootstrap belezaki failed:', err);
  process.exit(1);
});
