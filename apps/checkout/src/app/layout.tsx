import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';
import { themeBootstrapScript } from '../components/ThemeProvider';

export const metadata: Metadata = {
  title: 'Checkout · payunivercart',
  description: 'Finalize sua compra com segurança',
  // Discourage embedding of the checkout in third-party iframes —
  // payment pages should never be iframed (clickjacking protection).
  other: { 'X-Frame-Options': 'DENY' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/* No-flash dark theme bootstrap — runs before first paint. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted inline bootstrap from ThemeProvider module.
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
