import { schema, withWorkspace } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, router, workspaceProcedure } from '../trpc';
import { listOrProvisionMemberships } from '../workspace-lookup';

/**
 * Logo upload caps. 2 MiB raw → roughly 2.7 MB base64 wire payload,
 * which fits comfortably under Hono's default body limit. We accept
 * the three formats every modern browser can both encode and decode:
 * PNG (icons / sharp edges), JPEG (photo logos) and WEBP (everything
 * else, smallest payload).
 */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ACCEPTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Workspace-discovery procedures. These run on `authedProcedure`
 * (not `workspaceProcedure`) because they are the very thing the
 * dashboard calls to LEARN which workspace the user belongs to —
 * requiring a tenant context here would be circular.
 *
 * Both procedures delegate to `listOrProvisionMemberships` which
 * self-heals pre-Block-19 users on the spot. See the module's docblock
 * for rationale.
 */

const MembershipRow = z.object({
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(['owner', 'admin', 'editor', 'viewer']),
});

const RoleEnum = z.enum(['owner', 'admin', 'editor', 'viewer']);

export const workspaceRouter = router({
  /**
   * All workspaces the current user is a member of. Drives the sidebar
   * switcher.
   */
  list: authedProcedure.output(z.array(MembershipRow)).query(async ({ ctx }) => {
    return listOrProvisionMemberships(ctx.services.db.db, ctx.userId);
  }),

  /**
   * Current workspace + role. Resolves to the `X-Workspace-Id` header
   * when set and valid for this user; otherwise the oldest membership.
   */
  me: authedProcedure
    .output(
      z.object({
        workspace: z.object({
          id: z.string().uuid(),
          name: z.string(),
          slug: z.string(),
        }),
        role: RoleEnum,
      }),
    )
    .query(async ({ ctx }) => {
      const rows = await listOrProvisionMemberships(ctx.services.db.db, ctx.userId);
      if (rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'No workspace membership for this user',
        });
      }
      const headerWs = ctx.honoCtx.req.header('x-workspace-id') ?? null;
      const selected = headerWs ? rows.find((r) => r.workspaceId === headerWs) : rows[0];
      if (!selected) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'User is not a member of the requested workspace',
        });
      }
      return {
        workspace: {
          id: selected.workspaceId,
          name: selected.name,
          slug: selected.slug,
        },
        role: selected.role,
      };
    }),

  /**
   * Branding state for the current workspace. Used by the dashboard
   * Configurações → Marca page and (via `displayName`) by the public
   * checkout. We never return the logo bytes here — only the boolean
   * "has logo" so the UI can render the right empty-state and the
   * client can decide whether to render `<img src="/img/workspace/:id/logo">`.
   */
  /**
   * Workspace profile — name + slug. Distinct from `branding` because
   * `name` is the INTERNAL identifier shown in the sidebar workspace
   * switcher; `companyName` (under branding) is the EXTERNAL identity
   * the buyer sees on the checkout. Two writes, two surfaces, never
   * one input that quietly clobbers both.
   */
  profile: workspaceProcedure
    .output(
      z.object({
        workspaceId: z.string().uuid(),
        name: z.string(),
        slug: z.string(),
        locale: z.string(),
        timezone: z.string(),
        notificationPhoneE164: z.string().nullable(),
        checkoutTemplate: z.enum(['single', 'stepper', 'express']),
        acceptBoleto: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
      const [row] = await ctx.services.db.db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          locale: schema.workspaces.locale,
          timezone: schema.workspaces.timezone,
          notificationPhoneE164: schema.workspaces.notificationPhoneE164,
          checkoutTemplate: schema.workspaces.checkoutTemplate,
          acceptBoleto: schema.workspaces.acceptBoleto,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace inexistente.' });
      }
      return {
        workspaceId: row.id,
        name: row.name,
        slug: row.slug,
        locale: row.locale,
        timezone: row.timezone,
        notificationPhoneE164: row.notificationPhoneE164,
        checkoutTemplate:
          row.checkoutTemplate === 'stepper'
            ? ('stepper' as const)
            : row.checkoutTemplate === 'express'
              ? ('express' as const)
              : ('single' as const),
        acceptBoleto: row.acceptBoleto,
      };
    }),

  /**
   * Update workspace profile fields. Slug must stay URL-safe so
   * existing checkout links (which embed it nowhere — we use product
   * slugs for buyer-facing URLs) don't suddenly become invalid in a
   * future deep-link feature.
   */
  updateProfile: workspaceProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        slug: z
          .string()
          .trim()
          .min(2)
          .max(40)
          .regex(
            /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
            'Slug: minúsculas, números e hífen (sem extremos).',
          )
          .optional(),
        /**
         * Producer's own WhatsApp (E.164) for sale-alert pings.
         * Validated as 10–15 digits prefixed with `+` so we don't
         * later ship an empty string into WAHA. Pass `null` to opt
         * out, `undefined` to leave untouched.
         */
        notificationPhoneE164: z
          .string()
          .trim()
          .regex(/^\+\d{10,15}$/, 'Use formato internacional, ex: +5531984956383.')
          .nullable()
          .optional(),
        /**
         * Producer choice between single-page and 3-step checkout
         * layouts. Persisted on the workspace because every product
         * shares the same producer-facing brand surface.
         */
        checkoutTemplate: z.enum(['single', 'stepper', 'express']).optional(),
        /**
         * Toggle the Boleto option in the public checkout. Default
         * true on insert; producer flips off for digital-only flows.
         */
        acceptBoleto: z.boolean().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.notificationPhoneE164 !== undefined)
        patch.notificationPhoneE164 = input.notificationPhoneE164;
      if (input.checkoutTemplate !== undefined) patch.checkoutTemplate = input.checkoutTemplate;
      if (input.acceptBoleto !== undefined) patch.acceptBoleto = input.acceptBoleto;
      if (Object.keys(patch).length === 0) {
        return { ok: true as const };
      }
      try {
        await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
          await tx
            .update(schema.workspaces)
            .set(patch)
            .where(eq(schema.workspaces.id, ctx.workspaceId));
        });
      } catch (cause) {
        const pgCode = (cause as { code?: string })?.code;
        if (pgCode === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Esse identificador já está em uso por outra workspace.',
          });
        }
        throw cause;
      }
      return { ok: true as const };
    }),

  branding: workspaceProcedure
    .output(
      z.object({
        workspaceId: z.string().uuid(),
        name: z.string(),
        companyName: z.string().nullable(),
        displayName: z.string(),
        hasLogo: z.boolean(),
        logoMime: z.string().nullable(),
        brandPrimaryColor: z.string().nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const [row] = await ctx.services.db.db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          companyName: schema.workspaces.companyName,
          brandLogoMime: schema.workspaces.brandLogoMime,
          brandPrimaryColor: schema.workspaces.brandPrimaryColor,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace inexistente.' });
      }
      return {
        workspaceId: row.id,
        name: row.name,
        companyName: row.companyName,
        displayName: row.companyName?.trim() || row.name,
        hasLogo: row.brandLogoMime != null,
        logoMime: row.brandLogoMime,
        brandPrimaryColor: row.brandPrimaryColor,
      };
    }),

  /**
   * Patch workspace branding. All fields optional and patched
   * independently, so the UI can save "just the company name" or
   * "just the logo" without round-tripping every field.
   *
   * Logo is a base64-encoded blob plus its MIME. We refuse anything
   * outside PNG/JPEG/WEBP and anything above MAX_LOGO_BYTES so the
   * column doesn't grow into an attack vector. Pass `logo: null` to
   * clear the existing logo; omit the field to leave it untouched.
   */
  updateBranding: workspaceProcedure
    .input(
      z.object({
        companyName: z.string().trim().min(1).max(120).nullable().optional(),
        brandPrimaryColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, 'Use cor hex no formato #RRGGBB.')
          .nullable()
          .optional(),
        logo: z
          .object({
            base64: z.string().min(1),
            mime: z.string(),
          })
          .nullable()
          .optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {};
      if (input.companyName !== undefined) {
        // Empty string normalised to null so a producer can wipe the
        // brand-name override and fall back to workspace.name.
        patch.companyName = input.companyName ? input.companyName : null;
      }
      if (input.brandPrimaryColor !== undefined) {
        patch.brandPrimaryColor = input.brandPrimaryColor;
      }
      if (input.logo !== undefined) {
        if (input.logo === null) {
          patch.brandLogo = null;
          patch.brandLogoMime = null;
        } else {
          const { base64, mime } = input.logo;
          if (!ACCEPTED_IMAGE_MIME.has(mime)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Logo deve ser PNG, JPEG ou WEBP.',
            });
          }
          let bytes: Uint8Array;
          try {
            bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
          } catch {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Não foi possível decodificar o arquivo enviado.',
            });
          }
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOGO_BYTES) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Logo deve ter entre 1 byte e ${MAX_LOGO_BYTES / 1024 / 1024} MB.`,
            });
          }
          patch.brandLogo = bytes;
          patch.brandLogoMime = mime;
        }
      }
      if (Object.keys(patch).length === 0) {
        return { ok: true as const };
      }
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        await tx
          .update(schema.workspaces)
          .set(patch)
          .where(eq(schema.workspaces.id, ctx.workspaceId));
      });
      return { ok: true as const };
    }),

  /**
   * Onboarding floating widget — returns persisted UI state alongside
   * the computed completion flags so the widget renders in one
   * round-trip. The widget is presentational; all gating lives here.
   *
   * `view` derivation:
   *   - dismissed (explicit no-show)  → 'hidden'
   *   - completedAt set                → 'hidden'
   *   - minimizedAt set                → 'minimized' (corner chip)
   *   - else                           → 'full' (open panel)
   *
   * Auto-completes when every step is done so producers don't see the
   * widget linger one render after their first paid order.
   */
  onboardingState: workspaceProcedure
    .output(
      z.object({
        view: z.enum(['full', 'minimized', 'hidden']),
        steps: z.object({
          marca: z.boolean(),
          gateway: z.boolean(),
          whatsapp: z.boolean(),
          produto: z.boolean(),
          publicar: z.boolean(),
          primeiraVenda: z.boolean(),
        }),
        completedCount: z.number().int().nonnegative(),
        totalSteps: z.number().int().positive(),
        completedAt: z.date().nullable(),
        minimizedAt: z.date().nullable(),
        dismissedAt: z.date().nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const db = ctx.services.db.db;
      const [wsRow] = await db
        .select({
          companyName: schema.workspaces.companyName,
          hasLogo: sql<boolean>`(${schema.workspaces.brandLogo} IS NOT NULL)`,
          completedAt: schema.workspaces.onboardingCompletedAt,
          minimizedAt: schema.workspaces.onboardingMinimizedAt,
          dismissedAt: schema.workspaces.onboardingDismissedAt,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId))
        .limit(1);
      if (!wsRow) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace inexistente.' });
      }

      const [gatewayCount] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.gatewayCredentials)
        .where(eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId));
      const [waSession] = await db
        .select({ status: schema.whatsappSessions.status })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      const [productCount] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.products)
        .where(
          and(eq(schema.products.workspaceId, ctx.workspaceId), isNull(schema.products.deletedAt)),
        );
      const [paidOrderCount] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.workspaceId, ctx.workspaceId), eq(schema.orders.status, 'paid')),
        );

      const marca = (wsRow.companyName?.trim().length ?? 0) > 0 || wsRow.hasLogo === true;
      const gateway = Number(gatewayCount?.n ?? 0) > 0;
      const whatsapp = waSession?.status === 'WORKING';
      const produto = Number(productCount?.n ?? 0) > 0;
      const publicar = marca && produto;
      const primeiraVenda = Number(paidOrderCount?.n ?? 0) > 0;

      const steps = { marca, gateway, whatsapp, produto, publicar, primeiraVenda };
      const totalSteps = Object.keys(steps).length;
      const completedCount = Object.values(steps).filter(Boolean).length;

      let completedAt = wsRow.completedAt;
      if (completedCount === totalSteps && !completedAt) {
        completedAt = new Date();
        await db
          .update(schema.workspaces)
          .set({ onboardingCompletedAt: completedAt })
          .where(eq(schema.workspaces.id, ctx.workspaceId));
      }

      const view: 'full' | 'minimized' | 'hidden' =
        wsRow.dismissedAt || completedAt ? 'hidden' : wsRow.minimizedAt ? 'minimized' : 'full';

      return {
        view,
        steps,
        completedCount,
        totalSteps,
        completedAt,
        minimizedAt: wsRow.minimizedAt,
        dismissedAt: wsRow.dismissedAt,
      };
    }),

  /**
   * Minimize / restore / dismiss / reopen — single mutation with an
   * `action` discriminator so the widget can call the same endpoint
   * for every UI transition. Dismiss is the only permanent one (until
   * an operator clears the column).
   */
  onboardingAction: workspaceProcedure
    .input(z.object({ action: z.enum(['minimize', 'restore', 'dismiss', 'reopen']) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const patch: Partial<typeof schema.workspaces.$inferInsert> = {};
      switch (input.action) {
        case 'minimize':
          patch.onboardingMinimizedAt = new Date();
          break;
        case 'restore':
          patch.onboardingMinimizedAt = null;
          break;
        case 'dismiss':
          patch.onboardingDismissedAt = new Date();
          break;
        case 'reopen':
          patch.onboardingDismissedAt = null;
          patch.onboardingMinimizedAt = null;
          patch.onboardingCompletedAt = null;
          break;
      }
      await ctx.services.db.db
        .update(schema.workspaces)
        .set(patch)
        .where(eq(schema.workspaces.id, ctx.workspaceId));
      return { ok: true as const };
    }),
});
