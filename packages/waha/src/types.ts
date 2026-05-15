import { z } from 'zod';

export const wahaSessionStatusSchema = z.enum([
  'STARTING',
  'SCAN_QR_CODE',
  'WORKING',
  'FAILED',
  'STOPPED',
]);
export type WahaSessionStatus = z.infer<typeof wahaSessionStatusSchema>;

export const wahaChatIdSchema = z
  .string()
  .regex(/^\d+@(c\.us|g\.us|lid|newsletter)$/, 'Invalid WAHA chat id');
export type WahaChatId = z.infer<typeof wahaChatIdSchema>;

export const wahaCheckExistsResponseSchema = z.object({
  numberExists: z.boolean(),
  chatId: wahaChatIdSchema.optional(),
});
export type WahaCheckExistsResponse = z.infer<typeof wahaCheckExistsResponseSchema>;

export const wahaSendTextInputSchema = z.object({
  session: z.string().min(1),
  chatId: wahaChatIdSchema,
  text: z.string().min(1).max(4096),
  linkPreview: z.boolean().optional(),
});
export type WahaSendTextInput = z.infer<typeof wahaSendTextInputSchema>;

export const wahaSendTextResponseSchema = z.object({
  id: z.string(),
  timestamp: z.number().optional(),
  status: z.string().optional(),
});
export type WahaSendTextResponse = z.infer<typeof wahaSendTextResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Webhook payloads — discriminated by `event`                                */
/* -------------------------------------------------------------------------- */

export const WAHA_EVENT = {
  MESSAGE: 'message',
  MESSAGE_ANY: 'message.any',
  MESSAGE_ACK: 'message.ack',
  STATE_CHANGE: 'state.change',
  SESSION_STATUS: 'session.status',
  PRESENCE_UPDATE: 'presence.update',
} as const;
export type WahaEvent = (typeof WAHA_EVENT)[keyof typeof WAHA_EVENT];

/** Common envelope every WAHA webhook carries. */
const wahaWebhookEnvelope = {
  session: z.string().min(1),
  /** Unix epoch seconds, set by WAHA at emit time. Used for anti-replay. */
  timestamp: z.number().nonnegative(),
  /** Optional id WAHA assigns to the event itself (vs the message id). */
  id: z.string().optional(),
};

const wahaMessagePayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.literal(WAHA_EVENT.MESSAGE),
  payload: z
    .object({
      id: z.string(),
      from: z.string(),
      to: z.string().optional(),
      body: z.string().optional(),
      fromMe: z.boolean().optional(),
      timestamp: z.number().optional(),
      hasMedia: z.boolean().optional(),
    })
    .passthrough(),
});

const wahaMessageAnyPayloadSchema = wahaMessagePayloadSchema.extend({
  event: z.literal(WAHA_EVENT.MESSAGE_ANY),
});

const wahaMessageAckPayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.literal(WAHA_EVENT.MESSAGE_ACK),
  payload: z
    .object({
      id: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      ack: z.number().int(),
      ackName: z.string().optional(),
    })
    .passthrough(),
});

const wahaStateChangePayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.literal(WAHA_EVENT.STATE_CHANGE),
  payload: z
    .object({
      state: z.string(),
    })
    .passthrough(),
});

const wahaSessionStatusPayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.literal(WAHA_EVENT.SESSION_STATUS),
  payload: z
    .object({
      status: wahaSessionStatusSchema,
    })
    .passthrough(),
});

const wahaPresenceUpdatePayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.literal(WAHA_EVENT.PRESENCE_UPDATE),
  payload: z
    .object({
      id: z.string(),
      presence: z.string().optional(),
    })
    .passthrough(),
});

/**
 * Fallback variant for events WAHA may emit that we have not yet modeled.
 * The handler must narrow off `event` before reading `payload` — there is
 * no guarantee on its shape.
 */
const wahaUnknownPayloadSchema = z.object({
  ...wahaWebhookEnvelope,
  event: z.string(),
  payload: z.unknown(),
});

/**
 * Discriminated union of every known WAHA webhook variant. A consumer
 * must narrow via `switch (payload.event)` to access strongly-typed
 * fields; the `unknown` fallback exists so an unrecognised event still
 * passes verification (we audit it and acknowledge it) without throwing
 * a 500 at HTTP boundary.
 */
export const wahaWebhookPayloadSchema = z.union([
  wahaMessagePayloadSchema,
  wahaMessageAnyPayloadSchema,
  wahaMessageAckPayloadSchema,
  wahaStateChangePayloadSchema,
  wahaSessionStatusPayloadSchema,
  wahaPresenceUpdatePayloadSchema,
  wahaUnknownPayloadSchema,
]);
export type WahaWebhookPayload = z.infer<typeof wahaWebhookPayloadSchema>;
