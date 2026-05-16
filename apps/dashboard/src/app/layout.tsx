import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '../components/Providers';

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
