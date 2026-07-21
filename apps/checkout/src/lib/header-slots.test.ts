import { describe, expect, it } from 'vitest';
import { CHECKOUT_HEADER_SLOT_ORDER } from './header-slots';

/**
 * `ProducerHeader` maps over CHECKOUT_HEADER_SLOT_ORDER to render its
 * three bands, so this array IS the render order. These assertions are
 * the regression guard for the "brand bar buried inside the banner"
 * bug: the brand bar must render first (pinned to the top), the promo
 * banner must sit below it, and the scarcity strip stays last.
 */
describe('CHECKOUT_HEADER_SLOT_ORDER', () => {
  it('renders the brand bar first so it is pinned to the top of the page', () => {
    expect(CHECKOUT_HEADER_SLOT_ORDER[0]).toBe('brand');
  });

  it('places the promo banner below the brand bar, never above it', () => {
    expect(CHECKOUT_HEADER_SLOT_ORDER.indexOf('brand')).toBeLessThan(
      CHECKOUT_HEADER_SLOT_ORDER.indexOf('banner'),
    );
  });

  it('keeps the scarcity timer as the last band, hugging the form', () => {
    expect(CHECKOUT_HEADER_SLOT_ORDER.at(-1)).toBe('timer');
  });

  it('contains exactly the three known slots with no duplicates', () => {
    expect([...CHECKOUT_HEADER_SLOT_ORDER].sort()).toEqual(['banner', 'brand', 'timer']);
  });
});
