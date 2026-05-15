import {
  type CountryCode,
  type NumberType,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from 'libphonenumber-js';

export type PhoneCountryCode = CountryCode;

export interface NormalizedPhone {
  /** Exactly what the user typed — keep this for UI display and audit. */
  raw: string;
  /** Canonical E.164 with leading `+`, e.g. "+5531984956383". Billing, dedupe, audit. */
  e164: string;
  /** Digits-only E.164 (no `+`), the *input* to WAHA's `check-exists` resolver. */
  digits: string;
  /** A best-effort chat-id guess (BR pre-2012 stripping). NEVER send to WAHA without resolving via `check-exists` first; this is for fallback only. */
  guessedWahaChatId: string;
  /** Country (ISO-3166-1 alpha-2). */
  country: PhoneCountryCode;
  /** Country calling code, e.g. "55". */
  countryCallingCode: string;
  /** National significant number without country code. */
  nationalNumber: string;
  /** True when the number is a valid mobile/fixed line for its country. */
  valid: boolean;
  /** Type as reported by libphonenumber (MOBILE | FIXED_LINE | ...). */
  type: ReturnType<typeof parseType>;
}

export interface NormalizeOptions {
  /** Country to assume when input has no DDI/country code. Defaults to BR. */
  defaultCountry?: PhoneCountryCode;
}

const BR_COUNTRY_CALLING_CODE = '55';

/**
 * Maximum accepted length of the raw input. ITU-T E.164 caps phone numbers
 * at 15 digits; with country prefix, formatting punctuation, and a couple
 * of leading characters we generously allow 32 — enough for every real
 * phone number on Earth, low enough that an attacker who controls the
 * input cannot feed multi-MB strings into libphonenumber-js.
 */
const MAX_PHONE_INPUT_LENGTH = 32;

/**
 * Parse and canonicalize a phone number for the platform.
 *
 * IMPORTANT: This function does NOT decide the final WAHA chatId. The chatId
 * depends on whether the WhatsApp account was created before or after the
 * 2012 BR mobile renumbering, which can only be known by querying WAHA's
 * `check-exists` endpoint. Use `packages/waha`'s resolver for delivery; use
 * this function only for storage, validation, and UI formatting.
 */
export function normalizePhone(input: string, options: NormalizeOptions = {}): NormalizedPhone {
  const defaultCountry: PhoneCountryCode = options.defaultCountry ?? 'BR';
  const raw = input.trim();

  if (raw.length === 0) {
    throw new PhoneNormalizationError('Phone input is empty', 'EMPTY_INPUT', raw);
  }
  // Length cap BEFORE handing the string to libphonenumber-js — defends
  // against an attacker feeding multi-MB inputs into the parser.
  if (raw.length > MAX_PHONE_INPUT_LENGTH) {
    throw new PhoneNormalizationError(
      `Phone input exceeds ${MAX_PHONE_INPUT_LENGTH} characters`,
      'TOO_LONG',
      // Truncate the echoed value so we don't log the entire blob.
      `${raw.slice(0, 16)}…(${raw.length} chars)`,
    );
  }

  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed) {
    throw new PhoneNormalizationError(`Could not parse phone number "${raw}"`, 'PARSE_FAILED', raw);
  }

  const country: PhoneCountryCode = parsed.country ?? defaultCountry;
  const countryCallingCode = getCountryCallingCode(country);
  const e164 = parsed.number;
  const digits = e164.replace(/^\+/, '');
  const nationalNumber = parsed.nationalNumber;
  const valid = isValidPhoneNumber(e164);
  const type = parseType(parsed.getType());

  const guessedWahaChatId =
    countryCallingCode === BR_COUNTRY_CALLING_CODE
      ? `${buildBrazilianWahaGuess(countryCallingCode, nationalNumber)}@c.us`
      : `${digits}@c.us`;

  return {
    raw,
    e164,
    digits,
    guessedWahaChatId,
    country,
    countryCallingCode,
    nationalNumber,
    valid,
    type,
  };
}

/**
 * Build the BR post-2012 chat-id guess. Many WhatsApp accounts created before
 * 2012 won't match this — always resolve via `check-exists` for delivery.
 */
function buildBrazilianWahaGuess(callingCode: string, national: string): string {
  if (national.length === 11) {
    const ddd = national.slice(0, 2);
    const ninthDigit = national.charAt(2);
    const subscriber = national.slice(3);

    if (ninthDigit === '9') {
      return `${callingCode}${ddd}${subscriber}`;
    }
  }
  return `${callingCode}${national}`;
}

function parseType(t: NumberType | undefined): NumberType | 'UNKNOWN' {
  return t ?? 'UNKNOWN';
}

/** Cheap predicate when you just want to know if a string is parseable. */
export function isParseablePhone(input: string, defaultCountry: PhoneCountryCode = 'BR'): boolean {
  return parsePhoneNumberFromString(input, defaultCountry)?.isValid() ?? false;
}

/** Convert raw digits into a WAHA chatId by appending `@c.us`. */
export function digitsToChatId(digits: string): string {
  return `${digits}@c.us`;
}

export class PhoneNormalizationError extends Error {
  readonly code: 'EMPTY_INPUT' | 'PARSE_FAILED' | 'TOO_LONG';
  readonly input: string;

  constructor(message: string, code: PhoneNormalizationError['code'], input: string) {
    super(message);
    this.name = 'PhoneNormalizationError';
    this.code = code;
    this.input = input;
  }
}
