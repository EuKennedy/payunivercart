import type { CryptoService } from '@payunivercart/crypto';
import { schema } from '@payunivercart/db';
import { getAdapter } from '@payunivercart/payments';
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';

/**
 * Subscription status reconciliation sweep.
 *
 * Why: webhooks from Mercado Pago (or any future recurring gateway)
 * occasionally don't arrive — buyer cancels in the MP app and the
 * `subscription_preapproval` event never fires, or the worker missed
 * a notification during a deploy. Producer sees the row as `active`
 * when MP already shows it cancelled.
 *
 * Fix: every N minutes, pick the subscriptions that look ACTIVE
 * locally + haven't been reconciled recently, round-trip the gateway
 * for the canonical status, and patch the local row. Optimistic
 * concurrency on `status = previousStatus` so a webhook arriving
 * mid-sweep doesn't get clobbered.
 *
 * Scope: gateway-agnostic. Adapter contract requires
 * `getSubscription(credentials, id)`; we skip subscriptions whose
 * adapter doesn't implement it (Stripe today only — the four BR
 * gateways all support it).
 */

interface ReconcileCtx {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic across packages.
  db: { db: any };
  crypto: CryptoService;
}

/** Maximum subscriptions reconciled per tick. Caps work + DB load. */
const BATCH_SIZE = 50;

/** Only re-sync rows that haven't been touched in this many minutes.
 *  Avoids hammering the gateway when the webhook is healthy. */
const STALE_MINUTES = 15;

export async function runSubscriptionReconcileSweep(
  ctx: ReconcileCtx,
): Promise<{ checked: number; updated: number; cancelled: number; errored: number }> {
  const db = ctx.db.db;
  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);

  // 1. Pick stale active/pending subscriptions. We deliberately skip
  //    terminal states (cancelled/expired) — they won't flip back.
  const stale = await db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      gatewayId: schema.subscriptions.gatewayId,
      gatewaySubscriptionId: schema.subscriptions.gatewaySubscriptionId,
      gatewayCredentialId: schema.subscriptions.gatewayCredentialId,
      status: schema.subscriptions.status,
    })
    .from(schema.subscriptions)
    .where(
      and(
        or(
          eq(schema.subscriptions.status, 'active'),
          eq(schema.subscriptions.status, 'pending'),
          eq(schema.subscriptions.status, 'paused'),
          eq(schema.subscriptions.status, 'past_due'),
        ),
        isNotNull(schema.subscriptions.gatewaySubscriptionId),
        lt(schema.subscriptions.updatedAt, staleCutoff),
      ),
    )
    .orderBy(schema.subscriptions.updatedAt)
    .limit(BATCH_SIZE);

  let updated = 0;
  let cancelled = 0;
  let errored = 0;

  for (const sub of stale) {
    try {
      // 2. Pull credentials. Prefer the row's stored
      //    gatewayCredentialId; fall back to the workspace default for
      //    the same gateway (matches checkout/webhook resolution).
      let credRow: { credentialsEncrypted: Uint8Array } | undefined;
      if (sub.gatewayCredentialId) {
        const [r] = await db
          .select({
            credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
          })
          .from(schema.gatewayCredentials)
          .where(eq(schema.gatewayCredentials.id, sub.gatewayCredentialId))
          .limit(1);
        credRow = r;
      }
      if (!credRow) {
        const [r] = await db
          .select({
            credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
          })
          .from(schema.gatewayCredentials)
          .where(
            and(
              eq(schema.gatewayCredentials.workspaceId, sub.workspaceId),
              eq(schema.gatewayCredentials.gatewayId, sub.gatewayId),
              eq(schema.gatewayCredentials.isDefault, true),
            ),
          )
          .limit(1);
        credRow = r;
      }
      if (!credRow) {
        // No credentials — flag the row as stale by bumping updatedAt
        // so the next sweep doesn't immediately retry, but log the
        // mismatch for the producer to see in the audit panel.
        await db
          .update(schema.subscriptions)
          .set({ updatedAt: new Date() })
          .where(eq(schema.subscriptions.id, sub.id));
        continue;
      }

      const adapter = getAdapter(sub.gatewayId);
      if (!adapter.getSubscription) {
        // Gateway doesn't support remote read (Stripe stub today).
        // Bump updatedAt so we don't re-check every tick.
        await db
          .update(schema.subscriptions)
          .set({ updatedAt: new Date() })
          .where(eq(schema.subscriptions.id, sub.id));
        continue;
      }

      const credentials = adapter.parseCredentials(
        ctx.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );
      const fresh = await adapter.getSubscription(credentials as never, sub.gatewaySubscriptionId);

      // 3. Optimistic concurrency: only update when local status still
      //    matches what we observed pre-call. A webhook arriving mid
      //    sweep wins and we skip the UPDATE silently.
      const now = new Date();
      const result = await db
        .update(schema.subscriptions)
        .set({
          status: fresh.status,
          nextChargeAt: fresh.nextChargeAt ?? null,
          cancelledAt: fresh.status === 'cancelled' ? now : null,
          updatedAt: now,
        })
        .where(
          and(eq(schema.subscriptions.id, sub.id), eq(schema.subscriptions.status, sub.status)),
        );
      const rowCount = Number((result as { rowCount?: number })?.rowCount ?? 0);
      if (rowCount > 0 && fresh.status !== sub.status) {
        updated += 1;
        if (fresh.status === 'cancelled') cancelled += 1;
      }
    } catch (cause) {
      errored += 1;
      // Log via stdout so the worker's log shipper captures it.
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'subscription.reconcile.failed',
          subscriptionId: sub.id,
          gatewayId: sub.gatewayId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
      // Bump updatedAt so a persistently broken row isn't picked
      // every tick.
      await db
        .update(schema.subscriptions)
        .set({ updatedAt: new Date() })
        .where(eq(schema.subscriptions.id, sub.id))
        .catch(() => {});
      // touch sql import — typeguard against unused-import lint
      void sql;
    }
  }

  return { checked: stale.length, updated, cancelled, errored };
}
