/**
 * Brazilian document (CPF / CNPJ) validators that go beyond regex.
 *
 * A regex-only check passes any 11-digit string for a CPF and any
 * 14-digit string for a CNPJ — including the "all-zeros" / "all-ones"
 * sentinels that the Receita Federal explicitly reserves and any value
 * a typo-prone customer might enter. Tax IDs are written into orders,
 * sent to gateways for KYC/anti-fraud, and stored as PII; an invalid
 * one creates support tickets at best and gateway rejections at worst.
 *
 * These validators implement the modulo-11 algorithm defined by the
 * Receita Federal so the call site can refuse garbage at the boundary
 * instead of paying for it downstream.
 *
 * Inputs may include the canonical punctuation (`123.456.789-09`,
 * `12.345.678/0001-95`) — we strip it before validating. Outputs are
 * the pure digit string when valid, or `null` when invalid.
 */

const CPF_LENGTH = 11;
const CNPJ_LENGTH = 14;

/* -------------------------------------------------------------------------- */
/*  CPF                                                                        */
/* -------------------------------------------------------------------------- */

const CPF_FIRST_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_SECOND_WEIGHTS = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Returns the digits-only CPF when the modulo-11 check passes, `null`
 * otherwise. Rejects punctuation-shaped input that hits the regex but
 * has the wrong digit count, all-same-digit sequences (00000000000,
 * 11111111111, …) which the algorithm accepts mathematically but the
 * Receita reserves, and any actually-invalid checksum.
 */
export function validateCpf(input: string): string | null {
  const digits = onlyDigits(input);
  if (digits.length !== CPF_LENGTH) return null;
  if (allSameDigit(digits)) return null;

  const body = digits.slice(0, 9);
  const d1 = checkDigit(body, CPF_FIRST_WEIGHTS);
  const d2 = checkDigit(`${body}${d1}`, CPF_SECOND_WEIGHTS);
  if (`${body}${d1}${d2}` !== digits) return null;
  return digits;
}

/* -------------------------------------------------------------------------- */
/*  CNPJ                                                                       */
/* -------------------------------------------------------------------------- */

const CNPJ_FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_SECOND_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function validateCnpj(input: string): string | null {
  const digits = onlyDigits(input);
  if (digits.length !== CNPJ_LENGTH) return null;
  if (allSameDigit(digits)) return null;

  const body = digits.slice(0, 12);
  const d1 = checkDigit(body, CNPJ_FIRST_WEIGHTS);
  const d2 = checkDigit(`${body}${d1}`, CNPJ_SECOND_WEIGHTS);
  if (`${body}${d1}${d2}` !== digits) return null;
  return digits;
}

/* -------------------------------------------------------------------------- */
/*  Format helpers                                                              */
/* -------------------------------------------------------------------------- */

export function formatCpf(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length !== CPF_LENGTH) return digits;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function formatCnpj(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length !== CNPJ_LENGTH) return digits;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/* -------------------------------------------------------------------------- */
/*  Shared mod-11                                                              */
/* -------------------------------------------------------------------------- */

function onlyDigits(input: string): string {
  return input.replace(/\D/g, '');
}

function allSameDigit(digits: string): boolean {
  return digits.length > 0 && /^(\d)\1+$/.test(digits);
}

/**
 * Modulo-11 check digit. For each `weight[i]`, multiply by digit i,
 * sum, take `sum % 11`. If the remainder is 0 or 1, the check digit
 * is `0`; otherwise it is `11 - remainder`. This is the algorithm
 * common to CPF and CNPJ.
 */
function checkDigit(body: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    const digit = Number(body[i]);
    const weight = weights[i];
    if (!Number.isFinite(digit) || weight === undefined) return -1;
    sum += digit * weight;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}
