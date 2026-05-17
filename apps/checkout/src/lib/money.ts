/**
 * Format integer cents into a locale-aware currency string.
 *   formatCents(49700, 'BRL') → "R$ 497,00"
 */
export function formatCents(cents: number, currency: 'BRL' | 'USD' | 'EUR' = 'BRL'): string {
  const locale = currency === 'BRL' ? 'pt-BR' : currency === 'USD' ? 'en-US' : 'de-DE';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
