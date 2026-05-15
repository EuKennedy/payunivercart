import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, deletedAt, fk, id, updatedAt } from './common.js';

/**
 * An organization is the billing root for a producer (legal entity / brand).
 * One user owns it; many workspaces live under it.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    slug: text().notNull(),
    name: text().notNull(),
    ownerId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    legalDocument: text(),
    websiteUrl: text(),
    onboardingCompleted: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('organizations_slug_unique').on(table.slug),
    index('organizations_owner_idx').on(table.ownerId),
  ],
);
