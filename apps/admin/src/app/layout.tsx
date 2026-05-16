import './globals.css';
import type { Metadata } from 'next';

// Force every route under this layout to be rendered on demand. The
// internal `/_global-error` SSG worker in Next 16.1/16.2 crashes on
// linux/amd64 (Docker) with "TypeError: useContext", and force-dynamic
// at the layout level skips the entire static-prerender pass for the
// admin app. Admin pages are operator-only and never benefit from SSG
// caching anyway.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'payunivercart · admin',
  description: 'Painel de operação interno',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
