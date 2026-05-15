import './globals.css';
import type { Metadata } from 'next';

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
