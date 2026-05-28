import type { Metadata } from 'next';

/**
 * Marketplace SEO surface. The page itself is a client component (uses
 * tRPC hooks for filters + grid), so the static metadata lives on this
 * layout shell. Per-listing pages own their own metadata via the
 * `[id]/page.tsx` route's `generateMetadata` export.
 */
export const metadata: Metadata = {
  title: 'Marketplace · Univercart',
  description:
    'Explore produtos digitais para afiliar. Cursos, mentorias, comunidades, software, e-books e mais — comissão recorrente, atribuição automática.',
  openGraph: {
    title: 'Marketplace Univercart',
    description: 'Produtos digitais abertos pra afiliação. Compra direto do produtor.',
    type: 'website',
    siteName: 'Univercart',
    locale: 'pt_BR',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Marketplace Univercart',
    description: 'Produtos digitais abertos pra afiliação. Compra direto do produtor.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
