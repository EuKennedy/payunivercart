/**
 * Input masks for BR forms. Each function takes the raw user-typed
 * string and returns a formatted display string. The caller stores
 * the formatted string in state; the API extracts digits when needed.
 *
 * All masks are progressive — they format whatever the user has so
 * far, never trying to "fix" missing characters. That preserves the
 * native cursor experience while typing.
 */

export function maskCpfCnpj(input: string): string {
  const digits = input.replace(/\D+/g, '').slice(0, 14);
  if (digits.length <= 11) {
    // CPF: 000.000.000-00
    return digits
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  // CNPJ: 00.000.000/0000-00
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

export function maskBrPhone(input: string): string {
  const digits = input.replace(/\D+/g, '').slice(0, 11);
  if (digits.length === 0) return '';
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export function maskCardNumber(input: string): string {
  const digits = input.replace(/\D+/g, '').slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

export function maskCardExpiry(input: string): string {
  const digits = input.replace(/\D+/g, '').slice(0, 4);
  if (digits.length === 0) return '';
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

export function maskDigits(input: string, max: number): string {
  return input.replace(/\D+/g, '').slice(0, max);
}

/** Strip a masked CPF/CNPJ back to digits for API submission. */
export function unmaskDigits(input: string): string {
  return input.replace(/\D+/g, '');
}
