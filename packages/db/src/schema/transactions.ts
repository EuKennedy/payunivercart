import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  createdAt,
  currencyEnum,
  fk,
  gatewayIdEnum,
  id,
  paymentMethodEnum,
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
    capturedCents: bigint({ mode: 'bigint' }).notNull().default(0n),
    refundedCents: bigint({ mode: 'bigint' }).notNull().default(0n),
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
    authorizedAt: createdAt(),
    paidAt: createdAt(),
    refundedAt: createdAt(),
    chargedbackAt: createdAt(),
    expiresAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('transactions_idempotency_unique').on(table.workspaceId, table.idempotencyKey),
    uniqueIndex('transactions_gateway_charge_unique').on(table.gatewayId, table.gatewayChargeId),
    index('transactions_order_idx').on(table.orderId),
    index('transactions_workspace_status_idx').on(table.workspaceId, table.status),
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
    completedAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('refunds_transaction_idx').on(table.transactionId)],
);
