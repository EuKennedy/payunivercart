import { describe, expect, it } from 'vitest';
import { formatCnpj, formatCpf, validateCnpj, validateCpf } from './index.js';

/**
 * Test data: deterministic, public-domain CPFs that pass the Receita
 * mod-11 algorithm. The first set was generated for testing and is the
 * canonical example most BR validator libraries cite. Real customer
 * CPFs are NEVER hard-coded anywhere; these are throwaway test values.
 */
const VALID_CPFS = [
  // raw,             with punctuation
  ['52998224725', '529.982.247-25'],
  ['11144477735', '111.444.777-35'],
  // The "12345678909" pattern is a fictional CPF widely used in BR test
  // fixtures because it both passes mod-11 and is recognizable as fake.
  ['12345678909', '123.456.789-09'],
] as const;

const VALID_CNPJS = [
  ['11444777000161', '11.444.777/0001-61'],
  ['11222333000181', '11.222.333/0001-81'],
] as const;

/* -------------------------------------------------------------------------- */
/*  CPF                                                                        */
/* -------------------------------------------------------------------------- */

describe('validateCpf', () => {
  it.each(VALID_CPFS)('accepts canonical CPF %s', (raw) => {
    expect(validateCpf(raw)).toBe(raw);
  });

  it.each(VALID_CPFS)('accepts formatted CPF %s', (raw, formatted) => {
    expect(validateCpf(formatted)).toBe(raw);
  });

  it('rejects empty string', () => {
    expect(validateCpf('')).toBeNull();
  });

  it('rejects strings of wrong length', () => {
    expect(validateCpf('1234567890')).toBeNull(); // 10 digits
    expect(validateCpf('123456789012')).toBeNull(); // 12 digits
  });

  it('rejects all-same-digit sentinels', () => {
    for (let d = 0; d <= 9; d++) {
      expect(validateCpf(String(d).repeat(11))).toBeNull();
    }
  });

  it('rejects an invalid checksum (last digit off by one)', () => {
    expect(validateCpf('52998224726')).toBeNull();
    expect(validateCpf('11144477734')).toBeNull();
  });

  it('rejects an invalid checksum (middle digit off by one)', () => {
    const base = '52998224725';
    const mutated = `${base.slice(0, 5)}8${base.slice(6)}`;
    expect(validateCpf(mutated)).toBeNull();
  });

  it('rejects non-digits inside the number', () => {
    expect(validateCpf('abc.456.789-09')).toBeNull();
  });

  it('strips punctuation before validating', () => {
    expect(validateCpf('111.444.777-35')).toBe('11144477735');
  });
});

/* -------------------------------------------------------------------------- */
/*  CNPJ                                                                       */
/* -------------------------------------------------------------------------- */

describe('validateCnpj', () => {
  it.each(VALID_CNPJS)('accepts canonical CNPJ %s', (raw) => {
    expect(validateCnpj(raw)).toBe(raw);
  });

  it.each(VALID_CNPJS)('accepts formatted CNPJ %s', (raw, formatted) => {
    expect(validateCnpj(formatted)).toBe(raw);
  });

  it('rejects empty string', () => {
    expect(validateCnpj('')).toBeNull();
  });

  it('rejects strings of wrong length', () => {
    expect(validateCnpj('1144477700016')).toBeNull(); // 13 digits
    expect(validateCnpj('114447770001611')).toBeNull(); // 15 digits
  });

  it('rejects all-same-digit sentinels', () => {
    for (let d = 0; d <= 9; d++) {
      expect(validateCnpj(String(d).repeat(14))).toBeNull();
    }
  });

  it('rejects an invalid checksum', () => {
    expect(validateCnpj('11444777000162')).toBeNull();
    expect(validateCnpj('11222333000182')).toBeNull();
  });

  it('strips punctuation before validating', () => {
    expect(validateCnpj('11.222.333/0001-81')).toBe('11222333000181');
  });
});

/* -------------------------------------------------------------------------- */
/*  formatters                                                                 */
/* -------------------------------------------------------------------------- */

describe('formatCpf / formatCnpj', () => {
  it('formats an 11-digit CPF', () => {
    expect(formatCpf('11144477735')).toBe('111.444.777-35');
  });

  it('formats a 14-digit CNPJ', () => {
    expect(formatCnpj('11444777000161')).toBe('11.444.777/0001-61');
  });

  it('returns input unchanged when length is wrong', () => {
    expect(formatCpf('1234')).toBe('1234');
    expect(formatCnpj('1234')).toBe('1234');
  });

  it('handles already-formatted input idempotently', () => {
    expect(formatCpf('111.444.777-35')).toBe('111.444.777-35');
    expect(formatCnpj('11.444.777/0001-61')).toBe('11.444.777/0001-61');
  });
});
