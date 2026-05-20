import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';
import { themeBootstrapScript } from '../components/ThemeProvider';

export const metadata: Metadata = {
  title: 'payunivercart',
  description:
    'Plataforma de pagamento para criadores e operadores digitais. Catálogo, checkout customizável, recuperação automática.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
         * No-flash theme bootstrap. Runs synchronously before the body
         * paints — sets `data-theme="dark"` on <html> when the user
         * previously picked dark. Without this the first frame would
         * paint light then flip dark, which is visually jarring on a
         * dark-mode preferring user.
         */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted inline bootstrap (static string from our own ThemeProvider module).
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
