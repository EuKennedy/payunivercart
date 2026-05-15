import { Sidebar } from '../../components/Sidebar.js';

/**
 * Authenticated shell. Side-to-side layout the founder requested: fixed
 * sidebar + scrollable content. Auth-guarding lives inside individual
 * pages via `useSession`; we redirect from there to keep the shell SSR-
 * compatible.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-8 py-10">{children}</div>
      </main>
    </div>
  );
}
