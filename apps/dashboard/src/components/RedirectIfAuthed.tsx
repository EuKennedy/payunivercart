'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '../lib/auth';

/**
 * Inverse of `AppShellGuard` — keeps already-logged-in users out of
 * the auth pages (`/login`, `/signup`). The previous behaviour rendered
 * the form anyway, which let a returning visitor "log in again" while
 * holding a perfectly valid session, then bounce them to /dashboard
 * after submit. Same end state, but visibly confusing.
 *
 * Implementation mirrors `AppShellGuard`: we wait for the
 * `useSession()` hook to resolve, render a neutral blank while it's
 * pending, and `router.replace('/dashboard')` whenever a session is
 * present. `redirectTo` lets the caller change the destination (used
 * by signup to land on onboarding when wired up).
 */
export function RedirectIfAuthed({
  children,
  redirectTo = '/dashboard',
}: {
  children: React.ReactNode;
  redirectTo?: string;
}) {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session.isPending && session.data) {
      router.replace(redirectTo);
    }
  }, [session.isPending, session.data, router, redirectTo]);

  if (session.isPending || session.data) {
    return <div className="min-h-screen bg-[var(--color-bg)]" />;
  }

  return <>{children}</>;
}
