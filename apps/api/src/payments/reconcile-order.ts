import { schema } from '@payunivercart/db';
import { getAdapter } from '@payunivercart/payments';
import { and, eq } from 'drizzle-orm';
import type { AppServices } from '../services';
import { emitOrderEvent, emitTransactionEvent } from '../webhooks/emit-helpers';
import {
  activateSubscriptionFromPaidOrder,
  dispatchPaidFanOut,
  dispatchPurchaseTrackingEvent,
} from '../webhooks/gateways';

/**
 * Active payment reconciliation — the webhook-independent settle path.
 *
 * The gateway webhook is best-effort: it can be rejected (producer
 * forgot to configure the signing secret), lost (network blip), or
 * arrive before the transaction row exists (race). Relying on it alone
 * means a buyer can pay a PIX QR and the order stays `pending_payment`
 * forever — exactly the failure that motivated this module.
 *
 * `reconcileOrderPayment` round-trips the gateway with `getCharge` and,
 * when the charge reads `paid`, runs the SAME settle pipeline the
 * webhook handler runs (mark tx + order paid, fan-out, tracking,
 * subscription activation + Connect entitlement). It's:
 *
 *   - **Idempotent**: a second call on an already-paid order is a
 *     cheap no-op (returns early before touching the gateway).
 *   - **Self-contained**: callers don't need credentials or adapters;
 *     this resolves them from the owning workspace.
 *   - **Safe to spam**: the checkout polling loop, the reconcile
 *     worker, and the admin "force-confirm" button all call it.
 *
 * Returns `{ settled: true }` when the order is (now or already) paid,
 * `{ settled: false, gatewayStatus }` when the gateway still reports a
 * non-paid state, and `{ settled: false, reason }` when reconciliation
 * could not run (no transaction, missing credentials, gateway error).
 */
export type ReconcileResult =
  | { settled: true; alreadyPaid: boolean }
  | { settled: false; gatewayStatus?: string; reason?: string };

export async function reconcileOrderPayment(
  services: AppServices,
  orderId: string,
): Promise<ReconcileResult> {
  const { db } = services.db;

  // 1. Load order + its most-recent transaction in one round-trip.
  const [row] = await db
    .select({
      orderStatus: schema.orders.status,
      workspaceId: schema.orders.workspaceId,
      txId: schema.transactions.id,
      gatewayId: schema.transactions.gatewayId,
      gatewayChargeId: schema.transactions.gatewayChargeId,
      txStatus: schema.transactions.status,
    })
    .from(schema.orders)
    .leftJoin(schema.transactions, eq(schema.transactions.orderId, schema.orders.id))
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!row) return { settled: false, reason: 'order_not_found' };

  // 2. Idempotent short-circuit — already settled, nothing to do.
  if (row.orderStatus === 'paid') return { settled: true, alreadyPaid: true };

  // 3. Can't reconcile without a gateway charge id.
  if (!row.txId || !row.gatewayChargeId || !row.gatewayId) {
    return { settled: false, reason: 'no_gateway_charge' };
  }

  // 4. Decrypt the workspace's default gateway credentials.
  const [credRow] = await db
    .select({ credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted })
    .from(schema.gatewayCredentials)
    .where(
      and(
        eq(schema.gatewayCredentials.workspaceId, row.workspaceId),
        eq(schema.gatewayCredentials.gatewayId, row.gatewayId),
        eq(schema.gatewayCredentials.isDefault, true),
      ),
    )
    .limit(1);
  if (!credRow) return { settled: false, reason: 'no_credentials' };

  const adapter = getAdapter(row.gatewayId);
  let credentials: unknown;
  try {
    credentials = adapter.parseCredentials(
      services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
    );
  } catch {
    return { settled: false, reason: 'credential_decode_failed' };
  }

  // 5. Round-trip the gateway for the canonical charge status.
  let charge: Awaited<ReturnType<typeof adapter.getCharge>>;
  try {
    charge = await adapter.getCharge(credentials as never, row.gatewayChargeId);
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'reconcile.getCharge.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
    return { settled: false, reason: 'gateway_error' };
  }

  if (charge.status !== 'paid') {
    return { settled: false, gatewayStatus: charge.status };
  }

  // 6. Charge is paid on the gateway but our order is still pending —
  //    run the full settle pipeline (same as the webhook handler).
  const nowDate = new Date();
  await db
    .update(schema.transactions)
    .set({ status: 'paid', paidAt: nowDate, rawResponse: charge.raw as object })
    .where(eq(schema.transactions.id, row.txId));
  await db
    .update(schema.orders)
    .set({ status: 'paid', paidAt: nowDate })
    .where(eq(schema.orders.id, orderId));

  // Outbound webhooks (best-effort, non-throwing internally).
  await emitTransactionEvent(services, row.txId, 'transaction.captured');
  await emitOrderEvent(services, orderId, 'order.paid');

  // Receipt email + buyer/producer WhatsApp.
  await dispatchPaidFanOut(services, orderId);

  // Pilar 2 tracking — best-effort.
  try {
    await dispatchPurchaseTrackingEvent(services, row.workspaceId, orderId);
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'reconcile.tracking.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  // Subscription activation (PIX-recurring) + Connect entitlement.
  try {
    await activateSubscriptionFromPaidOrder(services, orderId, nowDate);
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'reconcile.subscription.activate.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: 'reconcile.order.settled',
      orderId,
      gatewayChargeId: row.gatewayChargeId,
    })}\n`,
  );

  return { settled: true, alreadyPaid: false };
}
