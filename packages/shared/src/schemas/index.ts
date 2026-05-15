import { z } from 'zod';
import {
  GATEWAY_IDS,
  OTP_CHANNELS,
  PAYMENT_METHODS,
  SUPPORTED_LOCALES,
  TRANSACTION_STATUSES,
} from '../constants/index.js';

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
export const cpfSchema = z
  .string()
  .trim()
  .regex(/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/, 'Invalid CPF format');
export const cnpjSchema = z
  .string()
  .trim()
  .regex(/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/, 'Invalid CNPJ format');
export const documentSchema = z.union([cpfSchema, cnpjSchema]);

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
