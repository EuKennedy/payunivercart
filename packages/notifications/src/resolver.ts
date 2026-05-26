import { schema } from '@payunivercart/db';
import { and, eq } from 'drizzle-orm';
import {
  type NotificationChannel,
  type NotificationEventKey,
  type TemplateDefault,
  findEvent,
} from './defaults';

/**
 * Resolve a template to use for a given (workspace, event, channel).
 *
 * Resolution order:
 *   1. Workspace override row in `notification_templates` with
 *      `is_active = true`.
 *   2. Platform default in the catalogue.
 *   3. `null` when the event/channel pair has no default (e.g.
 *      `order_paid_producer` has no email default — producer-side
 *      alerts are whatsapp-only by design).
 *
 * The caller decides what to do when the resolver returns `null`:
 *   - email senders fall back to their hard-coded template
 *   - WhatsApp send paths skip dispatch
 *
 * Single round-trip + a small in-memory cache would speed up the hot
 * path, but at one fetch per sale this is cheap (single indexed
 * lookup on a tiny table). Adding caching later is mechanical.
 */

export interface ResolvedTemplate extends TemplateDefault {
  source: 'workspace_override' | 'platform_default';
}

/** Minimal `db` shape so the resolver can be called from anywhere
 *  that holds a Drizzle client without importing the heavy
 *  `DatabaseClient` wrapper. */
interface ResolverDb {
  select: (...args: unknown[]) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        limit: (n: number) => Promise<unknown[]>;
      };
    };
  };
}

export async function resolveTemplate(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's typed builder collapses to `any` once we strip generics; runtime call signature is stable.
  db: any,
  args: {
    workspaceId: string;
    eventKey: NotificationEventKey;
    channel: NotificationChannel;
  },
): Promise<ResolvedTemplate | null> {
  const [row] = await db
    .select({
      subject: schema.notificationTemplates.subject,
      body: schema.notificationTemplates.body,
    })
    .from(schema.notificationTemplates)
    .where(
      and(
        eq(schema.notificationTemplates.workspaceId, args.workspaceId),
        eq(schema.notificationTemplates.eventKey, args.eventKey),
        eq(schema.notificationTemplates.channel, args.channel),
        eq(schema.notificationTemplates.isActive, true),
      ),
    )
    .limit(1);

  if (row?.body) {
    return {
      subject: row.subject ?? null,
      body: row.body,
      source: 'workspace_override',
    };
  }

  const event = findEvent(args.eventKey);
  const fallback = event?.defaults[args.channel];
  if (!fallback) return null;

  return {
    subject: fallback.subject,
    body: fallback.body,
    source: 'platform_default',
  };
}

// Type alias kept for the explicit resolver-db contract so callers
// reading the source see what's expected even though we erase it at
// runtime.
export type { ResolverDb };
