import {
  PayunivercartError,
  mintOrganizationSlug,
  slugifyEmailLocalPart,
} from '@payunivercart/shared';
import { eq } from 'drizzle-orm';
import type { WorkspaceDb, WorkspaceTx } from './rls';
import * as schema from './schema/index';

/**
 * Atomic provisioning of organization + workspace + owner membership for a
 * brand-new user.
 *
 * Why this lives in `packages/db` and not in `packages/auth`
 * ----------------------------------------------------------
 * Better-Auth's `databaseHooks.user.create.after` fires AFTER the user row
 * has been committed by Better-Auth's Drizzle adapter — there is no shared
 * transaction we can join. We open our own transaction here and the auth
 * hook (in `packages/auth/server.ts`) compensates by deleting the user row
 * when this throws. Net effect: signup either fully succeeds (user + org +
 * workspace + membership all exist) or fully fails (no rows persisted).
 *
 * RLS posture
 * -----------
 * The current `apps/api` connection uses the Postgres superuser provisioned
 * by Coolify's bundled Postgres image. Superusers bypass RLS regardless of
 * `FORCE ROW LEVEL SECURITY`, so the inserts below succeed even though the
 * `organizations` policy requires an EXISTS lookup that's only satisfiable
 * AFTER the workspace row exists.
 *
 * The hardening block will introduce a dedicated `payunivercart_provision`
 * role with `BYPASSRLS` and a separate connection string. When that lands,
 * `WorkspaceDb` here will be swapped to that connection only at the call
 * site (services.ts) — this module's signature does not change.
 */

export interface ProvisionWorkspaceInput {
  /** UUID emitted by Better-Auth for the newly-created user. */
  userId: string;
  /** Lower-case email already validated by Better-Auth. */
  email: string;
  /** Optional display name. Falls back to the email local-part. */
  name: string;
}

export interface ProvisionedWorkspace {
  organizationId: string;
  workspaceId: string;
  membershipId: string;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_SLUG_RETRIES = 2;

/**
 * Default cart-recovery cadence — proven intervals from BR digital
 * product funnels. Each step is a separate WhatsApp message at the
 * delay (minutes) after the order entered `pending_payment`.
 *
 * Templates use mustache-style placeholders resolved by the worker:
 *   {nome}    → customer first name
 *   {produto} → first order-item name
 *   {valor}   → formatCents(totalCents, currency)
 *   {codigo}  → order public reference (UNV-XXXXXXXX)
 */
export const DEFAULT_RECOVERY_STEPS = [
  {
    delayMinutes: 15,
    channel: 'whatsapp' as const,
    template:
      'Oi {nome}! Faltou só o pagamento do *{produto}*. Seu Pix de *{valor}* já tá reservado — finaliza aqui pra liberar o acesso imediato. Pedido {codigo}.',
  },
  {
    delayMinutes: 120,
    channel: 'whatsapp' as const,
    template:
      'Oi {nome}, separei sua vaga em *{produto}* mas o Pix expira em algumas horas. Conclui em segundos: total *{valor}*. Pedido {codigo}.',
  },
  {
    delayMinutes: 720,
    channel: 'whatsapp' as const,
    template:
      'Última chance, {nome}. Seu pedido {codigo} de *{produto}* ({valor}) expira nas próximas horas. Se algo deu errado, me chama.',
  },
];

export type RecoveryStep = (typeof DEFAULT_RECOVERY_STEPS)[number];

/**
 * Provision `(organization, workspace, owner membership)` for `userId`.
 *
 * - One retry on a slug collision (23505 on `organizations_slug_unique`).
 * - All three writes share the same Drizzle transaction; any failure
 *   rolls them all back.
 * - Returns the newly-minted ids so callers can audit-log or eagerly
 *   set the tenant cookie.
 *
 * Wrapper that opens its own transaction. Callers already inside a
 * transaction (e.g. `listOrProvisionMemberships`, which holds a per-user
 * advisory lock to serialize self-heal attempts) should instead use
 * `provisionWorkspaceInTx` and pass their own `tx`.
 */
export async function provisionWorkspaceForUser(
  db: WorkspaceDb,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  return db.transaction((tx) => provisionWorkspaceInTx(tx, input));
}

/**
 * Same as `provisionWorkspaceForUser` but operates on an existing
 * Drizzle transaction. The 23505 retry uses Drizzle's nested-transaction
 * (savepoint) so a slug collision rolls back JUST the failed attempt's
 * inserts, not the outer transaction.
 */
export async function provisionWorkspaceInTx(
  tx: WorkspaceTx,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  const baseName = (input.name ?? '').trim() || slugifyEmailLocalPart(input.email);

  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    const orgSlug = mintOrganizationSlug(input.email);
    try {
      return await tx.transaction(async (savepoint) => {
        const [org] = await savepoint
          .insert(schema.organizations)
          .values({
            slug: orgSlug,
            name: baseName,
            ownerId: input.userId,
            onboardingCompleted: false,
          })
          .returning({ id: schema.organizations.id });
        if (!org) {
          throw new PayunivercartError({
            code: 'INTERNAL',
            message: 'organizations insert returned no row',
          });
        }

        const [workspace] = await savepoint
          .insert(schema.workspaces)
          .values({
            organizationId: org.id,
            slug: 'default',
            name: baseName,
          })
          .returning({ id: schema.workspaces.id });
        if (!workspace) {
          throw new PayunivercartError({
            code: 'INTERNAL',
            message: 'workspaces insert returned no row',
          });
        }

        const [membership] = await savepoint
          .insert(schema.memberships)
          .values({
            workspaceId: workspace.id,
            userId: input.userId,
            role: 'owner',
            invitedById: null,
            acceptedAt: new Date(),
          })
          .returning({ id: schema.memberships.id });
        if (!membership) {
          throw new PayunivercartError({
            code: 'INTERNAL',
            message: 'memberships insert returned no row',
          });
        }

        // Seed the default recovery campaign — three WhatsApp touches
        // with intervals proven on Hotmart/Eduzz funnels (15min, 2h,
        // 12h). Producer can edit later from the dashboard.
        await savepoint.insert(schema.recoveryCampaigns).values({
          workspaceId: workspace.id,
          name: 'Padrão',
          isActive: true,
          triggerWindowMinutes: 30,
          steps: DEFAULT_RECOVERY_STEPS,
        });

        return {
          organizationId: org.id,
          workspaceId: workspace.id,
          membershipId: membership.id,
        };
      });
    } catch (cause) {
      const pgCode = (cause as { code?: string })?.code;
      if (pgCode === POSTGRES_UNIQUE_VIOLATION && attempt < MAX_SLUG_RETRIES - 1) {
        // Slug collision — retry once with a fresh suffix. Log so we can
        // tell signal from noise if the retry rate ever climbs.
        process.stdout.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'workspace.bootstrap.slugRetry',
            email: input.email,
            attempted: orgSlug,
          })}\n`,
        );
        continue;
      }
      throw cause;
    }
  }

  throw new PayunivercartError({
    code: 'INTERNAL',
    message: 'workspace provisioning exhausted retries',
  });
}

/**
 * Compensation path: delete a freshly-created user when the workspace
 * bootstrap fails. Cascading FKs clean up sessions/accounts that
 * Better-Auth may have inserted before the hook fired.
 *
 * Best-effort by design — the caller logs failures but does not throw
 * over them, because the original signup error is more useful to the
 * end user than a cleanup-failed message. A separate reconciliation job
 * sweeps orphan users (zero memberships, older than 1h) on a schedule.
 */
export async function deleteUserById(db: WorkspaceDb, userId: string): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}
