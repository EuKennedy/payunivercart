/**
 * Mint a TEST magic link — simulates the JWT a real purchase would hand
 * the buyer, without going through checkout/gateway. Use to E2E-test a
 * Univercart Connect partner (e.g. UniverReview): the printed link points
 * at the partner's `setupBaseUrl?t=<jwt>`, carries the same claims a real
 * grant would, and persists the `jti` in `entitlement_tokens` so the
 * partner's `POST /v1/tokens/:jti/redeem` + `/v1/entitlements/*` calls
 * resolve.
 *
 * It creates a throwaway `subscriptions` row (status=active, synthetic
 * gatewaySubscriptionId) mapped to the partner's plan — that row is the
 * entitlement the partner will read back. Delete it when done testing.
 *
 * Usage (inside the api container, DATABASE_URL pointing at prod):
 *
 *   pnpm tsx scripts/mint-test-magic-link.ts \
 *     --partner-slug univereview \
 *     --email comprador.teste@exemplo.com \
 *     --name "Comprador Teste" \
 *     [--role ultra] \
 *     [--plan-id <uuid>]
 *
 * --role defaults to the plan's `partnerRoleSlug`. --plan-id pins a
 * specific plan; omit to auto-pick any plan mapped to this partner.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { signMagicLink } from '@payunivercart/connect';
import { createDatabaseClient, schema } from '@payunivercart/db';
import { and, eq, isNotNull } from 'drizzle-orm';

function arg(name: string, required = true): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) {
    if (required) throw new Error(`Missing --${name}`);
    return undefined;
  }
  return process.argv[idx + 1];
}

async function main() {
  const slug = arg('partner-slug') as string;
  const email = arg('email') as string;
  const name = arg('name') as string;
  const roleOverride = arg('role', false);
  const planIdOverride = arg('plan-id', false);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const { db } = createDatabaseClient({ connectionString: process.env.DATABASE_URL, ssl: false });

  // 1. Partner — must exist + be active, and carry its JWT signing secret
  //    + setup URL (set during bootstrap).
  const [partner] = await db
    .select({
      id: schema.partnerAccounts.id,
      slug: schema.partnerAccounts.slug,
      status: schema.partnerAccounts.status,
      jwtSigningSecret: schema.partnerAccounts.jwtSigningSecret,
      setupBaseUrl: schema.partnerAccounts.setupBaseUrl,
    })
    .from(schema.partnerAccounts)
    .where(eq(schema.partnerAccounts.slug, slug))
    .limit(1);
  if (!partner) throw new Error(`partner slug=${slug} not found — bootstrap it first`);
  if (partner.status !== 'active') throw new Error(`partner ${slug} is ${partner.status}, not active`);
  if (!partner.setupBaseUrl) throw new Error(`partner ${slug} has no setupBaseUrl`);

  // 2. Resolve a plan mapped to this partner. The mapping
  //    (partnerAccountId + partnerRoleSlug) is what a real grant reads;
  //    no mapped plan = nothing to entitle.
  const planWhere = planIdOverride
    ? eq(schema.subscriptionPlans.id, planIdOverride)
    : and(
        eq(schema.subscriptionPlans.partnerAccountId, partner.id),
        isNotNull(schema.subscriptionPlans.partnerRoleSlug),
      );
  const [plan] = await db
    .select({
      id: schema.subscriptionPlans.id,
      workspaceId: schema.subscriptionPlans.workspaceId,
      productId: schema.subscriptionPlans.productId,
      partnerAccountId: schema.subscriptionPlans.partnerAccountId,
      partnerRoleSlug: schema.subscriptionPlans.partnerRoleSlug,
    })
    .from(schema.subscriptionPlans)
    .where(planWhere)
    .limit(1);
  if (!plan) {
    throw new Error(
      `no plan mapped to partner ${slug}. In the dashboard, edit a product's plan and pick partner=${slug} + a role first.`,
    );
  }
  if (plan.partnerAccountId !== partner.id && !planIdOverride) {
    throw new Error('resolved plan is not mapped to this partner');
  }
  const role = roleOverride ?? plan.partnerRoleSlug;
  if (!role) throw new Error('plan has no partnerRoleSlug and no --role given');

  // 3. Throwaway active subscription = the entitlement the partner reads.
  const publicReference = `TEST-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date();
  const [sub] = await db
    .insert(schema.subscriptions)
    .values({
      workspaceId: plan.workspaceId,
      productId: plan.productId,
      planId: plan.id,
      publicReference,
      customerName: name,
      customerEmail: email.toLowerCase(),
      customerDocument: '00000000000',
      customerPhoneRaw: '11999999999',
      customerPhoneE164: '+5511999999999',
      gatewayId: 'mercadopago',
      gatewaySubscriptionId: `test_${randomUUID()}`,
      status: 'active',
      startedAt: now,
      nextChargeAt: new Date(now.getTime() + 30 * 86_400_000),
      paymentMethod: 'card',
      currentCycleStatus: 'paid',
    })
    .returning({ id: schema.subscriptions.id });
  if (!sub) throw new Error('test subscription insert failed');

  // 4. Sign + persist the token (jti must exist before the link is used).
  const signed = signMagicLink({
    subscriptionId: sub.id,
    email,
    name,
    partnerSlug: partner.slug,
    partnerRoleSlug: role,
    jwtSigningSecret: partner.jwtSigningSecret,
  });
  await db.insert(schema.entitlementTokens).values({
    jti: signed.jti,
    subscriptionId: sub.id,
    partnerId: partner.id,
    expiresAt: signed.expiresAt,
  });

  const base = partner.setupBaseUrl.replace(/\/$/, '');
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}${sep}t=${signed.jwt}`;

  console.info('\n========================================');
  console.info('TEST MAGIC LINK — simula compra real');
  console.info('========================================');
  console.info(`partner        = ${partner.slug}`);
  console.info(`role           = ${role}`);
  console.info(`subscriptionId = ${sub.id}`);
  console.info(`buyer email    = ${email}`);
  console.info(`jti            = ${signed.jti}`);
  console.info(`expiresAt      = ${signed.expiresAt.toISOString()}`);
  console.info('\nMAGIC LINK:');
  console.info(url);
  console.info('\nCleanup depois do teste:');
  console.info(`  DELETE FROM entitlement_tokens WHERE jti = '${signed.jti}';`);
  console.info(`  DELETE FROM subscriptions WHERE id = '${sub.id}';`);
  console.info('========================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Mint failed:', err);
  process.exit(1);
});
