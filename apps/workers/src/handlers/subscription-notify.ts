import { type DatabaseClient, schema } from '@payunivercart/db';
import {
  type NotificationEventKey,
  renderTemplate,
  resolveTemplate,
} from '@payunivercart/notifications';
import type { WahaChatId, WahaClient } from '@payunivercart/waha';
import { eq } from 'drizzle-orm';

/**
 * Customer-facing WhatsApp dispatcher for the PIX recurring lifecycle.
 *
 * The `pix-subscription-cycle` worker mints a fresh PIX charge each
 * renewal and the `pix-subscription-reminders` worker drives the
 * reminder/overdue/grace state machine — but both shipped with their
 * `notify` hook left null, so the customer never actually received the
 * QR copy-paste or the dunning pings. A recurring PIX sub that nobody
 * is told to pay silently slides into grace and cancels: pure
 * involuntary churn. This wires the real send.
 *
 * WhatsApp only for now — it is the channel BR buyers actually pay PIX
 * from (paste the copy-paste into the bank app) and the WAHA client is
 * already configured in the worker. Email is a follow-up once the
 * worker has the Resend env plumbed.
 *
 * Best-effort by design: a missing/disconnected WhatsApp session or a
 * number that isn't on WhatsApp is a soft skip (logged, no throw) so a
 * single bad sub never poisons the batch. Only a hard send failure
 * after the WAHA retry budget propagates, letting the sweep count it.
 */

const NOTIFY_EVENT_KEYS = [
  'subscription_renewal_reminder',
  'subscription_renewal_due',
  'subscription_renewal_overdue',
  'subscription_grace_expired',
] as const;

export type SubscriptionNotifyEventKey = (typeof NOTIFY_EVENT_KEYS)[number];

export interface SubscriptionNotifyArgs {
  workspaceId: string;
  subscriptionId: string;
  eventKey: SubscriptionNotifyEventKey;
  /** Caller-supplied template variables. `brand` and `link` are filled
   *  in here when absent, so handlers don't have to join workspaces or
   *  re-read the active charge. */
  vars: Record<string, string>;
}

export type SubscriptionNotifier = (args: SubscriptionNotifyArgs) => Promise<void>;

interface NotifierDeps {
  db: DatabaseClient;
  waha: WahaClient;
}

function log(level: 'info' | 'warn', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}

/**
 * Build the `notify` closure both PIX workers accept. Resolves the
 * workspace WhatsApp session, the buyer's chatId, the workspace brand,
 * and (when the caller left it blank) the active charge's copy-paste
 * link, then renders the workspace override or platform default and
 * sends with the shared retry layer.
 */
export function createSubscriptionNotifier(deps: NotifierDeps): SubscriptionNotifier {
  const { db, waha } = deps;

  return async function notify(args: SubscriptionNotifyArgs): Promise<void> {
    const { workspaceId, subscriptionId, eventKey } = args;

    // 1. Buyer contact + the charge we may need a link from.
    const [sub] = await db
      .select({
        customerPhoneE164: schema.subscriptions.customerPhoneE164,
        customerWahaChatId: schema.subscriptions.customerWahaChatId,
        pixCurrentChargeId: schema.subscriptions.pixCurrentChargeId,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) {
      log('warn', 'subscription.notify.skip', {
        subscriptionId,
        eventKey,
        reason: 'subscription_missing',
      });
      return;
    }

    // 2. Brand + link enrichment. `companyName` is the producer's brand;
    //    falls back to the workspace name (same rule the checkout uses).
    const [ws] = await db
      .select({ name: schema.workspaces.name, companyName: schema.workspaces.companyName })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const brand = ws?.companyName?.trim() || ws?.name || 'Univercart';

    let link = args.vars.link ?? '';
    if (!link && sub.pixCurrentChargeId) {
      const [tx] = await db
        .select({ copyPaste: schema.transactions.pixCopyPaste })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, sub.pixCurrentChargeId))
        .limit(1);
      if (tx?.copyPaste) link = tx.copyPaste;
    }
    const vars: Record<string, string> = { ...args.vars, brand, link };

    // 3. Resolve the workspace WhatsApp session. No session / not
    //    WORKING → soft skip; the producer sees the disconnected state
    //    in their dashboard and the next sweep retries once reconnected.
    const [sessionRow] = await db
      .select({ sessionName: schema.whatsappSessions.wahaSessionId })
      .from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.workspaceId, workspaceId))
      .limit(1);
    if (!sessionRow) {
      log('warn', 'subscription.notify.skip', {
        subscriptionId,
        eventKey,
        reason: 'whatsapp_session_missing',
      });
      return;
    }
    const sessionName = sessionRow.sessionName;

    let sessionStatus: string;
    try {
      sessionStatus = await waha.getSessionStatus(sessionName);
    } catch (cause) {
      log('warn', 'subscription.notify.skip', {
        subscriptionId,
        eventKey,
        reason: 'session_unreachable',
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (sessionStatus !== 'WORKING') {
      log('warn', 'subscription.notify.skip', {
        subscriptionId,
        eventKey,
        reason: `session_status:${sessionStatus}`,
      });
      return;
    }

    // 4. Resolve chatId. Prefer the cached value; otherwise canonicalise
    //    via WAHA check-exists (handles BR 10/11-digit ambiguity) and
    //    write it back so later sends skip the round-trip.
    let chatId = (sub.customerWahaChatId ?? null) as WahaChatId | null;
    if (!chatId) {
      const digits = sub.customerPhoneE164.replace(/\D/g, '');
      if (digits.length < 8) {
        log('warn', 'subscription.notify.skip', {
          subscriptionId,
          eventKey,
          reason: 'invalid_phone',
        });
        return;
      }
      try {
        const probe = await waha.checkExists(digits, sessionName);
        if (!probe.numberExists) {
          log('info', 'subscription.notify.skip', {
            subscriptionId,
            eventKey,
            reason: 'number_not_on_whatsapp',
          });
          return;
        }
        chatId = (probe.chatId ?? null) as WahaChatId | null;
        if (chatId) {
          await db
            .update(schema.subscriptions)
            .set({ customerWahaChatId: chatId })
            .where(eq(schema.subscriptions.id, subscriptionId));
        }
      } catch (cause) {
        log('warn', 'subscription.notify.skip', {
          subscriptionId,
          eventKey,
          reason: 'check_exists_failed',
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }
    }
    if (!chatId) return;

    // 5. Render workspace override or platform default. Skip the send
    //    when a referenced placeholder didn't resolve — leaking a raw
    //    `{var}` to the buyer is worse than missing one message.
    const resolved = await resolveTemplate(db, {
      workspaceId,
      eventKey: eventKey as NotificationEventKey,
      channel: 'whatsapp',
    });
    if (!resolved) {
      log('warn', 'subscription.notify.skip', { subscriptionId, eventKey, reason: 'no_template' });
      return;
    }
    const rendered = renderTemplate({ subject: null, body: resolved.body }, vars);
    if (!rendered.body.trim() || rendered.missingVariables.length > 0) {
      log('warn', 'subscription.notify.skip', {
        subscriptionId,
        eventKey,
        reason: 'template_incomplete',
        missing: rendered.missingVariables,
      });
      return;
    }

    // 6. Send. A hard failure after the retry budget throws — the
    //    caller's sweep counts it as an error.
    await waha.sendTextWithRetry(
      { session: sessionName, chatId, text: rendered.body, linkPreview: false },
      {
        onAttempt: (attempt, err) =>
          log('warn', 'subscription.notify.retry', {
            subscriptionId,
            eventKey,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          }),
      },
    );
    log('info', 'subscription.notify.sent', { subscriptionId, eventKey });
  };
}
