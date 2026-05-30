import type { CryptoService } from '@payunivercart/crypto';
import { type DatabaseClient, schema } from '@payunivercart/db';
import { type CreatePixInput, type PaymentResult, getAdapter } from '@payunivercart/payments';
import type { GatewayId } from '@payunivercart/shared';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { formatBRL } from './pix-subscription-reminders';
import type { SubscriptionNotifier } from './subscription-notify';

/**
 * PIX-recurring subscription CYCLE worker.
 *
 * Companion to `pix-subscription-reminders` (which only sends
 * notifications). This worker is the one that actually GENERATES the
 * next PIX charge whenever a sub's `nextChargeAt` window opens:
 *
 *   - paymentMethod IN ('pix', 'both')
 *   - status = 'active'
 *   - currentCycleStatus = 'paid'
 *   - nextChargeAt <= now() + 4h
 *   - pixCurrentChargeId IS NULL   (no live charge yet)
 *
 * For each match we:
 *   1. Resolve the workspace's default gateway credentials.
 *   2. Compute the next cycleNumber = MAX(cycleNumber)+1 over `orders`.
 *   3. Insert a pending `orders` row (subscriptionId set, status =
 *      'pending_payment') + the matching `order_items` row.
 *   4. Call `adapter.createPix` to mint the QR.
 *   5. Insert the `transactions` row with the QR + copy-paste +
 *      expiresAt.
 *   6. Flip subscription state: pixCurrentChargeId = new tx id,
 *      currentCycleStatus = 'pending_pix'.
 *
 * The gateways webhook handler already picks up the eventual
 * `payment.updated → paid` and runs `activateSubscriptionFromPaidOrder`
 * which flips the sub back to `paid` + advances nextChargeAt. So this
 * worker only handles the "create the charge" half of the loop.
 *
 * Cadence: every 5 minutes (registered in `index.ts`). Short enough
 * that a sub due in 4h doesn't sit half a day without a QR, long
 * enough that we don't hammer MP for a workspace with thousands of
 * subscriptions.
 *
 * Idempotent: the `pixCurrentChargeId IS NULL` predicate guarantees we
 * never double-generate, and a unique (subscriptionId, cycleNumber)
 * partial index on `orders` makes a race lose at the DB layer.
 */

const BATCH_SIZE = 100;
const GENERATION_WINDOW_HOURS = 4;
const DEFAULT_PIX_EXPIRY_SECONDS = 30 * 60; // 30 min, MP default

interface SweepCtx {
  db: DatabaseClient;
  crypto: CryptoService;
  /** Public URL of THIS api — feeds the MP webhook target so the
   *  upstream IPN lands on the right host. NULL = adapter falls back
   *  to whatever URL the producer configured globally in MP. */
  apiPublicUrl?: string | null;
  /** Customer-facing dispatcher. When set, a freshly minted charge
   *  fires `subscription_renewal_due` so the buyer actually receives
   *  the new PIX copy-paste. Omitted in tests that only assert the
   *  charge/DB side effects. */
  notify?: SubscriptionNotifier;
}

export interface PixCycleSweepResult {
  candidatesScanned: number;
  chargesGenerated: number;
  errors: number;
}

export async function runPixSubscriptionCycleSweep(ctx: SweepCtx): Promise<PixCycleSweepResult> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + GENERATION_WINDOW_HOURS * 60 * 60 * 1000);
  let chargesGenerated = 0;
  let errors = 0;

  // 1. Pick due subscriptions. Join plan + product to surface
  // amount/name in one round-trip; join gateway credentials to skip
  // workspaces with no live gateway (avoids per-sub credentials probe).
  const candidates = await ctx.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      productId: schema.subscriptions.productId,
      planId: schema.subscriptions.planId,
      publicReference: schema.subscriptions.publicReference,
      customerName: schema.subscriptions.customerName,
      customerEmail: schema.subscriptions.customerEmail,
      customerDocument: schema.subscriptions.customerDocument,
      customerPhoneRaw: schema.subscriptions.customerPhoneRaw,
      customerPhoneE164: schema.subscriptions.customerPhoneE164,
      customerWahaChatId: schema.subscriptions.customerWahaChatId,
      nextChargeAt: schema.subscriptions.nextChargeAt,
      productName: schema.products.name,
      productDescription: schema.products.description,
      planName: schema.subscriptionPlans.name,
      planAmount: schema.subscriptionPlans.amountCents,
      planCurrency: schema.subscriptionPlans.currency,
      gatewayCredentialId: schema.subscriptions.gatewayCredentialId,
      gatewayId: schema.subscriptions.gatewayId,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .where(
      and(
        // 'both' subs default to whichever method last cycle used — for
        // v1 we generate PIX for both pix-only and both-mode; the
        // reminder copy already reflects PIX. Hardening (track the
        // method per cycle) can come later.
        or(
          eq(schema.subscriptions.paymentMethod, 'pix'),
          eq(schema.subscriptions.paymentMethod, 'both'),
        ),
        eq(schema.subscriptions.status, 'active'),
        eq(schema.subscriptions.currentCycleStatus, 'paid'),
        isNull(schema.subscriptions.pixCurrentChargeId),
        lte(schema.subscriptions.nextChargeAt, windowEnd),
      ),
    )
    .limit(BATCH_SIZE);

  for (const sub of candidates) {
    try {
      await generateCycleForSubscription(ctx, sub, now);
      chargesGenerated++;
    } catch (cause) {
      errors++;
      log('warn', 'pix.cycle.generate.failed', {
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { candidatesScanned: candidates.length, chargesGenerated, errors };
}

async function generateCycleForSubscription(
  ctx: SweepCtx,
  sub: {
    id: string;
    workspaceId: string;
    productId: string;
    planId: string;
    publicReference: string;
    customerName: string;
    customerEmail: string;
    customerDocument: string;
    customerPhoneRaw: string;
    customerPhoneE164: string;
    customerWahaChatId: string | null;
    nextChargeAt: Date | null;
    productName: string;
    productDescription: string | null;
    planName: string;
    planAmount: bigint;
    planCurrency: 'BRL' | 'USD' | 'EUR';
    gatewayCredentialId: string | null;
    gatewayId: GatewayId;
  },
  now: Date,
): Promise<void> {
  // Resolve gateway credentials. Prefer the credential the subscription
  // was created with; fall back to the workspace's default so a
  // producer can rotate without breaking active subs.
  const credRow = await resolveGatewayCredential(ctx, sub);
  if (!credRow) {
    throw new Error(`no_gateway_credential_workspace=${sub.workspaceId}`);
  }
  const adapter = getAdapter(credRow.gatewayId as GatewayId);
  if (!adapter.createPix) {
    throw new Error(`gateway_${credRow.gatewayId}_no_pix`);
  }
  const credentials = adapter.parseCredentials(
    ctx.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
  );

  // Next cycle = MAX(existing cycleNumber for this sub) + 1. Falls back
  // to 2 when somehow no prior order exists (defensive — subscribePix
  // always writes cycle 1).
  const [maxRow] = await ctx.db
    .select({
      maxCycle: sql<number>`COALESCE(MAX(${schema.orders.cycleNumber})::int, 0)`,
    })
    .from(schema.orders)
    .where(eq(schema.orders.subscriptionId, sub.id));
  const cycleNumber = (maxRow?.maxCycle ?? 0) + 1;
  if (cycleNumber < 2) {
    throw new Error(`cycle_underflow_sub=${sub.id}`);
  }
  const orderRef = `${sub.publicReference}-C${cycleNumber}`;

  // Insert order in pending_payment status.
  const [orderRow] = await ctx.db
    .insert(schema.orders)
    .values({
      workspaceId: sub.workspaceId,
      subscriptionId: sub.id,
      cycleNumber,
      publicReference: orderRef,
      status: 'pending_payment',
      customerName: sub.customerName,
      customerEmail: sub.customerEmail,
      customerDocument: sub.customerDocument,
      customerPhoneRaw: sub.customerPhoneRaw,
      customerPhoneE164: sub.customerPhoneE164,
      customerWahaChatId: sub.customerWahaChatId,
      subtotalCents: BigInt(sub.planAmount),
      totalCents: BigInt(sub.planAmount),
      currency: sub.planCurrency,
      metadata: { cycle: cycleNumber, paymentMethod: 'pix' },
    })
    .returning({ id: schema.orders.id });
  if (!orderRow) {
    throw new Error('order_insert_no_return');
  }
  const orderId = orderRow.id;

  await ctx.db.insert(schema.orderItems).values({
    orderId,
    productId: sub.productId,
    name: `${sub.productName} (renovação #${cycleNumber})`,
    quantity: 1,
    unitAmountCents: BigInt(sub.planAmount),
    totalCents: BigInt(sub.planAmount),
  });

  // Mint the QR.
  const webhookUrl = ctx.apiPublicUrl
    ? `${ctx.apiPublicUrl.replace(/\/$/, '')}/webhooks/gateway/${credRow.gatewayId}`
    : undefined;
  const pixInput: CreatePixInput = {
    workspaceId: sub.workspaceId,
    orderId,
    amount: { amount: Number(sub.planAmount), currency: sub.planCurrency },
    customer: {
      name: sub.customerName,
      email: sub.customerEmail,
      document: sub.customerDocument,
      phoneE164: sub.customerPhoneE164 ?? '',
    },
    description: `${sub.productName} — ${sub.planName} (ciclo ${cycleNumber})`,
    expiresInSeconds: DEFAULT_PIX_EXPIRY_SECONDS,
    idempotencyKey: `sub:${sub.id}:c${cycleNumber}`,
    metadata: {
      public_reference: orderRef,
      subscription_id: sub.id,
      cycle: cycleNumber,
    },
    webhookUrl,
  };

  let charge: PaymentResult;
  try {
    charge = await adapter.createPix(credentials as never, pixInput);
  } catch (cause) {
    // Roll back the pending order so we retry cleanly on the next tick.
    await ctx.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
    await ctx.db.delete(schema.orders).where(eq(schema.orders.id, orderId));
    throw cause;
  }

  const expiresAt =
    charge.pixExpiresAt ?? new Date(now.getTime() + DEFAULT_PIX_EXPIRY_SECONDS * 1000);
  const [txRow] = await ctx.db
    .insert(schema.transactions)
    .values({
      workspaceId: sub.workspaceId,
      orderId,
      gatewayId: credRow.gatewayId,
      gatewayChargeId: charge.gatewayChargeId,
      method: 'pix',
      status: charge.status === 'paid' ? 'paid' : 'pending',
      amountCents: BigInt(sub.planAmount),
      currency: sub.planCurrency,
      idempotencyKey: `sub:${sub.id}:c${cycleNumber}:pix`,
      pixQrCodeImage: charge.pixQrCodeImage ?? null,
      pixCopyPaste: charge.pixCopyPaste ?? null,
      expiresAt,
      rawResponse: { gatewayChargeId: charge.gatewayChargeId, cycle: cycleNumber },
    })
    .returning({ id: schema.transactions.id });
  if (!txRow) {
    throw new Error('tx_insert_no_return');
  }

  await ctx.db
    .update(schema.subscriptions)
    .set({
      pixCurrentChargeId: txRow.id,
      currentCycleStatus: 'pending_pix',
      updatedAt: now,
    })
    .where(eq(schema.subscriptions.id, sub.id));

  log('info', 'pix.cycle.generated', {
    subscriptionId: sub.id,
    cycleNumber,
    orderId,
    transactionId: txRow.id,
    gatewayChargeId: charge.gatewayChargeId,
  });

  // Deliver the fresh PIX to the buyer. Without this the charge exists
  // in the DB but nobody is told to pay it. Best-effort: a notify
  // failure must not roll back a successfully minted charge (the
  // reminder/overdue sweep re-sends from the persisted copy-paste).
  if (ctx.notify) {
    try {
      await ctx.notify({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        eventKey: 'subscription_renewal_due',
        vars: {
          nome: sub.customerName,
          produto: sub.productName,
          valor: formatBRL(sub.planAmount),
          codigo: sub.publicReference,
          link: charge.pixCopyPaste ?? '',
        },
      });
    } catch (cause) {
      log('warn', 'pix.cycle.notify.failed', {
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

async function resolveGatewayCredential(
  ctx: SweepCtx,
  sub: { workspaceId: string; gatewayCredentialId: string | null },
): Promise<{
  id: string;
  gatewayId: GatewayId;
  credentialsEncrypted: Uint8Array;
} | null> {
  // Try the credential the subscription was originally created with.
  if (sub.gatewayCredentialId) {
    const [row] = await ctx.db
      .select({
        id: schema.gatewayCredentials.id,
        gatewayId: schema.gatewayCredentials.gatewayId,
        credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
      })
      .from(schema.gatewayCredentials)
      .where(eq(schema.gatewayCredentials.id, sub.gatewayCredentialId))
      .limit(1);
    if (row) return row;
  }
  // Fall back to the workspace's current default.
  const [defaultRow] = await ctx.db
    .select({
      id: schema.gatewayCredentials.id,
      gatewayId: schema.gatewayCredentials.gatewayId,
      credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
    })
    .from(schema.gatewayCredentials)
    .where(
      and(
        eq(schema.gatewayCredentials.workspaceId, sub.workspaceId),
        eq(schema.gatewayCredentials.isDefault, true),
      ),
    )
    .orderBy(desc(schema.gatewayCredentials.createdAt))
    .limit(1);
  return defaultRow ?? null;
}

function log(level: 'info' | 'warn', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}
