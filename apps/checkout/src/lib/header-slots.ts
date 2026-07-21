/**
 * Render order of the three top-of-page bands on the public checkout.
 *
 * The producer's **brand bar comes first** so "UniverTech · Checkout
 * seguro · Conexão criptografada" is always pinned to the very top of
 * the page. The promotional banner is a hero that sits *beneath* the
 * brand bar — never above it. The scarcity/countdown strip is last, so
 * it hugs the form.
 *
 * Regression guard: an earlier build rendered `banner → brand → timer`,
 * which buried the brand bar inside the banner strip (it looked like the
 * header was broken/overlapping the artwork). `ProducerHeader` renders
 * exactly these slots in exactly this order by mapping over this array,
 * so the array is the single source of truth — the JSX and the intended
 * order cannot drift, and `header-slots.test.ts` fails if the brand bar
 * ever falls below the banner again.
 */
export const CHECKOUT_HEADER_SLOT_ORDER = ['brand', 'banner', 'timer'] as const;

export type CheckoutHeaderSlot = (typeof CHECKOUT_HEADER_SLOT_ORDER)[number];
