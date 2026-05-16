import { bigint, boolean, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  createdAt,
  currencyEnum,
  fk,
  id,
  subscriptionStatusEnum,
  timestampTz,
  timestampTzNullable,
  updatedAt,
} from './common';
import { organizations } from './organizations';
import { workspaces } from './workspaces';

/**
 * Our SaaS subscription per workspace (R$ 99,90/mo). One row per workspace.
 * The Stripe (or chosen platform billing gateway) `subscriptionId` is the
 * authoritative source of state; we mirror status here for queries.
 */
export const platformSubscriptions = pgTable(
  'platform_subscriptions',
  {
    id: id(),
    organizationId: fk()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    gatewaySubscriptionId: text(),
    status: subscriptionStatusEnum().notNull().default('trialing'),
    /** Both period bounds come from the gateway and are required after the
     *  first paid invoice. Required because billing math depends on them. */
    currentPeriodStart: timestampTz(),
    currentPeriodEnd: timestampTz(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    cancelledAt: timestampTzNullable(),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('platform_subscriptions_workspace_unique').on(table.workspaceId),
    index('platform_subscriptions_org_idx').on(table.organizationId),
    index('platform_subscriptions_status_idx').on(table.status, table.currentPeriodEnd),
  ],
);

export const platformInvoices = pgTable(
  'platform_invoices',
  {
    id: id(),
    organizationId: fk()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subscriptionId: fk().references(() => platformSubscriptions.id, { onDelete: 'set null' }),
    gatewayInvoiceId: text(),
    amountCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    status: text().notNull().default('pending'),
    periodStart: timestampTz(),
    periodEnd: timestampTz(),
    paidAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('platform_invoices_workspace_idx').on(table.workspaceId),
    uniqueIndex('platform_invoices_gateway_invoice_unique').on(table.gatewayInvoiceId),
    index('platform_invoices_period_idx').on(table.workspaceId, table.periodStart),
  ],
);
