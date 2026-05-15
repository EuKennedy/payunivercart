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

export const wahaWebhookMessagePayloadSchema = z
  .object({
    event: z.string(),
    session: z.string(),
    payload: z.record(z.unknown()),
    timestamp: z.number().optional(),
  })
  .passthrough();
export type WahaWebhookMessagePayload = z.infer<typeof wahaWebhookMessagePayloadSchema>;

export const WAHA_EVENTS = {
  MESSAGE: 'message',
  MESSAGE_ANY: 'message.any',
  MESSAGE_ACK: 'message.ack',
  STATE_CHANGE: 'state.change',
  SESSION_STATUS: 'session.status',
  PRESENCE_UPDATE: 'presence.update',
} as const;
export type WahaEvent = (typeof WAHA_EVENTS)[keyof typeof WAHA_EVENTS];
