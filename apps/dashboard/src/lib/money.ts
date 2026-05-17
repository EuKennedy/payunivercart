/**
 * Money helpers — bidirectional translation between an integer-cents
 * domain model and the producer's input in pt-BR (`R$ 1.234,56`).
 *
 * The cents-as-integer invariant is a non-negotiable across the stack
 * (gateways, audit chain, ledger). The display layer is the ONLY place
 * we render or accept a decimal string; everywhere else passes bigint
 * or number-of-cents.
 */

export const SUPPORTED_CURRENCIES = ['BRL', 'USD', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const localePerCurrency: Record<Currency, string> = {
  BRL: 'pt-BR',
  USD: 'en-US',
  EUR: 'de-DE',
};

/**
 * Cents → display string. `formatCents(9990, 'BRL')` → `"R$ 99,90"`.
 */
export function formatCents(cents: number, currency: Currency = 'BRL'): string {
  return new Intl.NumberFormat(localePerCurrency[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Display string → cents. Accepts the loose set of formats producers
 * actually type:
 *   "99,90"     → 9990
 *   "99.90"     → 9990
 *   "R$ 99,90"  → 9990
 *   "1.234,56"  → 123456
 *   "1,234.56"  → 123456
 *
 * Returns NaN when the input is unparseable so callers can show a
 * field-level error.
 */
export function parseCentsBRL(input: string): number {
  const trimmed = input.replace(/[^0-9,.\-]/g, '').trim();
  if (!trimmed) return Number.NaN;

  // If both `,` and `.` appear, the one that appears LAST is the
  // decimal separator (handles both "1.234,56" and "1,234.56").
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = trimmed; // pure integer
  } else if (lastComma > lastDot) {
    // comma is decimal
    normalized = trimmed.replace(/\./g, '').replace(',', '.');
  } else {
    // dot is decimal
    normalized = trimmed.replace(/,/g, '');
  }

  const asFloat = Number.parseFloat(normalized);
  if (!Number.isFinite(asFloat)) return Number.NaN;

  // Round to nearest cent to absorb floating-point noise from
  // multiplication.
  return Math.round(asFloat * 100);
}
