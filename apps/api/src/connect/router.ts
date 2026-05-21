import { schema } from '@payunivercart/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import type { AppServices } from '../services';
import { partnerAuth } from './auth';
import { ConnectDispatcher } from './dispatcher';

/**
 * Univercart Connect REST API — partner-facing surface mounted at
 * `/v1/*`. Documented in `~/Downloads/univercart-connect-integration.md`
 * (also delivered to onboarding partners).
 *
 * Auth: `Authorization: Bearer sk_<test|live>_*` via `partnerAuth`.
 *
 * Endpoints:
 *   GET    /v1/entitlements/:externalUserId
 *   GET    /v1/entitlements/by-email/:email
 *   POST   /v1/entitlements/:externalUserId/refresh-link
 *   POST   /v1/tokens/:jti/redeem
 */
export function mountConnectApi(app: Hono, services: AppServices): void {
  const v1 = new Hono();
  v1.use('*', partnerAuth(services));

  const dispatcher = new ConnectDispatcher(services);

  v1.get('/entitlements/by-email/:email', async (c) => {
    const ctx = c.get('connect');
    const email = decodeURIComponent(c.req.param('email')).toLowerCase();
    const row = await loadEntitlementByEmail(services, ctx.partnerId, email);
    if (!row) return jsonError(c, 404, 'entitlement_not_found', 'No entitlement for this email.');
    return c.json(row);
  });

  v1.get('/entitlements/:externalUserId', async (c) => {
    const ctx = c.get('connect');
    const id = c.req.param('externalUserId');
    const row = await loadEntitlementById(services, ctx.partnerId, id);
    if (!row) return jsonError(c, 404, 'entitlement_not_found', 'Entitlement not found.');
    return c.json(row);
  });

  v1.post('/entitlements/:externalUserId/refresh-link', async (c) => {
    const ctx = c.get('connect');
    const id = c.req.param('externalUserId');
    const row = await loadEntitlementById(services, ctx.partnerId, id);
    if (!row) return jsonError(c, 404, 'entitlement_not_found', 'Entitlement not found.');
    if (row.status === 'cancelled') {
      return jsonError(c, 409, 'entitlement_revoked', 'Cannot refresh a revoked entitlement.');
    }
    // Re-dispatch granted = mints fresh token + re-fires email/WA + queues webhook.
    const result = await dispatcher.dispatch({
      type: 'entitlement.granted',
      subscriptionId: id,
    });
    if ('skipped' in result) {
      return jsonError(c, 422, 'cannot_dispatch', `Skipped: ${result.reason}`);
    }
    return c.json({ delivered: ['email', 'whatsapp'], eventId: `evt_${result.eventId}` });
  });

  v1.post('/tokens/:jti/redeem', async (c) => {
    const ctx = c.get('connect');
    const jti = c.req.param('jti');

    const [token] = await services.db.db
      .select({
        jti: schema.entitlementTokens.jti,
        partnerId: schema.entitlementTokens.partnerId,
        subscriptionId: schema.entitlementTokens.subscriptionId,
        expiresAt: schema.entitlementTokens.expiresAt,
        redeemedAt: schema.entitlementTokens.redeemedAt,
      })
      .from(schema.entitlementTokens)
      .where(eq(schema.entitlementTokens.jti, jti))
      .limit(1);

    if (!token) return jsonError(c, 404, 'token_not_found', 'Token unknown.');
    if (token.partnerId !== ctx.partnerId) {
      // Don't leak existence — return 404 to other partners.
      return jsonError(c, 404, 'token_not_found', 'Token unknown.');
    }
    if (token.redeemedAt != null) {
      return jsonError(c, 410, 'token_already_used', 'Token already redeemed.');
    }
    if (token.expiresAt.getTime() < Date.now()) {
      return jsonError(c, 410, 'token_expired', 'Token expired.');
    }

    // Atomic redeem: only mark if still unclaimed (guards against race).
    const result = await services.db.db
      .update(schema.entitlementTokens)
      .set({ redeemedAt: new Date() })
      .where(
        and(eq(schema.entitlementTokens.jti, jti), isNull(schema.entitlementTokens.redeemedAt)),
      )
      .returning({ jti: schema.entitlementTokens.jti });

    if (result.length === 0) {
      return jsonError(c, 410, 'token_already_used', 'Token already redeemed.');
    }

    return c.json({
      jti,
      subscriptionId: token.subscriptionId,
      redeemedAt: new Date().toISOString(),
    });
  });

  app.route('/v1', v1);
}

interface EntitlementResponse {
  externalUserId: string;
  email: string;
  name: string;
  role: string;
  status: 'active' | 'past_due' | 'cancelled' | 'paused' | 'trialing' | 'pending';
  validUntil: string | null;
  createdAt: string;
  productSlug: string;
  planId: string;
  billingPeriod: 'monthly' | 'yearly';
}

async function loadEntitlementById(
  services: AppServices,
  partnerId: string,
  externalUserId: string,
): Promise<EntitlementResponse | null> {
  const [row] = await services.db.db
    .select({
      sub: schema.subscriptions,
      plan: schema.subscriptionPlans,
      product: schema.products,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(
      and(
        eq(schema.subscriptions.id, externalUserId),
        eq(schema.subscriptionPlans.partnerAccountId, partnerId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return shape(row.sub, row.plan, row.product);
}

async function loadEntitlementByEmail(
  services: AppServices,
  partnerId: string,
  email: string,
): Promise<EntitlementResponse | null> {
  const [row] = await services.db.db
    .select({
      sub: schema.subscriptions,
      plan: schema.subscriptionPlans,
      product: schema.products,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(
      and(
        sql`lower(${schema.subscriptions.customerEmail}) = ${email}`,
        eq(schema.subscriptionPlans.partnerAccountId, partnerId),
      ),
    )
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);
  if (!row) return null;
  return shape(row.sub, row.plan, row.product);
}

function shape(
  sub: typeof schema.subscriptions.$inferSelect,
  plan: typeof schema.subscriptionPlans.$inferSelect,
  product: typeof schema.products.$inferSelect,
): EntitlementResponse {
  return {
    externalUserId: sub.id,
    email: sub.customerEmail,
    name: sub.customerName,
    role: plan.partnerRoleSlug ?? '',
    status: (sub.status as EntitlementResponse['status']) ?? 'pending',
    validUntil: sub.nextChargeAt?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
    productSlug: product.slug,
    planId: plan.id,
    billingPeriod: plan.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
  };
}

function jsonError(
  c: Context,
  status: 400 | 401 | 404 | 409 | 410 | 422 | 500,
  code: string,
  message: string,
) {
  return c.json(
    {
      error: {
        code,
        message,
        request_id: c.req.header('x-request-id') ?? null,
      },
    },
    status,
  );
}
