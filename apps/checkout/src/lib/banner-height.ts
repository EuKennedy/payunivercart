import {
  CHECKOUT_BANNER_HEIGHT_MAX_PX,
  CHECKOUT_BANNER_HEIGHT_MIN_PX,
} from '@payunivercart/shared/constants';

/**
 * On phones a producer-chosen desktop height (which can be up to 600px)
 * would eat the whole viewport before the buyer sees a single field, so
 * the mobile render is capped at this value. Desktop honours the chosen
 * height verbatim.
 */
export const CHECKOUT_BANNER_MOBILE_MAX_PX = 300;

export interface ResolvedBannerHeights {
  desktopPx: number;
  mobilePx: number;
}

/**
 * Turn the stored `checkout_banner_height_px` into the two heights the
 * checkout renders (desktop + mobile).
 *
 * Returns `null` when the producer never set a height — the caller then
 * keeps the legacy capped-`max-h` thin banner. Any stored value is
 * clamped into `[MIN, MAX]` defensively (the write path already enforces
 * the range, but the public checkout must never trust the column blindly)
 * and the mobile height is capped so a tall desktop banner doesn't bury
 * the form on a phone.
 */
export function resolveBannerHeights(
  heightPx: number | null | undefined,
): ResolvedBannerHeights | null {
  if (heightPx == null || !Number.isFinite(heightPx)) return null;
  const desktopPx = Math.min(
    CHECKOUT_BANNER_HEIGHT_MAX_PX,
    Math.max(CHECKOUT_BANNER_HEIGHT_MIN_PX, Math.round(heightPx)),
  );
  return { desktopPx, mobilePx: Math.min(desktopPx, CHECKOUT_BANNER_MOBILE_MAX_PX) };
}
