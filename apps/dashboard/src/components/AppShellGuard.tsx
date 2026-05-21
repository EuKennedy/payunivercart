'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '../lib/auth';

/**
 * Client-side gate for the authenticated app shell. Wraps every page
 * under the `(app)` route group so unauthenticated visitors land on
 * `/login` instead of seeing a half-rendered sidebar.
 *
 * Why a client gate and not an RSC fetch?
 *   Better-Auth's session cookie is scoped to the API origin
 *   (`api.univercart.com`). The dashboard's RSC layer (`app.univercart.com`)
 *   does not see that cookie from `cookies()`. We could enable
 *   `crossSubDomainCookies` on Better-Auth so a `.univercart.com`-scoped
 *   cookie is visible to both subdomains — that hardening lands in a
 *   separate block. For now, the client-side `useSession()` hook hits
 *   `api.univercart.com/api/auth/get-session` directly (the browser
 *   carries the cookie), and we redirect on the resolved-but-empty
 *   case.
 */
export function AppShellGuard({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && !session.data) {
      router.replace('/login');
    }
  }, [session.isPending, session.data, router]);

  // While the session resolves we render a neutral background. Showing
  // the sidebar / page chrome with empty data would flash a logged-out
  // state at logged-in users and a logged-in state at logged-out users.
  if (session.isPending || !session.data) {
    return <div className="min-h-screen bg-[var(--color-bg)]" />;
  }

  return <>{children}</>;
}
