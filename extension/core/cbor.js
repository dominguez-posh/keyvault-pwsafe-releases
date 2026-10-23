// Minimal CBOR (RFC 8949) for WebAuthn: integers, byte/text strings, arrays, maps, simple values.
// Maps keep insertion order; callers insert keys in CTAP2 canonical order.

import { utf8, fromUtf8, toBytes } from './util.js';

export function encode(value) {
  const out = [];

  const head = (major, n) => {
    const m = major << 5;
    if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    else {
      const hi = Math.floor(n / 0x100000000);
      const lo = n >>> 0;
      out.push(m | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
        (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
    }
  };
  const bytes = (b) => {
    for (let i = 0; i < b.length; i++) out.push(b[i]);
  };

  const enc = (v) => {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new TypeError('CBOR: nur Ganzzahlen werden unterstützt');
      if (v >= 0) head(0, v);
      else head(1, -1 - v);
    } else if (typeof v === 'string') {
      const b = utf8(v);
      head(3, b.length);
      bytes(b);
    } else if (v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const b = toBytes(v);
      head(2, b.length);
      bytes(b);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(enc);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, x] of v) {
        enc(k);
        enc(x);
      }
    } else if (v === false) out.push(0xf4);
    else if (v === true) out.push(0xf5);
    else if (v === null) out.push(0xf6);
    else if (v === undefined) out.push(0xf7);
    else if (typeof v === 'object') {
      const entries = Object.entries(v);
      head(5, entries.length);
      for (const [k, x] of entries) {
        enc(k);
        enc(x);
      }
    } else throw new TypeError(`CBOR: Typ ${typeof v} nicht unterstützt`);
  };

  enc(value);
  return Uint8Array.from(out);
}

// Decodes one item starting at offset. Returns [value, nextOffset]. Maps decode to Map.
export function decodeFirst(input, offset = 0) {
  const b = toBytes(input);
  let pos = offset;

  const need = (n) => {
    if (pos + n > b.length) throw new Error('CBOR: unerwartetes Ende');
  };
  const readLength = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('CBOR: unbestimmte Längen werden nicht unterstützt');
    need(size);
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + b[pos++];
    return n;
  };

  const dec = () => {
    need(1);
    const first = b[pos++];
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: return readLength(info);
      case 1: return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        need(n);
        const v = b.slice(pos, pos + n);
        pos += n;
        return v;
      }
      case 3: {
        const n = readLength(info);
        need(n);
        const v = fromUtf8(b.subarray(pos, pos + n));
        pos += n;
        return v;
      }
      case 4: {
        const n = readLength(info);
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(dec());
        return arr;
      }
      case 5: {
        const n = readLength(info);
        const map = new Map();
        for (let i = 0; i < n; i++) {
          const k = dec();
          map.set(k, dec());
        }
        return map;
      }
      case 6:
        readLength(info);
        return dec();
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error('CBOR: Gleitkommazahlen werden nicht unterstützt');
      default:
        throw new Error('CBOR: ungültiges Format');
    }
  };

  const value = dec();
  return [value, pos];
}

export function decode(input) {
  const b = toBytes(input);
  const [value, end] = decodeFirst(b, 0);
  if (end !== b.length) throw new Error('CBOR: überzählige Bytes');
  return value;
}
