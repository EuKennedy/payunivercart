import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';

export const metadata: Metadata = {
  title: 'payunivercart',
  description:
    'Plataforma de pagamento para criadores e operadores digitais. Catálogo, checkout customizável, recuperação automática.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
