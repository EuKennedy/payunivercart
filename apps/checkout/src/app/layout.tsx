import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Checkout',
  description: 'Finalize sua compra com segurança',
  // Discourage embedding of the checkout in third-party iframes — payment
  // pages should never be iframed (clickjacking protection).
  other: { 'X-Frame-Options': 'DENY' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
