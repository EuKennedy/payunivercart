import type { TrackingAdapter, TrackingProvider } from '../types';
import { metaAdapter } from './meta';

/**
 * Provider registry. Add a new adapter here when its file lands. The
 * dispatcher pulls adapters through `getAdapter()` so future code
 * (e.g. a router validation step) never has to switch on the provider
 * string directly.
 *
 * Why only Meta today: it covers the vast majority of BR producer
 * traffic. GA4 / TikTok / Pinterest land in follow-up PRs of Pilar 2
 * once Meta's plumbing is proven end-to-end against a real pixel.
 */
const ADAPTERS: Record<TrackingProvider, TrackingAdapter | null> = {
  meta: metaAdapter,
  google_ads: null,
  ga4: null,
  tiktok: null,
  pinterest: null,
  kwai: null,
};

export function getAdapter(provider: TrackingProvider): TrackingAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`Tracking provider not implemented yet: ${provider}`);
  }
  return adapter;
}

export function isProviderSupported(provider: TrackingProvider): boolean {
  return ADAPTERS[provider] !== null;
}
