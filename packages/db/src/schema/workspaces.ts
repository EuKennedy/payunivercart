import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, deletedAt, fk, id, localeEnum, memberRoleEnum, updatedAt } from './common.js';
import { organizations } from './organizations.js';

/**
 * Each workspace is an isolated tenant inside an organization.
 * Workspaces are individually billed at R$ 99,90/month.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    organizationId: fk().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    brandLogoUrl: text(),
    brandPrimaryColor: text(),
    locale: localeEnum().notNull().default('pt-BR'),
    timezone: text().notNull().default('America/Sao_Paulo'),
    settings: jsonb().notNull().default({}),
    suspended: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('workspaces_org_slug_unique').on(table.organizationId, table.slug),
    index('workspaces_org_idx').on(table.organizationId),
  ],
);

/** Many-to-many between users and workspaces with role-based access. */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    workspaceId: fk().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: fk().notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum().notNull().default('viewer'),
    invitedById: fk().references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);
