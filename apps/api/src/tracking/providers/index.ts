import type { TrackingAdapter, TrackingProvider } from '../types';
import { ga4Adapter } from './ga4';
import { googleAdsAdapter } from './google-ads';
import { kwaiAdapter } from './kwai';
import { metaAdapter } from './meta';
import { pinterestAdapter } from './pinterest';
import { tiktokAdapter } from './tiktok';

/**
 * Provider registry. Add a new adapter here when its file lands. The
 * dispatcher pulls adapters through `getAdapter()` so future code
 * (e.g. a router validation step) never has to switch on the provider
 * string directly.
 *
 * Shipped: Meta CAPI, GA4 Measurement Protocol, TikTok Events API
 * v1.3, Google Ads Enhanced Conversions, Pinterest Conversions API,
 * Kwai Pixel API — all six providers Pilar 2 promised.
 */
const ADAPTERS: Record<TrackingProvider, TrackingAdapter | null> = {
  meta: metaAdapter,
  ga4: ga4Adapter,
  tiktok: tiktokAdapter,
  google_ads: googleAdsAdapter,
  pinterest: pinterestAdapter,
  kwai: kwaiAdapter,
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
