import { describe, expect, it } from 'vitest';
import { PhoneNormalizationError, digitsToChatId, isParseablePhone, normalizePhone } from './index';

describe('normalizePhone — Brazilian mobile guess', () => {
  it('parses national format and produces stripped guess for post-2012 accounts', () => {
    const result = normalizePhone('(31) 98495-6383');
    expect(result.e164).toBe('+5531984956383');
    expect(result.digits).toBe('5531984956383');
    expect(result.guessedWahaChatId).toBe('553184956383@c.us');
    expect(result.country).toBe('BR');
    expect(result.valid).toBe(true);
    expect(result.raw).toBe('(31) 98495-6383');
  });

  it('parses full E.164 input', () => {
    const result = normalizePhone('+55 31 98495-6383');
    expect(result.e164).toBe('+5531984956383');
    expect(result.guessedWahaChatId).toBe('553184956383@c.us');
  });

  it('parses digits-only national input', () => {
    const result = normalizePhone('31984956383');
    expect(result.e164).toBe('+5531984956383');
  });

  it('parses digits-only international input', () => {
    const result = normalizePhone('5531984956383');
    expect(result.e164).toBe('+5531984956383');
  });

  it('keeps BR fixed-line numbers as-is (no 9 to strip)', () => {
    const result = normalizePhone('+55 31 3333-4444');
    expect(result.guessedWahaChatId).toBe('553133334444@c.us');
  });
});

describe('normalizePhone — international numbers', () => {
  it('handles US numbers in canonical E.164', () => {
    const result = normalizePhone('+1 415 555 2671');
    expect(result.e164).toBe('+14155552671');
    expect(result.country).toBe('US');
  });

  it('handles Portuguese numbers in canonical E.164', () => {
    const result = normalizePhone('+351 912 345 678');
    expect(result.e164).toBe('+351912345678');
    expect(result.country).toBe('PT');
  });

  it('respects defaultCountry when DDI is absent', () => {
    const result = normalizePhone('912 345 678', { defaultCountry: 'PT' });
    expect(result.country).toBe('PT');
    expect(result.e164).toBe('+351912345678');
  });

  it('does not strip leading 9 outside Brazil', () => {
    // Hutchison 3G UK mobile range (074xx)
    const result = normalizePhone('+44 7400 123456');
    expect(result.country).toBe('GB');
    expect(result.guessedWahaChatId).toBe('447400123456@c.us');
  });
});

describe('normalizePhone — error handling', () => {
  it('throws PhoneNormalizationError on empty input', () => {
    expect(() => normalizePhone('   ')).toThrow(PhoneNormalizationError);
  });

  it('throws PhoneNormalizationError on unparseable input', () => {
    expect(() => normalizePhone('abc')).toThrow(PhoneNormalizationError);
  });

  it('rejects inputs longer than 32 chars before libphonenumber sees them', () => {
    const huge = '+55'.padEnd(2_000, '1');
    try {
      normalizePhone(huge);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PhoneNormalizationError);
      expect((err as PhoneNormalizationError).code).toBe('TOO_LONG');
      // The echoed input is truncated so we don't log megabytes.
      expect((err as PhoneNormalizationError).input.length).toBeLessThan(80);
    }
  });

  it('accepts inputs exactly at the 32-char limit', () => {
    // 32 chars including the + and country code is generously beyond any
    // real number, but small enough not to trip the cap.
    const just = '+555533'.padEnd(32, '1');
    expect(just).toHaveLength(32);
    // Some such strings won't parse, but the cap MUST NOT fire — they
    // should reach libphonenumber.
    try {
      normalizePhone(just);
    } catch (err) {
      expect((err as PhoneNormalizationError).code).not.toBe('TOO_LONG');
    }
  });
});

describe('digitsToChatId', () => {
  it('appends @c.us suffix', () => {
    expect(digitsToChatId('553184956383')).toBe('553184956383@c.us');
  });
});

describe('isParseablePhone', () => {
  it('returns true for valid numbers', () => {
    expect(isParseablePhone('+55 31 98495-6383')).toBe(true);
    expect(isParseablePhone('(31) 98495-6383')).toBe(true);
  });

  it('returns false for nonsense', () => {
    expect(isParseablePhone('hello')).toBe(false);
    expect(isParseablePhone('')).toBe(false);
  });
});
