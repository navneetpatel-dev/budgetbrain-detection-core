/**
 * UTF-8 bytes of a string. Uses `TextEncoder` when the runtime has it and encodes by hand
 * otherwise (older Hermes builds have no `TextEncoder`), so the fingerprint is the same everywhere.
 */
export function utf8Bytes(text: string): Uint8Array {
  const Encoder = (globalThis as { TextEncoder?: new () => { encode(input: string): Uint8Array } }).TextEncoder;
  if (Encoder) return new Encoder().encode(text);
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // lone surrogate, as TextEncoder does
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(bytes);
}
