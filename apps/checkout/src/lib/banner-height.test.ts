import {
  CHECKOUT_BANNER_HEIGHT_MAX_PX,
  CHECKOUT_BANNER_HEIGHT_MIN_PX,
} from '@payunivercart/shared/constants';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_BANNER_MOBILE_MAX_PX, resolveBannerHeights } from './banner-height';

describe('resolveBannerHeights', () => {
  it('returns null when no height is set (legacy thin banner)', () => {
    expect(resolveBannerHeights(null)).toBeNull();
    expect(resolveBannerHeights(undefined)).toBeNull();
  });

  it('honours a chosen desktop height verbatim', () => {
    expect(resolveBannerHeights(450)).toEqual({ desktopPx: 450, mobilePx: 300 });
  });

  it('caps the mobile height so a tall banner does not bury the form', () => {
    expect(resolveBannerHeights(550)?.mobilePx).toBe(CHECKOUT_BANNER_MOBILE_MAX_PX);
    expect(resolveBannerHeights(550)?.desktopPx).toBe(550);
  });

  it('keeps mobile equal to desktop for short banners (below the cap)', () => {
    expect(resolveBannerHeights(180)).toEqual({ desktopPx: 180, mobilePx: 180 });
  });

  it('clamps out-of-range values into [MIN, MAX] defensively', () => {
    expect(resolveBannerHeights(20)?.desktopPx).toBe(CHECKOUT_BANNER_HEIGHT_MIN_PX);
    expect(resolveBannerHeights(9999)?.desktopPx).toBe(CHECKOUT_BANNER_HEIGHT_MAX_PX);
  });

  it('rounds fractional values', () => {
    expect(resolveBannerHeights(220.6)?.desktopPx).toBe(221);
  });

  it('ignores non-finite garbage', () => {
    expect(resolveBannerHeights(Number.NaN)).toBeNull();
    expect(resolveBannerHeights(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
