// Encoding and crypto helpers. Web-standard APIs only, so the same module runs in the
// extension (service worker, pages) and in the desktop app (Electron main and renderer).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Binärdaten erwartet');
}

export function concat(...parts) {
  const arrays = parts.map(toBytes);
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function b64uEncode(data) {
  const bytes = toBytes(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Accepts base64url and standard base64, with or without padding.
export function b64uDecode(text) {
  const s = String(text).trim().replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const toHex = (data) => Array.from(toBytes(data), (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('Ungültige Hex-Zeichenfolge');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesEqual(a, b) {
  a = toBytes(a);
  b = toBytes(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : toBytes(data)));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/** Cuts a string to at most maxBytes UTF-8 bytes without splitting a character. */
export function truncateBytes(text, maxBytes) {
  let s = String(text ?? '');
  while (utf8(s).length > maxBytes) s = s.slice(0, -1);
  return s;
}

// Runs fn over items with at most `limit` calls in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1];
  if (!part) throw new Error('Ungültiges Token');
  return JSON.parse(fromUtf8(b64uDecode(part)));
}
