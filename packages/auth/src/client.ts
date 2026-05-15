import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';

/**
 * Browser-side Better-Auth client. Imported by `apps/dashboard` (and any
 * other Next.js front that authenticates against `apps/api`).
 *
 * `baseURL` MUST be the same origin the api serves Better-Auth on — by
 * convention `${API_URL}/api/auth`. The dashboard reads `API_URL` from
 * its own env and passes it here at client construction time.
 */
export function createPayunivercartAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [emailOTPClient()],
  });
}

export type PayunivercartAuthClient = ReturnType<typeof createPayunivercartAuthClient>;
