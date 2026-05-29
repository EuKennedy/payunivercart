import { describe, expect, it } from 'vitest';
import { truncateUtf8 } from './truncate';

describe('truncateUtf8', () => {
  it('returns input unchanged when within limit', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('truncates ASCII to exact byte limit', () => {
    expect(truncateUtf8('abcdefghij', 5)).toBe('abcde');
  });

  it('returns empty string for zero limit', () => {
    expect(truncateUtf8('abc', 0)).toBe('');
  });

  it('does not slice through a 2-byte char (Latin extended)', () => {
    // 'ção' = 4 bytes (c=1 + ç=2 + ã=2 + o=1). Wait: c=1, ç=2, ã=2, o=1 → 6
    // 'çã' = 4 bytes. Test slicing right before final char.
    const input = 'açb';
    expect(Buffer.byteLength(input, 'utf8')).toBe(4);
    // maxBytes = 2 should produce 'a' (1 byte) — 'ç' would push to 3 > 2.
    expect(truncateUtf8(input, 2)).toBe('a');
    expect(truncateUtf8(input, 3)).toBe('aç');
    expect(truncateUtf8(input, 4)).toBe('açb');
  });

  it('does not slice through a 3-byte char (CJK)', () => {
    // '中' = 3 bytes UTF-8
    const cjk = '中国';
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(6);
    expect(truncateUtf8(cjk, 5)).toBe('中'); // dropping the second char
    expect(truncateUtf8(cjk, 3)).toBe('中');
    expect(truncateUtf8(cjk, 2)).toBe(''); // can't fit a single char
  });

  it('does not slice through a 4-byte emoji', () => {
    // '🎉' = 4 bytes (surrogate pair in JS).
    const emoji = 'a🎉b';
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(6);
    expect(truncateUtf8(emoji, 5)).toBe('a🎉');
    expect(truncateUtf8(emoji, 4)).toBe('a'); // emoji would push to 5
    expect(truncateUtf8(emoji, 1)).toBe('a');
  });

  it('handles long mixed string at exact byte boundary', () => {
    const input = 'Recibo de João 🇧🇷 R$ 199,90';
    const bytes = Buffer.byteLength(input, 'utf8');
    // sanity
    expect(bytes).toBeGreaterThan(input.length);
    const out = truncateUtf8(input, 12);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(12);
    // never produces the replacement char
    expect(out).not.toContain('\uFFFD');
  });

  it('empty input returns empty', () => {
    expect(truncateUtf8('', 100)).toBe('');
    expect(truncateUtf8('', 0)).toBe('');
  });

  it('output is always valid UTF-8 round-trippable', () => {
    const inputs = ['simple', 'ção', '中文', '🎉🎊🎈', 'mixed João 中文 🎉 R$'];
    for (const s of inputs) {
      for (let n = 0; n <= Buffer.byteLength(s, 'utf8') + 2; n++) {
        const out = truncateUtf8(s, n);
        // re-encode then decode — no replacement char
        const reencoded = Buffer.from(out, 'utf8').toString('utf8');
        expect(reencoded).toBe(out);
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(n);
      }
    }
  });
});
