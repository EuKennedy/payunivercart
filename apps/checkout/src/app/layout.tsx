import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';

export const metadata: Metadata = {
  title: 'Checkout · payunivercart',
  description: 'Finalize sua compra com segurança',
  // Discourage embedding of the checkout in third-party iframes —
  // payment pages should never be iframed (clickjacking protection).
  other: { 'X-Frame-Options': 'DENY' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
