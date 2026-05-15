import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  createdAt,
  currencyEnum,
  fk,
  gatewayIdEnum,
  id,
  paymentMethodEnum,
  timestampTzNullable,
  transactionStatusEnum,
  updatedAt,
} from './common.js';
import { orders } from './orders.js';
import { workspaces } from './workspaces.js';

/**
 * Every payment attempt. Append-only by convention — status updates create a new
 * row instead of mutating, so we keep a full audit trail of state transitions.
 *
 * `idempotencyKey` is the deterministic UUIDv5 sent to the gateway; the same
 * retry of the same logical attempt yields the same row.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    gatewayId: gatewayIdEnum().notNull(),
    gatewayChargeId: text(),
    gatewayRequestId: text(),
    method: paymentMethodEnum().notNull(),
    status: transactionStatusEnum().notNull().default('pending'),
    amountCents: bigint({ mode: 'bigint' }).notNull(),
    capturedCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    refundedCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    currency: currencyEnum().notNull().default('BRL'),
    installments: integer(),
    idempotencyKey: text().notNull(),
    pixQrCode: text(),
    pixQrCodeImage: text(),
    pixCopyPaste: text(),
    boletoUrl: text(),
    boletoBarcode: text(),
    cardBrand: text(),
    cardLast4: text(),
    failureCode: text(),
    failureMessage: text(),
    rawResponse: jsonb(),
    /** Event-occurrence timestamps. NULL until the gateway reports the event. */
    authorizedAt: timestampTzNullable(),
    paidAt: timestampTzNullable(),
    refundedAt: timestampTzNullable(),
    chargedbackAt: timestampTzNullable(),
    /** Gateway-issued expiry (Pix QR / Boleto due date). NULL until set. */
    expiresAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('transactions_idempotency_unique').on(table.workspaceId, table.idempotencyKey),
    // Scoped to workspace so a (hypothetical) shared gatewayChargeId across
    // tenants cannot collide and corrupt the other side's row. Also includes
    // `WHERE gateway_charge_id IS NOT NULL` so charges that have not yet
    // returned an id from the gateway don't trigger spurious conflicts.
    uniqueIndex('transactions_gateway_charge_unique')
      .on(table.workspaceId, table.gatewayId, table.gatewayChargeId)
      .where(sql`gateway_charge_id IS NOT NULL`),
    index('transactions_order_idx').on(table.orderId),
    index('transactions_workspace_status_idx').on(table.workspaceId, table.status),
    index('transactions_workspace_expires_idx').on(table.workspaceId, table.expiresAt),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    transactionId: fk()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    gatewayRefundId: text(),
    amountCents: bigint({ mode: 'bigint' }).notNull(),
    reason: text(),
    status: transactionStatusEnum().notNull().default('pending'),
    rawResponse: jsonb(),
    requestedAt: createdAt(),
    /** Set when the gateway confirms the refund settled. */
    completedAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('refunds_transaction_idx').on(table.transactionId),
    index('refunds_status_idx').on(table.status),
  ],
);
