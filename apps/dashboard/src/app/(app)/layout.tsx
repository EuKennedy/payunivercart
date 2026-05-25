import { AppShellGuard } from '../../components/AppShellGuard';
import { OnboardingFloating } from '../../components/OnboardingFloating';
import { Sidebar } from '../../components/Sidebar';

/**
 * Authenticated shell. Side-to-side layout: fixed sidebar +
 * scrollable content. `AppShellGuard` redirects unauthenticated
 * visitors to `/login` before any child page renders, eliminating the
 * "logged-out flash of sidebar" that the previous per-page client
 * guards allowed.
 *
 * `OnboardingFloating` is mounted at the layout root so the floating
 * widget follows the producer across every authenticated page (it
 * hides itself when onboarding is completed/dismissed, so other
 * surfaces aren't visually polluted).
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShellGuard>
      <div className="flex min-h-screen bg-[var(--color-bg)]">
        <Sidebar />
        <main className="flex-1 overflow-x-hidden">
          <div className="mx-auto max-w-6xl px-10 py-12">{children}</div>
        </main>
        <OnboardingFloating />
      </div>
    </AppShellGuard>
  );
}
