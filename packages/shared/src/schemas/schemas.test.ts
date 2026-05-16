import { describe, expect, it } from 'vitest';
import { checkoutCustomerSchema, cnpjSchema, cpfSchema, documentSchema } from './index';

describe('cpfSchema (zod + checksum)', () => {
  it('accepts a valid formatted CPF and returns the digits-only form', () => {
    const r = cpfSchema.parse('111.444.777-35');
    expect(r).toBe('11144477735');
  });

  it('accepts a valid digits-only CPF', () => {
    expect(cpfSchema.parse('52998224725')).toBe('52998224725');
  });

  it('rejects a regex-passing but checksum-failing CPF', () => {
    // 11 digits, looks like a CPF, but the last digit is wrong.
    expect(() => cpfSchema.parse('11144477730')).toThrow(/checksum/);
  });

  it('rejects an all-same-digit sentinel that the algorithm would pass', () => {
    // 00000000000 mathematically passes mod-11 — the algorithm's blind
    // spot the Receita explicitly reserves.
    expect(() => cpfSchema.parse('00000000000')).toThrow(/checksum/);
  });

  it('rejects shape-wrong input at the regex layer (not checksum)', () => {
    expect(() => cpfSchema.parse('not-a-cpf')).toThrow(/format/);
  });
});

describe('cnpjSchema (zod + checksum)', () => {
  it('accepts a valid formatted CNPJ', () => {
    expect(cnpjSchema.parse('11.222.333/0001-81')).toBe('11222333000181');
  });

  it('rejects a checksum-failing CNPJ', () => {
    expect(() => cnpjSchema.parse('11222333000180')).toThrow(/checksum/);
  });

  it('rejects all-zero sentinel', () => {
    expect(() => cnpjSchema.parse('00000000000000')).toThrow(/checksum/);
  });
});

describe('documentSchema (CPF or CNPJ)', () => {
  it('accepts a valid CPF', () => {
    expect(documentSchema.parse('11144477735')).toBe('11144477735');
  });

  it('accepts a valid CNPJ', () => {
    expect(documentSchema.parse('11222333000181')).toBe('11222333000181');
  });

  it('rejects bad input that fits neither shape', () => {
    expect(() => documentSchema.parse('12345')).toThrow();
  });

  it('rejects a CPF that hits the CPF regex but fails checksum', () => {
    // 11 digits => routes through cpfSchema; rejected at checksum step.
    expect(() => documentSchema.parse('11144477730')).toThrow();
  });
});

describe('checkoutCustomerSchema — end-to-end', () => {
  const goodCustomer = {
    name: 'Joana Silva',
    email: 'JOANA@example.COM',
    document: '111.444.777-35',
    phoneRaw: '+55 31 98495-6383',
  };

  it('accepts a well-formed customer and lowercases the email', () => {
    const parsed = checkoutCustomerSchema.parse(goodCustomer);
    expect(parsed.email).toBe('joana@example.com');
    expect(parsed.document).toBe('11144477735');
  });

  it('rejects when document fails checksum', () => {
    expect(() =>
      checkoutCustomerSchema.parse({ ...goodCustomer, document: '111.444.777-30' }),
    ).toThrow();
  });

  it('rejects when phone is too long', () => {
    expect(() =>
      checkoutCustomerSchema.parse({ ...goodCustomer, phoneRaw: '+55'.padEnd(40, '1') }),
    ).toThrow();
  });
});
