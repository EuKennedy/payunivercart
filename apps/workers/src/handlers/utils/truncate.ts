/**
 * UTF-8-safe string truncation.
 *
 * Truncate a string so its UTF-8 byte representation stays at or under
 * `maxBytes`. Iterates by Unicode code point (not by JS char) so a
 * 4-byte emoji or 3-byte CJK character never gets sliced through the
 * middle (which would yield a U+FFFD replacement character on read).
 *
 * Used by the webhook outbox dispatcher to persist gateway response
 * bodies within the database column's byte limit without corrupting
 * customer names, product titles, or any other Unicode payload coming
 * back from the receiver.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let bytes = 0;
  let out = '';
  for (const ch of input) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}
