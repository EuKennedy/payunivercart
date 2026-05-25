import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, router, workspaceProcedure } from '../trpc';

/**
 * Producer-facing affiliate management.
 *
 * Scope of this PR (2/5):
 *   - Programs CRUD (commission shape, approval policy, refund window)
 *   - Invitations (email-based, hashed token, ttl)
 *   - Membership review queue (approve / reject / suspend / reactivate)
 *   - List affiliates with current commission summary
 *
 * Out of scope (lands in later PRs):
 *   - Public /a/:slug redirect + click capture (PR 3)
 *   - Commission compute worker + payouts (PR 4)
 *   - Antifraud signals + leaderboard + audit query (PR 5)
 *
 * Every endpoint here runs inside `workspaceProcedure`. Cross-tenant
 * leak protection is twofold:
 *   1. Explicit `eq(workspaceId, ctx.workspaceId)` predicate on every
 *      query — defence-in-depth even with the superuser DB role.
 *   2. The dedicated affiliate router exposes nothing that crosses
 *      workspace boundaries. The affiliate-facing surface (their own
 *      dashboard) lives in `affiliatesPublicRouter` (later PR).
 */

// ─── Shared zod shapes ───────────────────────────────────────────────────────

const ApprovalPolicy = z.enum(['automatic', 'manual', 'invite_only']);
const CommissionType = z.enum(['percent', 'flat', 'recurring', 'lifetime']);
const MembershipStatus = z.enum(['pending', 'approved', 'rejected', 'suspended', 'left']);

const ProgramRow = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  productName: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  approvalPolicy: ApprovalPolicy,
  isPublic: z.boolean(),
  commissionType: CommissionType,
  commissionPercent: z.number().int().nullable(),
  commissionFlatCents: z.number().int().nullable(),
  recurringCycleLimit: z.number().int().nullable(),
  refundWindowDays: z.number().int(),
  attributionWindowDays: z.number().int(),
  allowPaidTraffic: z.boolean(),
  isActive: z.boolean(),
  /** Count of approved members — cheap dashboard signal. */
  approvedMembersCount: z.number().int().nonnegative(),
  pendingMembersCount: z.number().int().nonnegative(),
  createdAt: z.date(),
});

const AffiliateMemberRow = z.object({
  membershipId: z.string().uuid(),
  affiliateId: z.string().uuid(),
  displayName: z.string(),
  publicCode: z.string(),
  email: z.string(),
  status: MembershipStatus,
  programId: z.string().uuid(),
  programName: z.string(),
  appliedAt: z.date().nullable(),
  decidedAt: z.date().nullable(),
  /** Totals across this workspace only — surfaced as commission KPIs
   *  in the producer-side affiliate detail screen. */
  totalCommissionsCents: z.number().int().nonnegative(),
  pendingCommissionsCents: z.number().int().nonnegative(),
  createdAt: z.date(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that `productId` (when provided) belongs to the workspace —
 * stops a tenant from creating a program tied to another workspace's
 * product. Cheap: single indexed lookup.
 */
async function assertProductOwnership(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's PgDatabase generic surfaces here would force every router helper to thread its schema type; the runtime call signature is stable.
  db: any,
  productId: string | null,
  workspaceId: string,
): Promise<void> {
  if (!productId) return;
  const [product] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.workspaceId, workspaceId)))
    .limit(1);
  if (!product) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto não encontrado neste workspace.' });
  }
}

/**
 * Either-side validation of commission inputs: percent + recurring
 * cap on percent shapes; flat amount on flat shapes. Refuses
 * impossible combinations early so a malformed row never lands in
 * the database.
 */
function assertCommissionShape(input: {
  commissionType: z.infer<typeof CommissionType>;
  commissionPercent?: number | null;
  commissionFlatCents?: number | null;
  recurringCycleLimit?: number | null;
}): void {
  const t = input.commissionType;
  if (t === 'flat') {
    if (input.commissionFlatCents == null || input.commissionFlatCents <= 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Comissão fixa exige valor em centavos maior que zero.',
      });
    }
    return;
  }
  // percent / recurring / lifetime → percent required
  if (
    input.commissionPercent == null ||
    input.commissionPercent < 1 ||
    input.commissionPercent > 90
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Comissão percentual deve estar entre 1 e 90.',
    });
  }
  if (t === 'recurring') {
    if (input.recurringCycleLimit != null && input.recurringCycleLimit < 1) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Limite de ciclos deve ser pelo menos 1 (ou nulo para usar default).',
      });
    }
  }
}

/** Cryptographically-random invitation token (URL-safe). */
function mintInvitationToken(): { token: string; tokenHash: string } {
  // 32 bytes → 43-char base64url string, ~256 bits of entropy.
  const token = randomBytes(32).toString('base64url');
  // Stored hashed so a DB leak doesn't hand attackers usable invites.
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/** Random URL-safe public code for `?ref=ABC123` (6 chars). */
function mintPublicCode(): string {
  // 4 bytes → 7-char base64url, slice to 6 for ergonomics. Collision
  // probability over 1M affiliates ~0.06% — we add a unique index so
  // the rare collision retries at insert.
  return randomBytes(4).toString('base64url').slice(0, 6).toUpperCase();
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const affiliatesRouter = router({
  /* ============================== PROGRAMS ================================ */

  /**
   * List all programs in the workspace. Joined with product name (when
   * scoped to one) and per-program member counters for the dashboard.
   */
  listPrograms: workspaceProcedure.output(z.array(ProgramRow)).query(async ({ ctx }) => {
    const db = ctx.services.db.db;
    const rows = await db
      .select({
        id: schema.affiliatePrograms.id,
        productId: schema.affiliatePrograms.productId,
        productName: schema.products.name,
        name: schema.affiliatePrograms.name,
        description: schema.affiliatePrograms.description,
        approvalPolicy: schema.affiliatePrograms.approvalPolicy,
        isPublic: schema.affiliatePrograms.isPublic,
        commissionType: schema.affiliatePrograms.commissionType,
        commissionPercent: schema.affiliatePrograms.commissionPercent,
        commissionFlatCents: schema.affiliatePrograms.commissionFlatCents,
        recurringCycleLimit: schema.affiliatePrograms.recurringCycleLimit,
        refundWindowDays: schema.affiliatePrograms.refundWindowDays,
        attributionWindowDays: schema.affiliatePrograms.attributionWindowDays,
        allowPaidTraffic: schema.affiliatePrograms.allowPaidTraffic,
        isActive: schema.affiliatePrograms.isActive,
        createdAt: schema.affiliatePrograms.createdAt,
      })
      .from(schema.affiliatePrograms)
      .leftJoin(schema.products, eq(schema.products.id, schema.affiliatePrograms.productId))
      .where(
        and(
          eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
          isNull(schema.affiliatePrograms.deletedAt),
        ),
      )
      .orderBy(desc(schema.affiliatePrograms.createdAt));

    // Pull counters in one round-trip via GROUP BY.
    const counts =
      rows.length === 0
        ? []
        : await db
            .select({
              programId: schema.affiliateMemberships.programId,
              status: schema.affiliateMemberships.status,
              n: sql<number>`count(*)::int`,
            })
            .from(schema.affiliateMemberships)
            .where(
              and(
                eq(schema.affiliateMemberships.workspaceId, ctx.workspaceId),
                inArray(
                  schema.affiliateMemberships.programId,
                  rows.map((r) => r.id),
                ),
              ),
            )
            .groupBy(schema.affiliateMemberships.programId, schema.affiliateMemberships.status);

    const countByProgram = new Map<string, { approved: number; pending: number }>();
    for (const c of counts) {
      const entry = countByProgram.get(c.programId) ?? { approved: 0, pending: 0 };
      if (c.status === 'approved') entry.approved = Number(c.n);
      if (c.status === 'pending') entry.pending = Number(c.n);
      countByProgram.set(c.programId, entry);
    }

    return rows.map((r) => {
      const counters = countByProgram.get(r.id) ?? { approved: 0, pending: 0 };
      return {
        id: r.id,
        productId: r.productId,
        productName: r.productName ?? null,
        name: r.name,
        description: r.description,
        approvalPolicy: r.approvalPolicy as z.infer<typeof ApprovalPolicy>,
        isPublic: Boolean(r.isPublic),
        commissionType: r.commissionType as z.infer<typeof CommissionType>,
        commissionPercent: r.commissionPercent,
        commissionFlatCents: r.commissionFlatCents != null ? Number(r.commissionFlatCents) : null,
        recurringCycleLimit: r.recurringCycleLimit,
        refundWindowDays: r.refundWindowDays,
        attributionWindowDays: r.attributionWindowDays,
        allowPaidTraffic: Boolean(r.allowPaidTraffic),
        isActive: Boolean(r.isActive),
        approvedMembersCount: counters.approved,
        pendingMembersCount: counters.pending,
        createdAt: r.createdAt,
      };
    });
  }),

  /** Create a program. `productId = null` means workspace-wide default. */
  createProgram: workspaceProcedure
    .input(
      z.object({
        productId: z.string().uuid().nullable().default(null),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).optional(),
        approvalPolicy: ApprovalPolicy.default('manual'),
        isPublic: z.boolean().default(false),
        commissionType: CommissionType,
        commissionPercent: z.number().int().min(1).max(90).nullable().default(null),
        commissionFlatCents: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
        recurringCycleLimit: z.number().int().min(1).max(120).nullable().default(null),
        refundWindowDays: z.number().int().min(0).max(180).default(30),
        attributionWindowDays: z.number().int().min(1).max(365).default(60),
        allowPaidTraffic: z.boolean().default(true),
        forbiddenKeywords: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
      }),
    )
    .output(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      assertCommissionShape(input);
      await assertProductOwnership(db, input.productId, ctx.workspaceId);

      // Workspace-default program (productId null) must be unique — the
      // partial unique index enforces it at the DB level; we surface a
      // clean error here so the producer doesn't see a 500.
      if (input.productId === null) {
        const [existingDefault] = await db
          .select({ id: schema.affiliatePrograms.id })
          .from(schema.affiliatePrograms)
          .where(
            and(
              eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
              isNull(schema.affiliatePrograms.productId),
              isNull(schema.affiliatePrograms.deletedAt),
            ),
          )
          .limit(1);
        if (existingDefault) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'Já existe um programa default desta workspace. Edite-o ou crie um específico por produto.',
          });
        }
      }

      const [inserted] = await db
        .insert(schema.affiliatePrograms)
        .values({
          workspaceId: ctx.workspaceId,
          productId: input.productId,
          name: input.name,
          description: input.description ?? null,
          approvalPolicy: input.approvalPolicy,
          isPublic: input.isPublic,
          commissionType: input.commissionType,
          commissionPercent: input.commissionPercent,
          commissionFlatCents:
            input.commissionFlatCents != null ? BigInt(input.commissionFlatCents) : null,
          recurringCycleLimit: input.recurringCycleLimit,
          refundWindowDays: input.refundWindowDays,
          attributionWindowDays: input.attributionWindowDays,
          allowPaidTraffic: input.allowPaidTraffic,
          forbiddenKeywords: input.forbiddenKeywords,
        })
        .returning({ id: schema.affiliatePrograms.id });
      if (!inserted) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Falha ao criar programa.' });
      }
      return { id: inserted.id };
    }),

  /** Patch a program. Commission shape changes touch new sales only —
   *  existing memberships keep accruing at the rate active at sale time. */
  updateProgram: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        approvalPolicy: ApprovalPolicy.optional(),
        isPublic: z.boolean().optional(),
        commissionType: CommissionType.optional(),
        commissionPercent: z.number().int().min(1).max(90).nullable().optional(),
        commissionFlatCents: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
        recurringCycleLimit: z.number().int().min(1).max(120).nullable().optional(),
        refundWindowDays: z.number().int().min(0).max(180).optional(),
        attributionWindowDays: z.number().int().min(1).max(365).optional(),
        allowPaidTraffic: z.boolean().optional(),
        forbiddenKeywords: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      const [current] = await db
        .select({
          id: schema.affiliatePrograms.id,
          commissionType: schema.affiliatePrograms.commissionType,
          commissionPercent: schema.affiliatePrograms.commissionPercent,
          commissionFlatCents: schema.affiliatePrograms.commissionFlatCents,
          recurringCycleLimit: schema.affiliatePrograms.recurringCycleLimit,
        })
        .from(schema.affiliatePrograms)
        .where(
          and(
            eq(schema.affiliatePrograms.id, input.id),
            eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
            isNull(schema.affiliatePrograms.deletedAt),
          ),
        )
        .limit(1);
      if (!current) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Programa não encontrado.' });
      }

      // Re-validate the resulting commission shape after the patch is
      // applied — input may flip type without restating percent, etc.
      const merged = {
        commissionType:
          input.commissionType ?? (current.commissionType as z.infer<typeof CommissionType>),
        commissionPercent:
          input.commissionPercent !== undefined
            ? input.commissionPercent
            : current.commissionPercent,
        commissionFlatCents:
          input.commissionFlatCents !== undefined
            ? input.commissionFlatCents
            : current.commissionFlatCents != null
              ? Number(current.commissionFlatCents)
              : null,
        recurringCycleLimit:
          input.recurringCycleLimit !== undefined
            ? input.recurringCycleLimit
            : current.recurringCycleLimit,
      };
      assertCommissionShape(merged);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.approvalPolicy !== undefined) patch.approvalPolicy = input.approvalPolicy;
      if (input.isPublic !== undefined) patch.isPublic = input.isPublic;
      if (input.commissionType !== undefined) patch.commissionType = input.commissionType;
      if (input.commissionPercent !== undefined) patch.commissionPercent = input.commissionPercent;
      if (input.commissionFlatCents !== undefined)
        patch.commissionFlatCents =
          input.commissionFlatCents != null ? BigInt(input.commissionFlatCents) : null;
      if (input.recurringCycleLimit !== undefined)
        patch.recurringCycleLimit = input.recurringCycleLimit;
      if (input.refundWindowDays !== undefined) patch.refundWindowDays = input.refundWindowDays;
      if (input.attributionWindowDays !== undefined)
        patch.attributionWindowDays = input.attributionWindowDays;
      if (input.allowPaidTraffic !== undefined) patch.allowPaidTraffic = input.allowPaidTraffic;
      if (input.forbiddenKeywords !== undefined) patch.forbiddenKeywords = input.forbiddenKeywords;
      if (input.isActive !== undefined) patch.isActive = input.isActive;

      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.affiliatePrograms)
          .set(patch)
          .where(
            and(
              eq(schema.affiliatePrograms.id, input.id),
              eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
            ),
          );
      }
      return { ok: true as const };
    }),

  /** Soft-delete. Programs are kept for audit (commissions still
   *  reference the program id) so we set `deleted_at` rather than DELETE. */
  archiveProgram: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.affiliatePrograms)
        .set({ deletedAt: new Date(), isActive: false })
        .where(
          and(
            eq(schema.affiliatePrograms.id, input.id),
            eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /* ============================ INVITATIONS =============================== */

  /**
   * Issue an email invite. Returns the raw token ONCE so the caller can
   * embed it in the email body. The token is hashed before storage so
   * a DB leak doesn't grant attackers usable invites.
   */
  inviteByEmail: workspaceProcedure
    .input(
      z.object({
        programId: z.string().uuid(),
        email: z.string().email().toLowerCase(),
        message: z.string().trim().max(500).optional(),
        ttlDays: z.number().int().min(1).max(30).default(7),
      }),
    )
    .output(
      z.object({
        invitationId: z.string().uuid(),
        token: z.string(),
        expiresAt: z.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      const [program] = await db
        .select({ id: schema.affiliatePrograms.id })
        .from(schema.affiliatePrograms)
        .where(
          and(
            eq(schema.affiliatePrograms.id, input.programId),
            eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
            isNull(schema.affiliatePrograms.deletedAt),
          ),
        )
        .limit(1);
      if (!program) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Programa inexistente.' });
      }
      const { token, tokenHash } = mintInvitationToken();
      const expiresAt = new Date(Date.now() + input.ttlDays * 24 * 60 * 60 * 1000);
      const [inserted] = await db
        .insert(schema.affiliateInvitations)
        .values({
          workspaceId: ctx.workspaceId,
          programId: input.programId,
          email: input.email,
          tokenHash,
          invitedByUserId: ctx.userId,
          message: input.message ?? null,
          expiresAt,
        })
        .returning({ id: schema.affiliateInvitations.id });
      if (!inserted) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Falha ao criar convite.' });
      }
      // TODO(emails): wire Resend template `affiliateInvite` once PR 5
      // adds it — for now the producer copies the URL manually from
      // the response. Returning the token here is safe because the
      // procedure is workspace-scoped (only authenticated members of
      // the workspace can see it).
      return { invitationId: inserted.id, token, expiresAt };
    }),

  listInvitations: workspaceProcedure
    .input(z.object({ programId: z.string().uuid().optional() }).optional())
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          programId: z.string().uuid(),
          email: z.string(),
          message: z.string().nullable(),
          expiresAt: z.date().nullable(),
          acceptedAt: z.date().nullable(),
          revokedAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const where = and(
        eq(schema.affiliateInvitations.workspaceId, ctx.workspaceId),
        input?.programId ? eq(schema.affiliateInvitations.programId, input.programId) : undefined,
      );
      const rows = await ctx.services.db.db
        .select({
          id: schema.affiliateInvitations.id,
          programId: schema.affiliateInvitations.programId,
          email: schema.affiliateInvitations.email,
          message: schema.affiliateInvitations.message,
          expiresAt: schema.affiliateInvitations.expiresAt,
          acceptedAt: schema.affiliateInvitations.acceptedAt,
          revokedAt: schema.affiliateInvitations.revokedAt,
          createdAt: schema.affiliateInvitations.createdAt,
        })
        .from(schema.affiliateInvitations)
        .where(where)
        .orderBy(desc(schema.affiliateInvitations.createdAt))
        .limit(200);
      return rows;
    }),

  revokeInvitation: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.affiliateInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.affiliateInvitations.id, input.id),
            eq(schema.affiliateInvitations.workspaceId, ctx.workspaceId),
            isNull(schema.affiliateInvitations.acceptedAt),
            isNull(schema.affiliateInvitations.revokedAt),
          ),
        );
      return { ok: true as const };
    }),

  /* ============================ MEMBERSHIPS ============================== */

  /**
   * Producer review queue. Filter by status to focus the UI on
   * `pending` first; other statuses available for the affiliate-list
   * tab. Joins the affiliate identity + commission summary.
   */
  listMembers: workspaceProcedure
    .input(
      z
        .object({
          status: MembershipStatus.optional(),
          programId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .output(z.array(AffiliateMemberRow))
    .query(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      const limit = input?.limit ?? 50;
      const where = and(
        eq(schema.affiliateMemberships.workspaceId, ctx.workspaceId),
        input?.status ? eq(schema.affiliateMemberships.status, input.status) : undefined,
        input?.programId ? eq(schema.affiliateMemberships.programId, input.programId) : undefined,
      );
      const rows = await db
        .select({
          membershipId: schema.affiliateMemberships.id,
          affiliateId: schema.affiliateMemberships.affiliateId,
          displayName: schema.affiliates.displayName,
          publicCode: schema.affiliates.publicCode,
          // pull email from the underlying Better-Auth users row
          email: schema.users.email,
          status: schema.affiliateMemberships.status,
          programId: schema.affiliateMemberships.programId,
          programName: schema.affiliatePrograms.name,
          appliedAt: schema.affiliateMemberships.appliedAt,
          decidedAt: schema.affiliateMemberships.decidedAt,
          createdAt: schema.affiliateMemberships.createdAt,
        })
        .from(schema.affiliateMemberships)
        .innerJoin(
          schema.affiliates,
          eq(schema.affiliates.id, schema.affiliateMemberships.affiliateId),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.affiliates.userId))
        .innerJoin(
          schema.affiliatePrograms,
          eq(schema.affiliatePrograms.id, schema.affiliateMemberships.programId),
        )
        .where(where)
        .orderBy(desc(schema.affiliateMemberships.createdAt))
        .limit(limit);

      // Roll up commission totals per affiliate within this workspace.
      const affIds = rows.map((r) => r.affiliateId);
      const commissionSummary =
        affIds.length === 0
          ? []
          : await db
              .select({
                affiliateId: schema.affiliateCommissions.affiliateId,
                status: schema.affiliateCommissions.status,
                total: sql<string>`coalesce(sum(${schema.affiliateCommissions.commissionAmountCents}), 0)`,
              })
              .from(schema.affiliateCommissions)
              .where(
                and(
                  eq(schema.affiliateCommissions.workspaceId, ctx.workspaceId),
                  inArray(schema.affiliateCommissions.affiliateId, affIds),
                ),
              )
              .groupBy(schema.affiliateCommissions.affiliateId, schema.affiliateCommissions.status);

      const sums = new Map<string, { total: number; pending: number }>();
      for (const c of commissionSummary) {
        const entry = sums.get(c.affiliateId) ?? { total: 0, pending: 0 };
        const v = Number(c.total ?? 0);
        if (c.status === 'pending') entry.pending += v;
        if (c.status === 'available' || c.status === 'pending' || c.status === 'paid') {
          entry.total += v;
        }
        sums.set(c.affiliateId, entry);
      }

      return rows.map((r) => {
        const s = sums.get(r.affiliateId) ?? { total: 0, pending: 0 };
        return {
          membershipId: r.membershipId,
          affiliateId: r.affiliateId,
          displayName: r.displayName,
          publicCode: r.publicCode,
          email: r.email,
          status: r.status as z.infer<typeof MembershipStatus>,
          programId: r.programId,
          programName: r.programName,
          appliedAt: r.appliedAt,
          decidedAt: r.decidedAt,
          totalCommissionsCents: s.total,
          pendingCommissionsCents: s.pending,
          createdAt: r.createdAt,
        };
      });
    }),

  /** Approve a pending membership. Records who decided + when. */
  approveMember: workspaceProcedure
    .input(
      z.object({ membershipId: z.string().uuid(), note: z.string().trim().max(500).optional() }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .update(schema.affiliateMemberships)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedByUserId: ctx.userId,
          producerNote: input.note ?? null,
          suspendedAt: null,
          suspendedReason: null,
        })
        .where(
          and(
            eq(schema.affiliateMemberships.id, input.membershipId),
            eq(schema.affiliateMemberships.workspaceId, ctx.workspaceId),
            inArray(schema.affiliateMemberships.status, ['pending', 'suspended', 'rejected']),
          ),
        )
        .returning({ id: schema.affiliateMemberships.id });
      if (result.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Membership não encontrado ou já está aprovado.',
        });
      }
      return { ok: true as const };
    }),

  rejectMember: workspaceProcedure
    .input(
      z.object({ membershipId: z.string().uuid(), note: z.string().trim().max(500).optional() }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .update(schema.affiliateMemberships)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedByUserId: ctx.userId,
          producerNote: input.note ?? null,
        })
        .where(
          and(
            eq(schema.affiliateMemberships.id, input.membershipId),
            eq(schema.affiliateMemberships.workspaceId, ctx.workspaceId),
            eq(schema.affiliateMemberships.status, 'pending'),
          ),
        )
        .returning({ id: schema.affiliateMemberships.id });
      if (result.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Membership não está pendente.',
        });
      }
      return { ok: true as const };
    }),

  suspendMember: workspaceProcedure
    .input(z.object({ membershipId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .update(schema.affiliateMemberships)
        .set({
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedReason: input.reason,
        })
        .where(
          and(
            eq(schema.affiliateMemberships.id, input.membershipId),
            eq(schema.affiliateMemberships.workspaceId, ctx.workspaceId),
            eq(schema.affiliateMemberships.status, 'approved'),
          ),
        )
        .returning({ id: schema.affiliateMemberships.id });
      if (result.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Apenas membros aprovados podem ser suspensos.',
        });
      }
      return { ok: true as const };
    }),

  /* ======================= AFFILIATE IDENTITY (self) ===================== */

  /**
   * Ensure the current user has an `affiliates` row. Idempotent —
   * called the first time a producer opens the "Sou afiliado" tab on
   * their own dashboard, or when they accept their first invite.
   */
  ensureSelfAffiliate: authedProcedure
    .output(
      z.object({
        id: z.string().uuid(),
        publicCode: z.string(),
        displayName: z.string(),
      }),
    )
    .mutation(async ({ ctx }) => {
      const db = ctx.services.db.db;
      const [existing] = await db
        .select({
          id: schema.affiliates.id,
          publicCode: schema.affiliates.publicCode,
          displayName: schema.affiliates.displayName,
        })
        .from(schema.affiliates)
        .where(eq(schema.affiliates.userId, ctx.userId))
        .limit(1);
      if (existing) return existing;

      // Pull user's name to seed displayName; retry the public_code on
      // unique violation (1 in ~10^7 collision chance — log & retry).
      const [user] = await db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.userId))
        .limit(1);
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Usuário não encontrado.' });
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const publicCode = mintPublicCode();
        try {
          const [inserted] = await db
            .insert(schema.affiliates)
            .values({
              userId: ctx.userId,
              displayName: user.name ?? user.email,
              publicCode,
            })
            .returning({
              id: schema.affiliates.id,
              publicCode: schema.affiliates.publicCode,
              displayName: schema.affiliates.displayName,
            });
          if (inserted) return inserted;
        } catch (cause) {
          const code = (cause as { code?: string })?.code;
          if (code === '23505') continue; // retry on rare public_code collision
          throw cause;
        }
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao gerar publicCode único após 5 tentativas.',
      });
    }),

  /* ============================ COMMISSIONS ============================== */

  /**
   * Workspace-scoped commission ledger. Producer sees every commission
   * that originated from sales on their products, regardless of which
   * affiliate.
   */
  listCommissions: workspaceProcedure
    .input(
      z
        .object({
          status: z.enum(['pending', 'available', 'paid', 'reversed', 'void']).optional(),
          affiliateId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          affiliateId: z.string().uuid(),
          affiliateName: z.string(),
          programName: z.string(),
          orderId: z.string().uuid().nullable(),
          subscriptionId: z.string().uuid().nullable(),
          cycleNumber: z.number().int().nullable(),
          grossAmountCents: z.number().int().nonnegative(),
          commissionAmountCents: z.number().int().nonnegative(),
          status: z.enum(['pending', 'available', 'paid', 'reversed', 'void']),
          availableAt: z.date().nullable(),
          paidAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const where = and(
        eq(schema.affiliateCommissions.workspaceId, ctx.workspaceId),
        input?.status ? eq(schema.affiliateCommissions.status, input.status) : undefined,
        input?.affiliateId
          ? eq(schema.affiliateCommissions.affiliateId, input.affiliateId)
          : undefined,
      );
      const rows = await ctx.services.db.db
        .select({
          id: schema.affiliateCommissions.id,
          affiliateId: schema.affiliateCommissions.affiliateId,
          affiliateName: schema.affiliates.displayName,
          programName: schema.affiliatePrograms.name,
          orderId: schema.affiliateCommissions.orderId,
          subscriptionId: schema.affiliateCommissions.subscriptionId,
          cycleNumber: schema.affiliateCommissions.cycleNumber,
          grossAmountCents: schema.affiliateCommissions.grossAmountCents,
          commissionAmountCents: schema.affiliateCommissions.commissionAmountCents,
          status: schema.affiliateCommissions.status,
          availableAt: schema.affiliateCommissions.availableAt,
          paidAt: schema.affiliateCommissions.paidAt,
          createdAt: schema.affiliateCommissions.createdAt,
        })
        .from(schema.affiliateCommissions)
        .innerJoin(
          schema.affiliates,
          eq(schema.affiliates.id, schema.affiliateCommissions.affiliateId),
        )
        .innerJoin(
          schema.affiliatePrograms,
          eq(schema.affiliatePrograms.id, schema.affiliateCommissions.programId),
        )
        .where(where)
        .orderBy(desc(schema.affiliateCommissions.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        affiliateId: r.affiliateId,
        affiliateName: r.affiliateName,
        programName: r.programName,
        orderId: r.orderId,
        subscriptionId: r.subscriptionId,
        cycleNumber: r.cycleNumber,
        grossAmountCents: Number(r.grossAmountCents),
        commissionAmountCents: Number(r.commissionAmountCents),
        status: r.status as 'pending' | 'available' | 'paid' | 'reversed' | 'void',
        availableAt: r.availableAt,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
      }));
    }),

  /* ============================== PAYOUTS ================================ */

  /**
   * Producer queue of payout requests. Default view = `requested` so
   * the producer attacks the inbox first; status filter scopes the
   * full ledger for reconciliation.
   */
  listPayouts: workspaceProcedure
    .input(
      z
        .object({
          status: z
            .enum([
              'requested',
              'reviewing',
              'approved',
              'processing',
              'paid',
              'failed',
              'cancelled',
            ])
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          affiliateId: z.string().uuid(),
          affiliateName: z.string(),
          status: z.enum([
            'requested',
            'reviewing',
            'approved',
            'processing',
            'paid',
            'failed',
            'cancelled',
          ]),
          totalAmountCents: z.number().int().nonnegative(),
          requestedAt: z.date(),
          paidAt: z.date().nullable(),
          failureReason: z.string().nullable(),
          gatewayTransactionId: z.string().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const where = and(
        eq(schema.affiliatePayouts.workspaceId, ctx.workspaceId),
        input?.status ? eq(schema.affiliatePayouts.status, input.status) : undefined,
      );
      const rows = await ctx.services.db.db
        .select({
          id: schema.affiliatePayouts.id,
          affiliateId: schema.affiliatePayouts.affiliateId,
          affiliateName: schema.affiliates.displayName,
          status: schema.affiliatePayouts.status,
          totalAmountCents: schema.affiliatePayouts.totalAmountCents,
          requestedAt: schema.affiliatePayouts.requestedAt,
          paidAt: schema.affiliatePayouts.paidAt,
          failureReason: schema.affiliatePayouts.failureReason,
          gatewayTransactionId: schema.affiliatePayouts.gatewayTransactionId,
        })
        .from(schema.affiliatePayouts)
        .innerJoin(schema.affiliates, eq(schema.affiliates.id, schema.affiliatePayouts.affiliateId))
        .where(where)
        .orderBy(desc(schema.affiliatePayouts.requestedAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        affiliateId: r.affiliateId,
        affiliateName: r.affiliateName,
        status: r.status as
          | 'requested'
          | 'reviewing'
          | 'approved'
          | 'processing'
          | 'paid'
          | 'failed'
          | 'cancelled',
        totalAmountCents: Number(r.totalAmountCents),
        requestedAt: r.requestedAt,
        paidAt: r.paidAt,
        failureReason: r.failureReason,
        gatewayTransactionId: r.gatewayTransactionId,
      }));
    }),

  /**
   * Affiliate-side: request a payout. Sweeps all `available`
   * commissions for this affiliate within the workspace into a single
   * payout row, then flips those commissions to `paid` so the same
   * money can't be withdrawn twice. Producer review still gates the
   * actual money movement (status starts at `requested`).
   *
   * This deliberately runs on `workspaceProcedure` (not a separate
   * affiliate-public surface) — the producer's dashboard is where
   * affiliates currently land via cross-workspace memberships.
   */
  requestPayout: workspaceProcedure
    .input(z.object({ affiliateId: z.string().uuid() }))
    .output(z.object({ payoutId: z.string().uuid(), totalCents: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      // Lock the eligible commissions inside a transaction so two
      // concurrent requests don't include the same row in both
      // payouts. Drizzle proxies SELECT FOR UPDATE via the raw sql
      // tag — simpler than adding a method on the helper.
      return db.transaction(async (tx) => {
        const eligible = await tx
          .select({
            id: schema.affiliateCommissions.id,
            amount: schema.affiliateCommissions.commissionAmountCents,
          })
          .from(schema.affiliateCommissions)
          .where(
            and(
              eq(schema.affiliateCommissions.workspaceId, ctx.workspaceId),
              eq(schema.affiliateCommissions.affiliateId, input.affiliateId),
              eq(schema.affiliateCommissions.status, 'available'),
              isNull(schema.affiliateCommissions.payoutId),
            ),
          )
          .for('update');
        if (eligible.length === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Sem comissões disponíveis para saque.',
          });
        }
        const totalCents = eligible.reduce((sum, c) => sum + Number(c.amount), 0);
        const [payout] = await tx
          .insert(schema.affiliatePayouts)
          .values({
            workspaceId: ctx.workspaceId,
            affiliateId: input.affiliateId,
            status: 'requested',
            totalAmountCents: BigInt(totalCents),
            includedCommissionIds: eligible.map((c) => c.id),
          })
          .returning({ id: schema.affiliatePayouts.id });
        if (!payout) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Falha ao criar payout.',
          });
        }
        // Lock the commissions to this payout. Status stays
        // `available` until the producer flips the payout to `paid`
        // (that's when the commission rows transition to `paid`).
        await tx
          .update(schema.affiliateCommissions)
          .set({ payoutId: payout.id })
          .where(
            inArray(
              schema.affiliateCommissions.id,
              eligible.map((c) => c.id),
            ),
          );
        return { payoutId: payout.id, totalCents };
      });
    }),

  /**
   * Producer flips a payout through the workflow. The actual money
   * dispatch (Pix transfer, bank wire, etc.) is out of scope here —
   * the operator marks `paid` after performing the transfer manually
   * (or via a future integration). When marked `paid` we propagate
   * the status to every commission tied to the payout.
   */
  updatePayoutStatus: workspaceProcedure
    .input(
      z.object({
        payoutId: z.string().uuid(),
        status: z.enum(['reviewing', 'approved', 'processing', 'paid', 'failed', 'cancelled']),
        gatewayTransactionId: z.string().trim().min(2).max(120).optional(),
        failureReason: z.string().trim().min(2).max(500).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      return db.transaction(async (tx) => {
        const [payout] = await tx
          .select({
            id: schema.affiliatePayouts.id,
            status: schema.affiliatePayouts.status,
            includedCommissionIds: schema.affiliatePayouts.includedCommissionIds,
          })
          .from(schema.affiliatePayouts)
          .where(
            and(
              eq(schema.affiliatePayouts.id, input.payoutId),
              eq(schema.affiliatePayouts.workspaceId, ctx.workspaceId),
            ),
          )
          .limit(1);
        if (!payout) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Payout não encontrado.' });
        }
        const patch: Record<string, unknown> = {
          status: input.status,
          reviewedAt: new Date(),
          reviewedByUserId: ctx.userId,
        };
        if (input.gatewayTransactionId !== undefined)
          patch.gatewayTransactionId = input.gatewayTransactionId;
        if (input.failureReason !== undefined) patch.failureReason = input.failureReason;
        if (input.status === 'paid') patch.paidAt = new Date();
        await tx
          .update(schema.affiliatePayouts)
          .set(patch)
          .where(eq(schema.affiliatePayouts.id, input.payoutId));

        const includedIds = (payout.includedCommissionIds as string[]) ?? [];
        if (input.status === 'paid' && includedIds.length > 0) {
          await tx
            .update(schema.affiliateCommissions)
            .set({ status: 'paid', paidAt: new Date() })
            .where(inArray(schema.affiliateCommissions.id, includedIds));
        } else if (input.status === 'cancelled' && includedIds.length > 0) {
          // Release commissions back to the pool so they can be in the
          // next payout request.
          await tx
            .update(schema.affiliateCommissions)
            .set({ payoutId: null })
            .where(inArray(schema.affiliateCommissions.id, includedIds));
        }
        return { ok: true as const };
      });
    }),

  /* =============================== LEADERBOARD =========================== */

  /**
   * Top-N affiliates of this workspace ranked by `available + paid`
   * commission totals across a configurable window. Drives the
   * leaderboard widget on the producer dashboard + the public
   * "Top afiliados" badge on the marketplace listing (PR 4 of Pilar 4).
   */
  leaderboard: workspaceProcedure
    .input(
      z
        .object({
          days: z.enum(['7', '30', '90', 'all']).default('30'),
          limit: z.number().int().min(1).max(50).default(10),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          affiliateId: z.string().uuid(),
          displayName: z.string(),
          publicCode: z.string(),
          commissionCents: z.number().int().nonnegative(),
          attributionCount: z.number().int().nonnegative(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const days = input?.days ?? '30';
      const limit = input?.limit ?? 10;
      const since =
        days === 'all'
          ? sql`'epoch'::timestamptz`
          : sql`now() - make_interval(days => ${Number(days)})`;
      const rows = await ctx.services.db.db
        .select({
          affiliateId: schema.affiliateCommissions.affiliateId,
          displayName: schema.affiliates.displayName,
          publicCode: schema.affiliates.publicCode,
          commissionCents: sql<string>`coalesce(sum(${schema.affiliateCommissions.commissionAmountCents}), 0)`,
          attributionCount: sql<number>`count(distinct ${schema.affiliateCommissions.attributionId})::int`,
        })
        .from(schema.affiliateCommissions)
        .innerJoin(
          schema.affiliates,
          eq(schema.affiliates.id, schema.affiliateCommissions.affiliateId),
        )
        .where(
          and(
            eq(schema.affiliateCommissions.workspaceId, ctx.workspaceId),
            sql`${schema.affiliateCommissions.status} IN ('available', 'paid')`,
            sql`${schema.affiliateCommissions.createdAt} >= ${since}`,
          ),
        )
        .groupBy(
          schema.affiliateCommissions.affiliateId,
          schema.affiliates.displayName,
          schema.affiliates.publicCode,
        )
        .orderBy(sql`sum(${schema.affiliateCommissions.commissionAmountCents}) desc`)
        .limit(limit);
      return rows.map((r) => ({
        affiliateId: r.affiliateId,
        displayName: r.displayName,
        publicCode: r.publicCode,
        commissionCents: Number(r.commissionCents ?? 0),
        attributionCount: Number(r.attributionCount ?? 0),
      }));
    }),

  /* ============================== FRAUD QUEUE ============================ */

  /**
   * Open fraud signals (resolvedAt IS NULL) for producer triage.
   * Filter by severity to focus on `critical` first.
   */
  listFraudSignals: workspaceProcedure
    .input(
      z
        .object({
          severity: z.enum(['info', 'warn', 'critical']).optional(),
          openOnly: z.boolean().default(true),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          affiliateId: z.string().uuid(),
          affiliateName: z.string(),
          signalType: z.string(),
          severity: z.enum(['info', 'warn', 'critical']),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.date(),
          resolvedAt: z.date().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const openOnly = input?.openOnly ?? true;
      const where = and(
        eq(schema.affiliateFraudSignals.workspaceId, ctx.workspaceId),
        input?.severity ? eq(schema.affiliateFraudSignals.severity, input.severity) : undefined,
        openOnly ? isNull(schema.affiliateFraudSignals.resolvedAt) : undefined,
      );
      const rows = await ctx.services.db.db
        .select({
          id: schema.affiliateFraudSignals.id,
          affiliateId: schema.affiliateFraudSignals.affiliateId,
          affiliateName: schema.affiliates.displayName,
          signalType: schema.affiliateFraudSignals.signalType,
          severity: schema.affiliateFraudSignals.severity,
          payload: schema.affiliateFraudSignals.payload,
          createdAt: schema.affiliateFraudSignals.createdAt,
          resolvedAt: schema.affiliateFraudSignals.resolvedAt,
        })
        .from(schema.affiliateFraudSignals)
        .innerJoin(
          schema.affiliates,
          eq(schema.affiliates.id, schema.affiliateFraudSignals.affiliateId),
        )
        .where(where)
        .orderBy(desc(schema.affiliateFraudSignals.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        affiliateId: r.affiliateId,
        affiliateName: r.affiliateName,
        signalType: r.signalType,
        severity: r.severity as 'info' | 'warn' | 'critical',
        payload: (r.payload ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }));
    }),

  resolveFraudSignal: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        note: z.string().trim().min(2).max(500),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.affiliateFraudSignals)
        .set({
          resolvedAt: new Date(),
          resolvedByUserId: ctx.userId,
          resolutionNote: input.note,
        })
        .where(
          and(
            eq(schema.affiliateFraudSignals.id, input.id),
            eq(schema.affiliateFraudSignals.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /* ============================== AUDIT LOG ============================== */

  /**
   * Read-only audit feed for the workspace's affiliate operations.
   * Designed for the compliance tab — never paginated to >100 because
   * an operator scrolling past that point should be filtering instead.
   */
  listAuditLog: workspaceProcedure
    .input(
      z
        .object({
          targetTable: z.string().optional(),
          targetId: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          actorUserId: z.string().uuid().nullable(),
          targetTable: z.string(),
          targetId: z.string(),
          action: z.string(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const where = and(
        eq(schema.affiliateAuditLog.workspaceId, ctx.workspaceId),
        input?.targetTable
          ? eq(schema.affiliateAuditLog.targetTable, input.targetTable)
          : undefined,
        input?.targetId ? eq(schema.affiliateAuditLog.targetId, input.targetId) : undefined,
      );
      const rows = await ctx.services.db.db
        .select({
          id: schema.affiliateAuditLog.id,
          actorUserId: schema.affiliateAuditLog.actorUserId,
          targetTable: schema.affiliateAuditLog.targetTable,
          targetId: schema.affiliateAuditLog.targetId,
          action: schema.affiliateAuditLog.action,
          payload: schema.affiliateAuditLog.payload,
          createdAt: schema.affiliateAuditLog.createdAt,
        })
        .from(schema.affiliateAuditLog)
        .where(where)
        .orderBy(desc(schema.affiliateAuditLog.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        actorUserId: r.actorUserId,
        targetTable: r.targetTable,
        targetId: r.targetId,
        action: r.action,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt,
      }));
    }),
});

// Used by other routers when needed; placeholder for unused-import lint pacification.
export type { ProgramRow as AffiliateProgramRow };
