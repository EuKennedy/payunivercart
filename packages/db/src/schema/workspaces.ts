import { boolean, customType, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth';
import {
  createdAt,
  deletedAt,
  fk,
  id,
  localeEnum,
  memberRoleEnum,
  timestampTzNullable,
  updatedAt,
} from './common';
import { organizations } from './organizations';

/**
 * Postgres `bytea` mapped to `Uint8Array`. Used for the workspace brand
 * logo blob — we store the raw image bytes in the row rather than push
 * them to an external bucket so the deploy stays single-service.
 * Producers upload PNG/JPEG/WEBP capped at 2 MB by the API surface.
 */
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Each workspace is an isolated tenant inside an organization.
 * Workspaces are individually billed at R$ 99,90/month.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    organizationId: fk()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    /**
     * Producer-facing brand name shown on the public checkout. When NULL
     * the checkout falls back to `workspaces.name`. Captured at signup
     * ("Nome da empresa") and editable via Configurações → Marca.
     */
    companyName: text(),
    /** Legacy external-URL logo. Kept for backwards-compat; the new
     * upload pipeline stores bytes in `brandLogo`/`brandLogoMime`. */
    brandLogoUrl: text(),
    /** Logo bytes — served by `GET /api/img/workspace/:id/logo`. */
    brandLogo: bytea(),
    /** MIME of `brandLogo` (e.g. `image/png`). NULL when `brandLogo` is NULL. */
    brandLogoMime: text(),
    brandPrimaryColor: text(),
    /**
     * Public checkout layout template. Producer picks between a
     * single-page form ("Identificação + Pagamento na mesma tela") and
     * a 3-step stepper. Default is `single` because it converts higher
     * on impulse buys; producers selling higher-ticket items often
     * prefer `stepper` for the perceived "checkout seguro" weight.
     */
    checkoutTemplate: text().notNull().default('single'),
    /**
     * Producer toggle to hide the Boleto payment option from the
     * public checkout. Boleto is enabled by default; producers selling
     * digital-only / low-ticket can turn it off so buyers can't choose
     * a slow-clearing method that hurts conversion.
     */
    acceptBoleto: boolean().notNull().default(true),
    /**
     * Producer's own WhatsApp number (E.164, e.g. `+5531984956383`).
     * When set, the gateway-webhook handler dispatches a sale alert
     * via the workspace's WAHA session every time an order flips to
     * `paid`. NULL = silent (producer didn't opt in).
     */
    notificationPhoneE164: text(),
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
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum().notNull().default('viewer'),
    invitedById: fk().references(() => users.id, { onDelete: 'set null' }),
    /** NULL while the invite is outstanding; set when the user accepts. */
    acceptedAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);
