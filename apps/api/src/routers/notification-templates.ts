import { schema } from '@payunivercart/db';
import {
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEventKey,
  findEvent,
  renderTemplate,
  resolveTemplate,
} from '@payunivercart/notifications';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Producer-facing template editor — CRUD over `notification_templates`.
 *
 * Surface:
 *   - `catalog`   read-only list of every event the platform exposes,
 *                 returned with the workspace's current override (or
 *                 the platform default) per channel. Powers the
 *                 editor UI without a second fetch per card.
 *   - `upsert`    save/replace a (event, channel) override. ON
 *                 CONFLICT DO UPDATE on the unique index keeps the
 *                 mutation idempotent — clicking "Salvar" twice never
 *                 creates two rows.
 *   - `reset`     delete the override row, falling back to the
 *                 platform default on the next dispatch.
 *   - `preview`   pure render of a template with sample values, used
 *                 by the editor's live preview pane. No DB write.
 *
 * Every endpoint runs inside `workspaceProcedure` so the tenant
 * predicate is enforced both here (defence-in-depth) and through RLS.
 */

// ─── Shared zod shapes ───────────────────────────────────────────────────────

const EventKey = z.enum([
  'order_paid_buyer',
  'order_paid_producer',
  'subscription_activated_buyer',
  'subscription_activated_producer',
  'entitlement_granted',
  'cart_recovery',
  'subscription_renewal_reminder',
  'subscription_renewal_due',
  'subscription_renewal_overdue',
  'subscription_grace_expired',
]);
const Channel = z.enum(['email', 'whatsapp']);

const TemplateRow = z.object({
  eventKey: EventKey,
  channel: Channel,
  /** Null when no platform default exists for this (event, channel)
   *  pair — UI hides the customise card in that case. */
  subject: z.string().nullable(),
  body: z.string(),
  isCustom: z.boolean(),
  /** Always true when a workspace_override exists; redundant with
   *  `isCustom` for the email + whatsapp channels but kept distinct
   *  so a producer can save the override and toggle it off without
   *  losing the copy. */
  isActive: z.boolean(),
});

const EventCard = z.object({
  key: EventKey,
  title: z.string(),
  description: z.string(),
  variables: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      sample: z.string(),
    }),
  ),
  templates: z.array(TemplateRow),
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const notificationTemplatesRouter = router({
  /**
   * Catalog — every event + every channel default, merged with the
   * workspace's overrides into a single round-trip.
   */
  catalog: workspaceProcedure.output(z.array(EventCard)).query(async ({ ctx }) => {
    // Only `is_active = true` overrides participate — mirrors the
    // resolver's lookup so the UI never tells the producer "your
    // template is live" while the dispatcher quietly falls back to
    // the platform default.
    const overrides = await ctx.services.db.db
      .select({
        eventKey: schema.notificationTemplates.eventKey,
        channel: schema.notificationTemplates.channel,
        subject: schema.notificationTemplates.subject,
        body: schema.notificationTemplates.body,
        isActive: schema.notificationTemplates.isActive,
      })
      .from(schema.notificationTemplates)
      .where(
        and(
          eq(schema.notificationTemplates.workspaceId, ctx.workspaceId),
          eq(schema.notificationTemplates.isActive, true),
        ),
      );

    // Map (event,channel) → override for O(1) merge below.
    const overrideMap = new Map<
      string,
      { subject: string | null; body: string; isActive: boolean }
    >();
    for (const o of overrides) {
      overrideMap.set(`${o.eventKey}|${o.channel}`, {
        subject: o.subject ?? null,
        body: o.body,
        isActive: o.isActive,
      });
    }

    return NOTIFICATION_EVENTS.map((event) => ({
      key: event.key,
      title: event.title,
      description: event.description,
      variables: event.variables,
      templates: (['email', 'whatsapp'] as const)
        .filter((channel) => event.defaults[channel] != null)
        .map((channel) => {
          const override = overrideMap.get(`${event.key}|${channel}`);
          const def = event.defaults[channel];
          if (override) {
            return {
              eventKey: event.key,
              channel,
              subject: override.subject,
              body: override.body,
              isCustom: true,
              isActive: override.isActive,
            };
          }
          return {
            eventKey: event.key,
            channel,
            subject: def?.subject ?? null,
            body: def?.body ?? '',
            isCustom: false,
            isActive: true,
          };
        }),
    }));
  }),

  /**
   * Save or replace an override. Subject is enforced as a non-empty
   * string for email and ignored for whatsapp; body is required for
   * both channels. Validation rejects events/channels that aren't in
   * the catalogue or whose channel has no default — keeps the table
   * from collecting rows the renderer never consults.
   */
  upsert: workspaceProcedure
    .input(
      z
        .object({
          eventKey: EventKey,
          channel: Channel,
          subject: z.string().trim().max(180).nullable().optional(),
          body: z.string().trim().min(1).max(8000),
          isActive: z.boolean().optional().default(true),
        })
        .superRefine((value, ctx) => {
          // Email channel: subject is required + non-whitespace after
          // trim. Whatsapp channel: subject must be null (or undefined)
          // — passing a non-null value would silently get dropped which
          // is more surprising than an explicit error.
          if (value.channel === 'email') {
            if (!value.subject || value.subject.trim().length === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['subject'],
                message: 'Assunto é obrigatório para templates de e-mail.',
              });
            }
          } else if (value.subject != null && value.subject.trim().length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['subject'],
              message: 'WhatsApp não tem assunto — envie null ou omita o campo.',
            });
          }
        }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const event = findEvent(input.eventKey);
      if (!event || !event.defaults[input.channel]) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Esse evento + canal não suporta personalização.',
        });
      }
      // After superRefine + trim: email always has a non-empty subject,
      // whatsapp always has null.
      const subject = input.channel === 'email' ? (input.subject?.trim() ?? null) : null;

      await ctx.services.db.db
        .insert(schema.notificationTemplates)
        .values({
          workspaceId: ctx.workspaceId,
          eventKey: input.eventKey,
          channel: input.channel,
          subject,
          body: input.body,
          isActive: input.isActive,
        })
        .onConflictDoUpdate({
          target: [
            schema.notificationTemplates.workspaceId,
            schema.notificationTemplates.eventKey,
            schema.notificationTemplates.channel,
          ],
          set: {
            subject,
            body: input.body,
            isActive: input.isActive,
            updatedAt: new Date(),
          },
        });
      return { ok: true as const };
    }),

  /**
   * Remove the override and fall back to the platform default on the
   * next dispatch. Idempotent — deleting a row that doesn't exist
   * still returns ok.
   */
  reset: workspaceProcedure
    .input(z.object({ eventKey: EventKey, channel: Channel }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .delete(schema.notificationTemplates)
        .where(
          and(
            eq(schema.notificationTemplates.workspaceId, ctx.workspaceId),
            eq(schema.notificationTemplates.eventKey, input.eventKey),
            eq(schema.notificationTemplates.channel, input.channel),
          ),
        );
      return { ok: true as const };
    }),

  /**
   * Live preview — renders the producer's current draft (or the
   * effective resolved template when no draft is provided) with the
   * sample values declared per event. Pure read; no rows touched.
   */
  preview: workspaceProcedure
    .input(
      z.object({
        eventKey: EventKey,
        channel: Channel,
        /** Optional unsaved draft — when present, renders that instead
         *  of the persisted template so the editor can show preview
         *  without forcing a save. */
        draft: z
          .object({
            subject: z.string().nullable().optional(),
            body: z.string(),
          })
          .optional(),
      }),
    )
    .output(
      z.object({
        subject: z.string().nullable(),
        body: z.string(),
        missingVariables: z.array(z.string()),
        source: z.enum(['workspace_override', 'platform_default', 'draft']),
      }),
    )
    .query(async ({ ctx, input }) => {
      const event = findEvent(input.eventKey);
      if (!event) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Evento desconhecido.' });
      }
      const sampleVars = Object.fromEntries(event.variables.map((v) => [v.key, v.sample]));

      // Draft path bypasses DB lookup entirely.
      if (input.draft) {
        const rendered = renderTemplate(
          { subject: input.draft.subject ?? null, body: input.draft.body },
          sampleVars,
        );
        return { ...rendered, source: 'draft' as const };
      }

      const resolved = await resolveTemplate(ctx.services.db.db, {
        workspaceId: ctx.workspaceId,
        eventKey: input.eventKey as NotificationEventKey,
        channel: input.channel as NotificationChannel,
      });
      if (!resolved) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Esse evento + canal não tem template padrão configurado.',
        });
      }
      const rendered = renderTemplate(
        { subject: resolved.subject, body: resolved.body },
        sampleVars,
      );
      return { ...rendered, source: resolved.source };
    }),
});
