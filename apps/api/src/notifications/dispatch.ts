import {
  type NotificationChannel,
  type NotificationEventKey,
  renderTemplate,
  resolveTemplate,
} from '@payunivercart/notifications';
import type { WahaChatId } from '@payunivercart/waha';
import type { AppServices } from '../services';

/**
 * Thin wrappers around the email + WhatsApp send paths that consult
 * `notification_templates` before dispatch. When the resolver finds a
 * workspace override we render + send that; when it doesn't, the
 * caller's fallback closure runs (preserving every existing platform
 * default verbatim).
 *
 * Pattern: each call site already has every variable it needs to
 * render either flavour. Wrapping the send with these helpers means
 * we don't duplicate the template-lookup boilerplate everywhere, and
 * keeps the customisation layer optional — if `@payunivercart/notifications`
 * disappears tomorrow the fallback runs and life goes on.
 */

interface DispatchCtx {
  services: AppServices;
  workspaceId: string;
  eventKey: NotificationEventKey;
  vars: Record<string, string | null | undefined>;
}

interface EmailDispatchInput extends DispatchCtx {
  to: string;
  brand: string;
  /** Closure that runs when no workspace override exists. Receives
   *  the platform-default template (rendered with the same vars) so
   *  the caller can decide whether to dispatch raw or fall through to
   *  the legacy per-event `sendOrderPaid`-style method. */
  fallback: () => Promise<void>;
}

export async function dispatchEmailNotification(input: EmailDispatchInput): Promise<void> {
  const resolved = await resolveTemplate(input.services.db.db, {
    workspaceId: input.workspaceId,
    eventKey: input.eventKey,
    channel: 'email',
  });
  if (!resolved || resolved.source === 'platform_default') {
    // Default path → caller's legacy method keeps its richer layout
    // (delivery-card block, brand colours, etc). Override path goes
    // through `sendCustom` so producers can fully rewrite the copy.
    await input.fallback();
    return;
  }
  const rendered = renderTemplate(
    { subject: resolved.subject ?? '', body: resolved.body },
    input.vars,
  );
  // Safety net 1: an unresolved placeholder leaks `{var}` into the
  // outbound message. The renderer reports these in `missingVariables`;
  // when the producer's template references a variable we didn't
  // supply, we'd rather ship the platform default than send
  // `Pedido {codigo}` to the customer.
  if (rendered.missingVariables.length > 0) {
    await input.fallback();
    return;
  }
  // Safety net 2: empty subject / body (shouldn't happen — upsert
  // enforces min(1) — but defence-in-depth).
  if (!rendered.subject?.trim() || !rendered.body.trim()) {
    await input.fallback();
    return;
  }
  await input.services.emails.sendCustom({
    to: input.to,
    subject: rendered.subject,
    bodyText: rendered.body,
    brand: input.brand,
  });
}

interface WhatsappDispatchInput extends DispatchCtx {
  sessionName: string;
  chatId: WahaChatId;
  linkPreview?: boolean;
  fallbackText: string;
}

export async function dispatchWhatsappNotification(input: WhatsappDispatchInput): Promise<void> {
  const resolved = await resolveTemplate(input.services.db.db, {
    workspaceId: input.workspaceId,
    eventKey: input.eventKey,
    channel: 'whatsapp',
  });
  let text = input.fallbackText;
  if (resolved && resolved.source === 'workspace_override') {
    const rendered = renderTemplate({ subject: null, body: resolved.body }, input.vars);
    // Use the rendered body only when it's non-empty AND every
    // referenced placeholder resolved. An unresolved `{var}` leaks
    // template internals to the customer — fall back to the platform
    // default instead.
    if (rendered.body.trim() && rendered.missingVariables.length === 0) {
      text = rendered.body;
    }
  }
  // Retry layer: 3 attempts with 0.5s/2s/8s backoff on transient
  // failures (5xx, 429, timeouts). Without this a single WAHA blip
  // during a deploy would silently drop the notification — and the
  // outer caller's catch-only-log pattern hides the failure from the
  // producer dashboard.
  await input.services.waha.sendTextWithRetry(
    {
      session: input.sessionName,
      chatId: input.chatId,
      text,
      linkPreview: input.linkPreview ?? false,
    },
    {
      onAttempt: (attempt, err) => {
        process.stdout.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'whatsapp.dispatch.retry',
            workspaceId: input.workspaceId,
            eventKey: input.eventKey,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      },
    },
  );
}

/** Re-exported to keep import sites in webhook handlers clean. */
export type { NotificationEventKey, NotificationChannel };
