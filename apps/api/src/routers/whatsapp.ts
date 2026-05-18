import { schema, withWorkspace } from '@payunivercart/db';
import type { WahaClient } from '@payunivercart/waha';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * WhatsApp integration router. Multi-tenant: one workspace owns one
 * WAHA session. The session NAME is now producer-chosen (instead of
 * the previous auto-derived `ws_<workspaceId>`) so the WAHA backoffice
 * shows a human-readable identifier and the producer can recreate a
 * fresh session after a FAILED state.
 *
 * Engine: WEBJS — the production WAHA instance runs WEBJS by default;
 * it ships every feature we use (presence, ack receipts, typing).
 */

/**
 * Session name rules:
 *   - WAHA accepts `^[A-Za-z0-9_-]+$` and trims to ≤ 60 chars.
 *   - We tighten to 3-40 chars and BR-friendly characters so the
 *     producer types something memorable (e.g. "vendas-loja-bh").
 */
const sessionNameInput = z
  .string()
  .trim()
  .min(3, 'Mínimo 3 caracteres.')
  .max(40, 'Máximo 40 caracteres.')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Use apenas letras, números, hífen ou underline.');

const StatusEnum = z.enum(['STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'STOPPED']);

export const whatsappRouter = router({
  /**
   * Current session record for the workspace. Returns `null` when the
   * producer hasn't configured a session name yet — the dashboard
   * shows the "name your session + connect" form in that case.
   */
  me: workspaceProcedure
    .output(
      z
        .object({
          sessionName: z.string(),
          phoneNumber: z.string().nullable(),
          createdAt: z.date(),
        })
        .nullable(),
    )
    .query(async ({ ctx }) => {
      const [row] = await ctx.services.db.db
        .select({
          sessionName: schema.whatsappSessions.wahaSessionId,
          phoneNumber: schema.whatsappSessions.phoneNumber,
          createdAt: schema.whatsappSessions.createdAt,
        })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      return row ?? null;
    }),

  /**
   * Create the session in WAHA AND in our local mirror.
   *
   * Refuses when the workspace already owns a session — producer must
   * `reset` first. Refuses when the requested name collides with
   * another workspace's session (unique index on `wahaSessionId`).
   */
  start: workspaceProcedure
    .input(z.object({ name: sessionNameInput }))
    .output(
      z.object({
        sessionName: z.string(),
        status: StatusEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { waha, db } = ctx.services;

      // Block if the workspace already has a session — force explicit
      // `reset` so we don't accidentally clobber a WORKING session.
      const existing = await db.db
        .select({ id: schema.whatsappSessions.id })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      if (existing.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Workspace já tem uma sessão. Use "Recomeçar" para criar outra.',
        });
      }

      const status = await ensureWahaSessionStarted(waha, input.name);

      await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
        await tx
          .insert(schema.whatsappSessions)
          .values({
            workspaceId: ctx.workspaceId,
            wahaSessionId: input.name,
            status,
          })
          .onConflictDoUpdate({
            target: schema.whatsappSessions.workspaceId,
            set: { wahaSessionId: input.name, status },
          });
      });

      return { sessionName: input.name, status };
    }),

  /**
   * Retry the existing session WITHOUT requiring the producer to retype
   * the name. Used by the "Tentar novamente" CTA on the FAILED card.
   *
   * Sequence: delete WAHA session (clears WEBJS chromium state) →
   * brief settle wait (WAHA Plus rate-limits delete→create cycles) →
   * recreate with same name → update mirror status to STARTING.
   *
   * This is intentionally separate from `reset`: reset wipes the local
   * row so the producer can change the session name. Retry keeps the
   * name and the row, only the WAHA-side state is recycled.
   */
  retry: workspaceProcedure
    .output(
      z.object({
        sessionName: z.string(),
        status: StatusEnum,
      }),
    )
    .mutation(async ({ ctx }) => {
      const { waha, db } = ctx.services;
      const [row] = await db.db
        .select({ sessionName: schema.whatsappSessions.wahaSessionId })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Nenhuma sessão para retomar. Crie uma nova com "Conectar".',
        });
      }

      // Hard-delete WAHA session — clears chromium state for WEBJS so
      // the recreate gets a fresh QR. Tolerates 404 (already deleted).
      await waha.deleteSession(row.sessionName).catch(() => {
        /* noop: deleteSession already absorbs 404 */
      });

      // WAHA Plus needs ~1s after a WEBJS session DELETE before it
      // accepts a fresh CREATE with the same name. Without the wait,
      // we hit 422 "session exists" because the cleanup is still in
      // flight. Empirically 1s clears the race on a hot WAHA process.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const status = await ensureWahaSessionStarted(waha, row.sessionName);

      await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
        await tx
          .update(schema.whatsappSessions)
          .set({
            status,
            phoneNumber: null,
            connectedAt: null,
            disconnectedAt: null,
            qrLastIssuedAt: null,
          })
          .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId));
      });

      return { sessionName: row.sessionName, status };
    }),

  /**
   * Cheap status read. Polled by the dashboard every ~3s while the
   * session is transient (STARTING / SCAN_QR_CODE). Returns null when
   * no session is configured (the dashboard renders the connect form).
   */
  status: workspaceProcedure
    .output(
      z
        .object({
          sessionName: z.string(),
          status: StatusEnum,
          phoneNumber: z.string().nullable(),
        })
        .nullable(),
    )
    .query(async ({ ctx }) => {
      const [row] = await ctx.services.db.db
        .select({
          sessionName: schema.whatsappSessions.wahaSessionId,
          phoneNumber: schema.whatsappSessions.phoneNumber,
        })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      if (!row) return null;

      let status: z.infer<typeof StatusEnum>;
      try {
        status = await ctx.services.waha.getSessionStatus(row.sessionName);
      } catch (cause) {
        const err = cause as { details?: { status?: number } };
        // WAHA returns 404 when the session was deleted from its side
        // but we still have the mirror row. Treat as FAILED so the UI
        // surfaces a "Recomeçar" button.
        if (err?.details?.status === 404) {
          return { sessionName: row.sessionName, status: 'FAILED', phoneNumber: row.phoneNumber };
        }
        throw cause;
      }

      return { sessionName: row.sessionName, status, phoneNumber: row.phoneNumber };
    }),

  /**
   * Return the QR-code data for the producer to scan. Polled every
   * ~5s while the session is in SCAN_QR_CODE (WAHA rotates the QR).
   *
   * Returns `null` when WAHA hasn't rendered a QR yet (session is in
   * STARTING or the engine is still booting Chromium). The dashboard
   * shows a "Aguardando QR…" placeholder in that case and keeps
   * polling — throwing here would make the QrBox flicker on each
   * 5s tick during the 10-30s WEBJS boot window.
   */
  qr: workspaceProcedure
    .output(z.object({ value: z.string(), mimetype: z.string().optional() }).nullable())
    .query(async ({ ctx }) => {
      const [row] = await ctx.services.db.db
        .select({ sessionName: schema.whatsappSessions.wahaSessionId })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Sessão não criada. Inicie a conexão primeiro.',
        });
      }
      try {
        const qr = await ctx.services.waha.getQr(row.sessionName);
        if (!qr.value) return null;
        return qr;
      } catch (cause) {
        const err = cause as { details?: { status?: number } };
        // 404 / 422 / 425 = session not yet in SCAN_QR_CODE phase.
        // Returning null lets the UI keep polling without flashing
        // an error toast every 5 seconds.
        if (err?.details?.status === 404 || err?.details?.status === 422) {
          return null;
        }
        throw cause;
      }
    }),

  /**
   * Soft disconnect. Stops the WAHA session but keeps the local mirror
   * row so the producer can re-scan QR without re-typing the name.
   */
  stop: workspaceProcedure.output(z.object({ ok: z.literal(true) })).mutation(async ({ ctx }) => {
    const { waha, db } = ctx.services;
    const [row] = await db.db
      .select({ sessionName: schema.whatsappSessions.wahaSessionId })
      .from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
      .limit(1);
    if (!row) return { ok: true as const };

    try {
      await waha.stopSession(row.sessionName);
    } catch {
      // Ignore — we still flag the row as STOPPED so the UI reflects intent.
    }
    await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
      await tx
        .update(schema.whatsappSessions)
        .set({ status: 'STOPPED', disconnectedAt: new Date() })
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId));
    });
    return { ok: true as const };
  }),

  /**
   * Hard reset. Deletes the WAHA session (clearing the cert/store) AND
   * the local mirror row so the producer can start over with a new
   * name. The "Recomeçar" button on the dashboard calls this whenever
   * the session is FAILED or stuck in STARTING.
   */
  reset: workspaceProcedure.output(z.object({ ok: z.literal(true) })).mutation(async ({ ctx }) => {
    const { waha, db } = ctx.services;
    const [row] = await db.db
      .select({ sessionName: schema.whatsappSessions.wahaSessionId })
      .from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
      .limit(1);

    if (row) {
      try {
        await waha.deleteSession(row.sessionName);
      } catch (cause) {
        // 404 already absorbed by deleteSession; anything else we let
        // the row deletion proceed so the producer isn't blocked from
        // recreating just because WAHA upstream choked.
        process.stdout.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'whatsapp.reset.wahaDeleteFailed',
            workspaceId: ctx.workspaceId,
            sessionName: row.sessionName,
            error: cause instanceof Error ? cause.message : String(cause),
          })}\n`,
        );
      }
    }

    await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
      await tx
        .delete(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId));
    });

    return { ok: true as const };
  }),
});

/**
 * Idempotent WAHA session boot. Centralises the create → recover-on-422
 * → settle pattern used by both `start` and `retry`.
 *
 * Behaviour:
 *   - Try `POST /api/sessions` with `start: true` and engine WEBJS.
 *   - On 422 (session exists in WAHA — race after delete, or our mirror
 *     drifted), call `POST /api/sessions/{name}/start` to make sure the
 *     existing session is actually running.
 *   - On any other error, surface as BAD_GATEWAY so the dashboard can
 *     suggest a different name.
 *
 * Returns the status WAHA reports right after; defaults to `STARTING`
 * when WAHA hasn't yet decided (e.g. chromium still booting). The
 * dashboard polls every 3s anyway, so we never block waiting here.
 */
async function ensureWahaSessionStarted(
  waha: WahaClient,
  name: string,
): Promise<z.infer<typeof StatusEnum>> {
  try {
    await waha.createSession(name, { autoStart: true, engine: 'WEBJS' });
  } catch (cause) {
    const err = cause as { details?: { status?: number } };
    if (err?.details?.status === 422) {
      // Session already exists in WAHA — make sure it's started, not
      // stuck in STOPPED from a previous container restart.
      try {
        await waha.startSession(name);
      } catch {
        /* startSession on a session WAHA refuses is a real upstream
         * failure; let the caller surface it via the status query. */
      }
    } else {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'WAHA recusou criar a sessão. Tente um nome diferente.',
        cause,
      });
    }
  }

  try {
    return await waha.getSessionStatus(name);
  } catch {
    return 'STARTING';
  }
}
