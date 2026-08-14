/**
 * Standard base64, implemented locally rather than via `btoa` / `atob` / `Buffer` so that
 * `@polymind-inc/agent-framework-core` stays runtime-agnostic (Node, Deno, Bun, workers, browsers) without
 * platform-specific APIs.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET[i] as string] = i;
  }
  return table;
})();

/** Encodes bytes as standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
  const output = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let outputIndex = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    output[outputIndex++] = BASE64_ALPHABET.charCodeAt((triplet >> 18) & 63);
    output[outputIndex++] = BASE64_ALPHABET.charCodeAt((triplet >> 12) & 63);
    output[outputIndex++] = b1 === undefined ? 61 : BASE64_ALPHABET.charCodeAt((triplet >> 6) & 63);
    output[outputIndex++] = b2 === undefined ? 61 : BASE64_ALPHABET.charCodeAt(triplet & 63);
  }
  return new TextDecoder().decode(output);
}

/** Decodes standard base64 into bytes. Characters outside the alphabet (including padding) are ignored. */
export function decodeBase64(value: string): Uint8Array {
  let sextetCount = 0;
  for (const char of value) {
    if (BASE64_LOOKUP[char] !== undefined) sextetCount++;
  }
  const output = new Uint8Array(Math.floor((sextetCount * 6) / 8));
  let outputIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const sextet = BASE64_LOOKUP[char];
    if (sextet === undefined) {
      continue;
    }
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return output;
}
