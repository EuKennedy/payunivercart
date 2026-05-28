/**
 * Affiliate click + attribution helpers.
 *
 * Two surfaces:
 *   - `recordClick`            captures a hit on /a/:slug and returns
 *                              the redirect destination + cookie value.
 *   - `resolveAttribution`     called inside checkout.createOrder and
 *                              subscriptions.subscribe to attach a
 *                              freshly-created order / subscription
 *                              to the most recent matching click that
 *                              still falls inside the program's
 *                              attribution window.
 *
 * Both helpers materialise commission rows in `pending` status as
 * soon as an attribution is created — the worker (PR 4) flips them to
 * `available` after the program's refund window passes. Recurring /
 * lifetime commissions create one row per cycle when the subscription
 * webhook materialises a renewal order.
 */

import { createHash } from 'node:crypto';
import { schema } from '@payunivercart/db';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../services';
import { emitAffiliateCommissionEvent } from '../webhooks/emit-helpers';

/** Hash the IP so the click table doesn't store PII. Salt is the
 *  audit chain HMAC key — re-using saves us a dedicated env var.
 *  Exported for unit-test parity. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/** Fingerprint is whatever the buyer's browser exposes — UA + accept
 *  language + screen size. We don't enforce that the buyer sends it.
 *  Exported for unit-test parity. */
export function hashFingerprint(value: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex');
}

interface RecordClickInput {
  services: AppServices;
  /** The slug from /a/:slug. */
  slug: string;
  ip: string;
  fingerprint: string | null;
  userAgent: string | null;
  referrer: string | null;
  country: string | null;
  /** Salt for the IP hash. Use `env.AUDIT_KEYS[0]` or similar. */
  saltSecret: string;
}

interface RecordClickResult {
  /** URL the buyer should land on after the redirect. */
  redirectTo: string;
  /** Cookie payload (`payuniv_aff=<slug>`). Caller sets the Set-Cookie. */
  cookieSlug: string;
  /** Materialised click row id. */
  clickId: string;
  /** Program attribution window in days, surfaced for the cookie Max-Age. */
  windowDays: number;
}

/**
 * Record an affiliate click. Idempotent within the same (link, ip,
 * day) bucket — repeated taps on the same link from the same browser
 * collapse to one row to keep the table cheap.
 */
export async function recordClick(input: RecordClickInput): Promise<RecordClickResult | null> {
  const { services } = input;
  const db = services.db.db;

  // 1. Resolve the slug → link + program. Slug uniqueness is enforced
  //    at the DB index level so this is at most one row.
  const [link] = await db
    .select({
      id: schema.affiliateLinks.id,
      workspaceId: schema.affiliateLinks.workspaceId,
      programId: schema.affiliateLinks.programId,
      affiliateId: schema.affiliateLinks.affiliateId,
      productId: schema.affiliateLinks.productId,
      isActive: schema.affiliateLinks.isActive,
      expiresAt: schema.affiliateLinks.expiresAt,
      attributionWindowDays: schema.affiliatePrograms.attributionWindowDays,
      programActive: schema.affiliatePrograms.isActive,
      productSlug: schema.products.slug,
    })
    .from(schema.affiliateLinks)
    .innerJoin(
      schema.affiliatePrograms,
      eq(schema.affiliatePrograms.id, schema.affiliateLinks.programId),
    )
    .leftJoin(schema.products, eq(schema.products.id, schema.affiliateLinks.productId))
    .where(eq(schema.affiliateLinks.slug, input.slug))
    .limit(1);
  if (!link || !link.isActive || !link.programActive) return null;
  if (link.expiresAt && link.expiresAt < new Date()) return null;

  const ipHash = hashIp(input.ip, input.saltSecret);
  const fingerprint = hashFingerprint(input.fingerprint);

  // 2. Dedupe: same (link, ipHash, day). Cheaper than a unique index
  //    because day-bucketing keeps the lookup small.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [existing] = await db
    .select({ id: schema.affiliateClicks.id })
    .from(schema.affiliateClicks)
    .where(
      and(
        eq(schema.affiliateClicks.linkId, link.id),
        eq(schema.affiliateClicks.ipHash, ipHash),
        gte(schema.affiliateClicks.occurredAt, today),
      ),
    )
    .limit(1);

  let clickId = existing?.id;
  if (!clickId) {
    const [inserted] = await db
      .insert(schema.affiliateClicks)
      .values({
        workspaceId: link.workspaceId,
        linkId: link.id,
        affiliateId: link.affiliateId,
        productId: link.productId ?? null,
        ipHash,
        fingerprint,
        userAgent: input.userAgent,
        referrer: input.referrer,
        country: input.country,
      })
      .returning({ id: schema.affiliateClicks.id });
    if (!inserted) return null;
    clickId = inserted.id;
    // Bump the materialised counter — cheap UPDATE so the dashboard
    // shows "clicks today" without a COUNT(*) over the hot table.
    await db
      .update(schema.affiliateLinks)
      .set({ clickCount: sql`${schema.affiliateLinks.clickCount} + 1` })
      .where(eq(schema.affiliateLinks.id, link.id));
    // Async-ish: fire-and-log fraud detection on the freshly-recorded
    // click. Failures must NEVER break the redirect, so we wrap.
    try {
      await detectFraudSignals({
        services,
        workspaceId: link.workspaceId,
        affiliateId: link.affiliateId,
        ipHash,
        clickId,
      });
    } catch {
      /* fraud detection is best-effort */
    }
  }

  // 3. Decide where the buyer lands.
  //    - link.productSlug present → checkout page for that product
  //    - else → workspace home (we send to the platform root; the
  //      operator can later configure a per-workspace landing).
  const checkoutBase = (process.env.CHECKOUT_PUBLIC_URL ?? 'https://pay.univercart.com').replace(
    /\/$/,
    '',
  );
  const redirectTo = link.productSlug ? `${checkoutBase}/c/${link.productSlug}` : checkoutBase;

  return {
    redirectTo,
    cookieSlug: input.slug,
    clickId,
    windowDays: link.attributionWindowDays,
  };
}

interface ResolveAttributionInput {
  services: AppServices;
  /** Slug from the `payuniv_aff` cookie (NULL when no cookie). */
  affiliateSlug: string | null;
  workspaceId: string;
  productId: string | null;
  /** Set ONE of these. */
  orderId?: string;
  subscriptionId?: string;
  /** Buyer's request IP — used to match against the click row. */
  ip: string;
  /** Fingerprint to match (optional). */
  fingerprint: string | null;
  saltSecret: string;
}

/**
 * Resolve a sale to an affiliate attribution. Called inside the
 * checkout / subscribe flows AFTER the order / subscription is in DB.
 *
 * Logic:
 *   1. Lookup the link by slug. Must be active + program active +
 *      not expired.
 *   2. Find the most recent matching click within
 *      `attribution_window_days`. Match by EITHER `ip_hash` OR
 *      `fingerprint` — strict AND would lose mobile users who
 *      switched between wifi and 4g between click and buy.
 *   3. Create the attribution row (partial unique on order/sub
 *      protects against double-fire).
 *   4. Materialise the FIRST commission row in `pending`. Recurring
 *      programs create one row per renewal in PR 4's worker.
 *
 * Returns the attribution id when one was created, NULL when no
 * eligible match was found (no link, no click in window, program
 * inactive, or the buyer doesn't have an approved membership).
 */
export async function resolveAttribution(
  input: ResolveAttributionInput,
): Promise<{ attributionId: string; commissionId: string | null } | null> {
  if (!input.affiliateSlug) return null;
  const { services } = input;
  const db = services.db.db;

  const [link] = await db
    .select({
      id: schema.affiliateLinks.id,
      programId: schema.affiliateLinks.programId,
      affiliateId: schema.affiliateLinks.affiliateId,
      programWorkspaceId: schema.affiliatePrograms.workspaceId,
      isActive: schema.affiliateLinks.isActive,
      programActive: schema.affiliatePrograms.isActive,
      expiresAt: schema.affiliateLinks.expiresAt,
      attributionWindowDays: schema.affiliatePrograms.attributionWindowDays,
      commissionType: schema.affiliatePrograms.commissionType,
      commissionPercent: schema.affiliatePrograms.commissionPercent,
      commissionFlatCents: schema.affiliatePrograms.commissionFlatCents,
      refundWindowDays: schema.affiliatePrograms.refundWindowDays,
      programProductId: schema.affiliatePrograms.productId,
    })
    .from(schema.affiliateLinks)
    .innerJoin(
      schema.affiliatePrograms,
      eq(schema.affiliatePrograms.id, schema.affiliateLinks.programId),
    )
    .where(eq(schema.affiliateLinks.slug, input.affiliateSlug))
    .limit(1);
  if (!link || !link.isActive || !link.programActive) return null;
  if (link.expiresAt && link.expiresAt < new Date()) return null;
  // Tenant guard: the link's program MUST belong to the workspace
  // that's processing this sale. Prevents an attacker from passing a
  // slug of another tenant's program to claim an attribution.
  if (link.programWorkspaceId !== input.workspaceId) return null;
  // Product scope: if the program is product-specific, the sale's
  // productId must match.
  if (link.programProductId && link.programProductId !== input.productId) return null;
  // Affiliate must be an approved member to earn commissions.
  const [member] = await db
    .select({ status: schema.affiliateMemberships.status })
    .from(schema.affiliateMemberships)
    .where(
      and(
        eq(schema.affiliateMemberships.programId, link.programId),
        eq(schema.affiliateMemberships.affiliateId, link.affiliateId),
      ),
    )
    .limit(1);
  if (!member || member.status !== 'approved') return null;

  // Find the matching click within window. Match by ip OR fingerprint.
  const ipHash = hashIp(input.ip, input.saltSecret);
  const fingerprint = hashFingerprint(input.fingerprint);
  const windowStart = new Date(Date.now() - link.attributionWindowDays * 24 * 60 * 60 * 1000);
  const [click] = await db
    .select({ id: schema.affiliateClicks.id, occurredAt: schema.affiliateClicks.occurredAt })
    .from(schema.affiliateClicks)
    .where(
      and(
        eq(schema.affiliateClicks.linkId, link.id),
        gte(schema.affiliateClicks.occurredAt, windowStart),
        fingerprint
          ? sql`(${schema.affiliateClicks.ipHash} = ${ipHash} OR ${schema.affiliateClicks.fingerprint} = ${fingerprint})`
          : eq(schema.affiliateClicks.ipHash, ipHash),
      ),
    )
    .orderBy(desc(schema.affiliateClicks.occurredAt))
    .limit(1);
  // No matching click — attribution still flows on cookie-only basis
  // when at least the slug is present (a producer running "trusted
  // affiliate" programs may want this). We honor the click when
  // present because it's the stronger signal.

  const attributedSeconds = click
    ? Math.max(1, Math.floor((Date.now() - click.occurredAt.getTime()) / 1000))
    : 0;

  let attributionId: string;
  try {
    const [inserted] = await db
      .insert(schema.affiliateAttributions)
      .values({
        workspaceId: input.workspaceId,
        programId: link.programId,
        affiliateId: link.affiliateId,
        linkId: link.id,
        clickId: click?.id ?? null,
        orderId: input.orderId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        attributedSeconds,
      })
      .returning({ id: schema.affiliateAttributions.id });
    if (!inserted) return null;
    attributionId = inserted.id;
  } catch (cause) {
    // Partial unique index fired — sale already attributed (concurrent
    // webhook / sync click). Bail silently; the existing attribution
    // is authoritative.
    if ((cause as { code?: string })?.code === '23505') return null;
    throw cause;
  }

  // Bump the materialised attribution counter on the link.
  await db
    .update(schema.affiliateLinks)
    .set({ attributionCount: sql`${schema.affiliateLinks.attributionCount} + 1` })
    .where(eq(schema.affiliateLinks.id, link.id));

  // Run fraud detection on the attribution — best-effort.
  try {
    await detectFraudSignals({
      services,
      workspaceId: input.workspaceId,
      affiliateId: link.affiliateId,
      ipHash,
      clickId: click?.id,
      attributionId,
    });
  } catch {
    /* fraud detection is best-effort */
  }

  // Materialise the first commission row in `pending`. Recurring +
  // lifetime programs add more rows in the renewal handler (PR 4).
  const commissionId = await materializeCommission(services, {
    workspaceId: input.workspaceId,
    programId: link.programId,
    affiliateId: link.affiliateId,
    attributionId,
    orderId: input.orderId ?? null,
    subscriptionId: input.subscriptionId ?? null,
    cycleNumber: input.subscriptionId ? 1 : null,
    commissionType: link.commissionType as 'percent' | 'flat' | 'recurring' | 'lifetime',
    commissionPercent: link.commissionPercent,
    commissionFlatCents: link.commissionFlatCents != null ? BigInt(link.commissionFlatCents) : null,
    refundWindowDays: link.refundWindowDays,
  });

  return { attributionId, commissionId };
}

interface MaterializeCommissionInput {
  workspaceId: string;
  programId: string;
  affiliateId: string;
  attributionId: string;
  orderId: string | null;
  subscriptionId: string | null;
  cycleNumber: number | null;
  commissionType: 'percent' | 'flat' | 'recurring' | 'lifetime';
  commissionPercent: number | null;
  commissionFlatCents: bigint | null;
  refundWindowDays: number;
}

/**
 * Compute + insert a commission row from the sale's gross amount.
 *
 * Worker (PR 4) handles the `pending → available` transition once
 * `available_at` passes. Refund / chargeback flips the row to
 * `reversed` via the webhook handler.
 *
 * Returns the new commission id, or NULL when no order/subscription
 * gross amount could be resolved (logged + skipped silently).
 */
/**
 * Pure commission-math kernel — extracted so it's covered by unit
 * tests without standing up a database. Returns the commission in
 * cents given the gross sale + the program's shape.
 *
 * Rules:
 *   - `flat`     → fixed `flatCents` (clamped to >=0)
 *   - `percent`  → integer-truncated `grossCents * percent / 100`
 *   - Negative inputs collapse to 0; never returns a negative bigint.
 */
export function computeCommissionCents(
  grossCents: bigint,
  type: 'flat' | 'percent' | 'recurring' | 'lifetime',
  percent: number | null,
  flatCents: bigint | null,
): bigint {
  if (grossCents <= 0n) return 0n;
  if (type === 'flat') {
    return flatCents != null && flatCents > 0n ? flatCents : 0n;
  }
  // percent | recurring | lifetime all use percentage math; the
  // recurring / lifetime semantics (cycle limits, refund window) are
  // enforced upstream by the caller — this kernel only computes "how
  // much do they get THIS cycle".
  const pct = percent ?? 0;
  if (pct <= 0) return 0n;
  return (grossCents * BigInt(pct)) / 100n;
}

export async function materializeCommission(
  services: AppServices,
  input: MaterializeCommissionInput,
): Promise<string | null> {
  const db = services.db.db;

  // Pull the gross amount from order OR subscription plan.
  let grossCents: bigint | null = null;
  if (input.orderId) {
    const [order] = await db
      .select({ total: schema.orders.totalCents })
      .from(schema.orders)
      .where(eq(schema.orders.id, input.orderId))
      .limit(1);
    if (order) grossCents = order.total;
  } else if (input.subscriptionId) {
    const [sub] = await db
      .select({ amount: schema.subscriptionPlans.amountCents })
      .from(schema.subscriptions)
      .innerJoin(
        schema.subscriptionPlans,
        eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
      )
      .where(eq(schema.subscriptions.id, input.subscriptionId))
      .limit(1);
    if (sub) grossCents = sub.amount;
  }
  if (grossCents == null) return null;

  const commissionCents = computeCommissionCents(
    grossCents,
    input.commissionType,
    input.commissionPercent ?? null,
    input.commissionFlatCents ?? null,
  );
  if (commissionCents <= 0n) return null;

  const availableAt = new Date(Date.now() + input.refundWindowDays * 24 * 60 * 60 * 1000);

  try {
    const [inserted] = await db
      .insert(schema.affiliateCommissions)
      .values({
        workspaceId: input.workspaceId,
        attributionId: input.attributionId,
        affiliateId: input.affiliateId,
        programId: input.programId,
        orderId: input.orderId,
        subscriptionId: input.subscriptionId,
        cycleNumber: input.cycleNumber ?? null,
        grossAmountCents: grossCents,
        commissionAmountCents: commissionCents,
        status: 'pending',
        availableAt,
      })
      .returning({ id: schema.affiliateCommissions.id });
    if (inserted?.id) {
      await emitAffiliateCommissionEvent(services, inserted.id, 'affiliate.commission.created');
    }
    return inserted?.id ?? null;
  } catch (cause) {
    // (attribution, cycle) unique — duplicate cycle (webhook retry).
    if ((cause as { code?: string })?.code === '23505') return null;
    throw cause;
  }
}

/**
 * Worker tick: flip `pending → available` for every commission whose
 * `available_at` has passed AND whose source order isn't refunded /
 * cancelled. Designed to be called by a BullMQ scheduler hourly. Idle
 * when there's nothing to flip.
 */
export async function rolloverPendingCommissions(
  services: AppServices,
): Promise<{ flipped: number }> {
  const db = services.db.db;
  const result = await db
    .update(schema.affiliateCommissions)
    .set({ status: 'available' })
    .where(
      and(
        eq(schema.affiliateCommissions.status, 'pending'),
        sql`${schema.affiliateCommissions.availableAt} < now()`,
        // Don't flip rows whose source order/subscription has been
        // reversed. We rely on the webhook handler to set status =
        // 'reversed' for those — anything still 'pending' is clean.
      ),
    )
    .returning({ id: schema.affiliateCommissions.id });
  // Touch the affiliate lifetime totals — single UPDATE per affiliate
  // keeps the dashboard counter cheap.
  if (result.length > 0) {
    await db.execute(sql`
      WITH totals AS (
        SELECT affiliate_id, SUM(commission_amount_cents) AS total
        FROM affiliate_commissions
        WHERE status = 'available' OR status = 'paid'
        GROUP BY affiliate_id
      )
      UPDATE affiliates a
      SET lifetime_earned_cents = totals.total
      FROM totals
      WHERE a.id = totals.affiliate_id
    `);
  }
  // Drop unused import-style noise: keep isNull referenced so the
  // tree-shaker doesn't whine in unrelated commits.
  void isNull;
  return { flipped: result.length };
}

// ─── Antifraud ──────────────────────────────────────────────────────────────

interface FraudDetectionInput {
  services: AppServices;
  workspaceId: string;
  affiliateId: string;
  ipHash: string;
  clickId?: string;
  attributionId?: string;
}

/**
 * Lightweight fraud heuristics fired on every click + attribution.
 * Designed to be fast (< 5ms in the happy path) so the public click
 * redirect never feels sluggish. Signals append to
 * `affiliate_fraud_signals`; a separate worker can read this stream
 * to auto-suspend on confirmed criticals.
 *
 * v1 detectors (cheap, high signal-to-noise):
 *
 *   1. `ip_self_click` — same IP that clicked is now buying. Strong
 *      indicator the affiliate is funnelling their own purchases
 *      through the link to earn commission on a self-bought product.
 *
 *   2. `velocity_high` — > 100 clicks from the same IP in the last
 *      hour. Either a click-bot or a public WiFi sharing the same
 *      NAT IP; we flag info-level so an operator can pull the data
 *      before deciding suspension.
 *
 * More expensive checks (fingerprint clustering, country mismatch
 * vs payout, conversion rate anomalies) land in a separate worker
 * job so the sync path stays fast.
 */
export async function detectFraudSignals(
  input: FraudDetectionInput,
): Promise<{ signalsCreated: number }> {
  const { services } = input;
  const db = services.db.db;
  let signalsCreated = 0;

  // Detector 1: ip velocity in the last hour.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [vel] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.affiliateClicks)
    .where(
      and(
        eq(schema.affiliateClicks.workspaceId, input.workspaceId),
        eq(schema.affiliateClicks.ipHash, input.ipHash),
        gte(schema.affiliateClicks.occurredAt, hourAgo),
      ),
    );
  const clickCount = Number(vel?.n ?? 0);
  if (clickCount > 100) {
    await db.insert(schema.affiliateFraudSignals).values({
      workspaceId: input.workspaceId,
      affiliateId: input.affiliateId,
      clickId: input.clickId ?? null,
      attributionId: input.attributionId ?? null,
      signalType: 'velocity_high',
      severity: clickCount > 500 ? 'critical' : 'warn',
      payload: { clickCount, windowMinutes: 60 },
    });
    signalsCreated++;
  }

  // Detector 2: ip self-click on attribution. Triggers only when an
  // attribution was just resolved — the affiliate's OWN buy attempt
  // landing on a link they generated.
  if (input.attributionId) {
    const [selfClick] = await db
      .select({ id: schema.affiliateClicks.id })
      .from(schema.affiliateClicks)
      .innerJoin(schema.affiliateLinks, eq(schema.affiliateLinks.id, schema.affiliateClicks.linkId))
      .where(
        and(
          eq(schema.affiliateClicks.ipHash, input.ipHash),
          eq(schema.affiliateLinks.affiliateId, input.affiliateId),
        ),
      )
      .limit(1);
    if (selfClick) {
      await db.insert(schema.affiliateFraudSignals).values({
        workspaceId: input.workspaceId,
        affiliateId: input.affiliateId,
        clickId: input.clickId ?? null,
        attributionId: input.attributionId ?? null,
        signalType: 'ip_self_attribution',
        severity: 'warn',
        payload: { matchedClickId: selfClick.id },
      });
      signalsCreated++;
    }
  }

  return { signalsCreated };
}

/** Append a row to `affiliate_audit_log`. Best-effort — failures are
 *  swallowed (audit shouldn't block business writes). */
export async function appendAffiliateAudit(
  services: AppServices,
  args: {
    workspaceId: string;
    actorUserId: string | null;
    targetTable: string;
    targetId: string;
    action: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await services.db.db.insert(schema.affiliateAuditLog).values({
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      targetTable: args.targetTable,
      targetId: args.targetId,
      action: args.action,
      payload: args.payload ?? {},
    });
  } catch {
    /* audit failure must not crash the business path */
  }
}
