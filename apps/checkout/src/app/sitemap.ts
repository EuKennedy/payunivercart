import type { MetadataRoute } from 'next';

/**
 * Public sitemap. Pulls live marketplace listings from the API and
 * emits one URL per active listing + the marketplace landing. The
 * checkout app is consumer-facing — search engines index the
 * marketplace, never the per-buyer `/c/<slug>` checkout (those are
 * personal transactions, not catalog pages).
 *
 * Revalidated hourly via Next's built-in cache so a new listing
 * appears in the sitemap within ~60 min of publication without DB
 * hammering on every crawl.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.univercart.com';
const CHECKOUT_BASE = process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://pay.univercart.com';

interface PublicListing {
  id: string;
  publishedAt: string | null;
}

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    {
      url: `${CHECKOUT_BASE}/marketplace`,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
  ];

  try {
    const url = new URL(`${API_BASE}/trpc/marketplace.browse`);
    url.searchParams.set('input', JSON.stringify({ json: { limit: 48 } }));
    const res = await fetch(url.toString(), {
      next: { revalidate: 3600 },
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return entries;
    const body = (await res.json()) as {
      result?: { data?: { items?: PublicListing[] } };
    };
    const items = body.result?.data?.items ?? [];
    for (const item of items) {
      entries.push({
        url: `${CHECKOUT_BASE}/marketplace/${item.id}`,
        lastModified: item.publishedAt ? new Date(item.publishedAt) : undefined,
        changeFrequency: 'daily',
        priority: 0.6,
      });
    }
  } catch {
    // Best-effort — return the static entry if the API hiccups so the
    // sitemap is never an empty 200 response.
  }
  return entries;
}
