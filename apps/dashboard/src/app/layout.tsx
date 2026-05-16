import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';

// See apps/admin/src/app/layout.tsx for the rationale. The dashboard is
// also a per-user authenticated surface — there's nothing for the SSG
// pass to cache that we don't already serve dynamically.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'payunivercart',
  description: 'Facilitador de pagamento para produtores digitais',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
