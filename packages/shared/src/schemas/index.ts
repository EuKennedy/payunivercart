import { z } from 'zod';
import { validateCnpj, validateCpf } from '../br-document/index';
import {
  GATEWAY_IDS,
  OTP_CHANNELS,
  PAYMENT_METHODS,
  SUPPORTED_LOCALES,
  TRANSACTION_STATUSES,
} from '../constants/index';

export const localeSchema = z.enum(SUPPORTED_LOCALES);
export const gatewayIdSchema = z.enum(GATEWAY_IDS);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const transactionStatusSchema = z.enum(TRANSACTION_STATUSES);
export const otpChannelSchema = z.enum(OTP_CHANNELS);

export const moneySchema = z
  .object({
    amount: z.number().int().nonnegative(),
    currency: z.enum(['BRL', 'USD', 'EUR']),
  })
  .strict();
export type Money = z.infer<typeof moneySchema>;

export const emailSchema = z.string().trim().toLowerCase().email();

/**
 * CPF schema. Validates BOTH shape (regex) AND the Receita Federal
 * modulo-11 checksum. Output value is the digits-only string (no
 * punctuation), so downstream code can persist a single canonical form.
 *
 * `transform` runs after `refine`, so callers see a string of exactly 11
 * digits or a ZodError describing which step failed.
 */
export const cpfSchema = z
  .string()
  .trim()
  .regex(/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/, 'Invalid CPF format')
  .superRefine((value, ctx) => {
    if (validateCpf(value) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid CPF (checksum failed)' });
    }
  })
  .transform((value) => validateCpf(value) ?? value);

/** Same contract as `cpfSchema` for CNPJs (14 digits, two checksum digits). */
export const cnpjSchema = z
  .string()
  .trim()
  .regex(/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/, 'Invalid CNPJ format')
  .superRefine((value, ctx) => {
    if (validateCnpj(value) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid CNPJ (checksum failed)' });
    }
  })
  .transform((value) => validateCnpj(value) ?? value);

export const documentSchema = z.union([cpfSchema, cnpjSchema]);

/**
 * Phone input length is capped at 32 chars to mirror the runtime guard in
 * `normalizePhone`. The lower bound is 8 because the shortest plausible
 * national number with country code is around 8 digits.
 */
export const phoneInputSchema = z.string().trim().min(8).max(32);

export const idSchema = z.string().uuid();
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Slug must be kebab-case');

export const paginationSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const checkoutCustomerSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: emailSchema,
    document: documentSchema,
    phoneRaw: phoneInputSchema,
  })
  .strict();
export type CheckoutCustomer = z.infer<typeof checkoutCustomerSchema>;
