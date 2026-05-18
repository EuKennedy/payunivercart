import { schema, withWorkspace } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * WhatsApp integration router. Multi-tenant by design:
 *
 *   one workspace ──> one WAHA session ──> one producer's WhatsApp number
 *
 * The session name is derived deterministically from the workspaceId
 * (`ws_<workspaceId-without-dashes>`). WAHA's session API accepts any
 * string `^[A-Za-z0-9_-]+$`; we strip the UUID's dashes so the name
 * stays inside that character class without further encoding.
 *
 * Every procedure here runs inside `withWorkspace(...)` so RLS scopes
 * every DB query to the caller's workspace automatically.
 */

const sessionNameSchema = z.string().regex(/^ws_[a-f0-9]{32}$/);
type SessionName = z.infer<typeof sessionNameSchema>;

function sessionNameFor(workspaceId: string): SessionName {
  const stripped = workspaceId.replace(/-/g, '').toLowerCase();
  return `ws_${stripped}` as SessionName;
}

export const whatsappRouter = router({
  /**
   * Create-or-resume the workspace's WAHA session and return its current
   * status. Idempotent: calling this against an existing WORKING session
   * is a no-op other than refreshing the local row's `updatedAt`.
   */
  start: workspaceProcedure
    .output(
      z.object({
        sessionName: z.string(),
        status: z.string(),
      }),
    )
    .mutation(async ({ ctx }) => {
      const { waha, db } = ctx.services;
      const name = sessionNameFor(ctx.workspaceId);

      // 1. Create-or-start the WAHA session. WAHA Plus' /start endpoint
      //    returns 404 when the session doesn't exist yet, so we try
      //    /start first (works for repeat connects) and fall back to
      //    POST /api/sessions on 404. 422 = already exists = success.
      try {
        await waha.startSession(name);
      } catch (cause) {
        const err = cause as { code?: string; details?: { status?: number } };
        const status = err?.details?.status;
        if (status === 404) {
          try {
            await waha.createSession(name, true);
          } catch (createCause) {
            const createErr = createCause as { details?: { status?: number } };
            if (createErr?.details?.status !== 422) {
              throw new TRPCError({
                code: 'BAD_GATEWAY',
                message: 'WAHA refused to create the session',
                cause: createCause,
              });
            }
          }
        } else if (status !== 422) {
          throw new TRPCError({
            code: 'BAD_GATEWAY',
            message: 'WAHA refused to start the session',
            cause,
          });
        }
      }

      const status = await waha.getSessionStatus(name);

      // 2. Upsert the local mirror row inside the workspace's RLS scope.
      await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
        await tx
          .insert(schema.whatsappSessions)
          .values({
            workspaceId: ctx.workspaceId,
            wahaSessionId: name,
            status,
          })
          .onConflictDoUpdate({
            target: schema.whatsappSessions.workspaceId,
            set: { wahaSessionId: name, status },
          });
      });

      return { sessionName: name, status };
    }),

  /**
   * Return the QR-code data for the producer to scan with their phone.
   * The endpoint is intended to be polled by the dashboard while the
   * session is in `SCAN_QR_CODE` state.
   */
  qr: workspaceProcedure
    .output(z.object({ value: z.string(), mimetype: z.string().optional() }))
    .query(async ({ ctx }) => {
      const { waha } = ctx.services;
      const name = sessionNameFor(ctx.workspaceId);
      const qr = await waha.getQr(name);
      return qr;
    }),

  /**
   * Cheap status read. The dashboard polls this every ~3s while the
   * session is in SCAN_QR_CODE / STARTING and stops polling once it
   * reaches WORKING / FAILED / STOPPED.
   */
  status: workspaceProcedure
    .output(
      z.object({
        sessionName: z.string(),
        status: z.enum(['STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'STOPPED']),
        phoneNumber: z.string().nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const { waha, db } = ctx.services;
      const name = sessionNameFor(ctx.workspaceId);
      const status = await waha.getSessionStatus(name);

      const phoneNumber = await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
        const rows = await tx
          .select({ phoneNumber: schema.whatsappSessions.phoneNumber })
          .from(schema.whatsappSessions)
          .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
          .limit(1);
        return rows[0]?.phoneNumber ?? null;
      });

      return { sessionName: name, status, phoneNumber };
    }),

  /**
   * Disconnect the workspace's WhatsApp. WAHA wipes the local session
   * store; the producer will need to scan the QR again to re-pair.
   */
  stop: workspaceProcedure.output(z.object({ ok: z.literal(true) })).mutation(async ({ ctx }) => {
    const { waha, db } = ctx.services;
    const name = sessionNameFor(ctx.workspaceId);

    await waha.stopSession(name);
    await withWorkspace(db.db, ctx.workspaceId, async (tx) => {
      await tx
        .update(schema.whatsappSessions)
        .set({ status: 'STOPPED', disconnectedAt: new Date() })
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId));
    });

    return { ok: true as const };
  }),
});
