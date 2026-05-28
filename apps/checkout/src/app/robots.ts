import type { MetadataRoute } from 'next';

const CHECKOUT_BASE = process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://pay.univercart.com';

/**
 * Robots. The checkout app hosts two surfaces:
 *   1. `/marketplace` + `/marketplace/<id>` — public catalog; SHOULD
 *      be indexed.
 *   2. `/c/<slug>` — per-buyer checkout pages, often containing
 *      pre-filled customer data via query params. NEVER index these.
 *
 * The sitemap above only emits marketplace entries; this robots.txt
 * makes the policy explicit for crawlers that ignore the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/marketplace'],
        disallow: ['/c/', '/api/'],
      },
    ],
    sitemap: `${CHECKOUT_BASE}/sitemap.xml`,
  };
}
