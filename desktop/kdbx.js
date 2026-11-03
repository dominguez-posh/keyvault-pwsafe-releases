// KeePass databases (.kdbx, format 3.1 and 4) for the import: decrypted with the master password and/or the key file,
// the protected values unveiled, and handed over as KeePass XML (extension/core/importer.js reads that). Only
// Node's own crypto and zlib; Argon2 (KDBX 4) from hash-wasm – Electron's BoringSSL has no Argon2.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { argon2d, argon2id } from 'hash-wasm';
import { t } from '../extension/core/i18n.js';

const SIG1 = 0x9aa2d903;
const SIG2 = 0xb54bfb67;
const CIPHER_AES = '31c1f2e6bf714350be5805216afc5aff';
const CIPHER_CHACHA = 'd6038a2b8b6f4cb5a524339a31dbb59a';
const CIPHER_TWOFISH = 'ad68f29f576f4bb9a36ad47af965346c';
const KDF_AES = ['c9d9f39a628a4460bf740d08c18a4fea', '7c02bb8279a74ac0927d114a00648238'];
const KDF_ARGON2D = 'ef636ddf8c29444b91f7a9a403e30a0c';
const KDF_ARGON2ID = '9e298b1956db4773b23dfc3ec6f0a1e6';
const SALSA_IV = Buffer.from('e830094b97205d2a', 'hex');

export class KdbxError extends Error {
  constructor(message, code = 'format') {
    super(message);
    this.name = 'KdbxError';
    this.code = code;
  }
}

const wrongKey = () => new KdbxError(t('Falsches Master-Passwort oder falsche Schlüsseldatei'), 'key');
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const sha512 = (...parts) => crypto.createHash('sha512').update(Buffer.concat(parts)).digest();
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** True if the bytes look like a KeePass database (both signatures). */
export function isKdbx(bytes) {
  const b = Buffer.from(bytes);
  return b.length > 12 && b.readUInt32LE(0) === SIG1 && b.readUInt32LE(4) === SIG2;
}

// ---------------------------------------------------------------- stream ciphers (Salsa20, ChaCha20)

const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;

/** Keystream XOR with a running position (inner random stream or ChaCha20 payload). block(counter) → 64 bytes. */
class KeyStream {
  constructor(block) {
    this.block = block;
    this.counter = 0;
    this.buf = Buffer.alloc(0);
    this.pos = 0;
  }

  xor(data) {
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.pos >= this.buf.length) {
        this.buf = this.block(this.counter++);
        this.pos = 0;
      }
      out[i] = data[i] ^ this.buf[this.pos++];
    }
    return out;
  }
}

function salsa20(key, nonce) {
  const k = new Uint32Array(8);
  for (let i = 0; i < 8; i++) k[i] = key.readUInt32LE(i * 4);
  const n = [nonce.readUInt32LE(0), nonce.readUInt32LE(4)];
  const c = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  return new KeyStream((counter) => {
    const s = new Uint32Array([c[0], k[0], k[1], k[2], k[3], c[1], n[0], n[1], counter >>> 0, Math.floor(counter / 2 ** 32) >>> 0, c[2], k[4], k[5], k[6], k[7], c[3]]);
    const x = Uint32Array.from(s);
    const qr = (a, b, cc, d) => {
      x[b] ^= rotl((x[a] + x[d]) >>> 0, 7); x[cc] ^= rotl((x[b] + x[a]) >>> 0, 9);
      x[d] ^= rotl((x[cc] + x[b]) >>> 0, 13); x[a] ^= rotl((x[d] + x[cc]) >>> 0, 18);
    };
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(5, 9, 13, 1); qr(10, 14, 2, 6); qr(15, 3, 7, 11);
      qr(0, 1, 2, 3); qr(5, 6, 7, 4); qr(10, 11, 8, 9); qr(15, 12, 13, 14);
    }
    const out = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, i * 4);
    return out;
  });
}

/** ChaCha20 (RFC 7539): 32-byte key, 12-byte nonce, 32-bit block counter from 0. */
function chacha20(key, nonce) {
  const s0 = new Uint32Array(16);
  s0.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s0[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 3; i++) s0[13 + i] = nonce.readUInt32LE(i * 4);
  return new KeyStream((counter) => {
    const s = Uint32Array.from(s0);
    s[12] = counter >>> 0;
    const x = Uint32Array.from(s);
    const qr = (a, b, c, d) => {
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
    };
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    const out = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, i * 4);
    return out;
  });
}

// ---------------------------------------------------------------- key

/**
 * KeePass key file → 32 bytes: XML (version 1.0 base64, 2.0 hex with checksum), 32 raw bytes, 64 hex characters,
 * anything else hashed.
 */
export function keyFileHash(bytes) {
  const b = Buffer.from(bytes);
  const text = b.toString('utf8');
  if (/<KeyFile[\s>]/.test(text)) {
    const data = /<Data(?:\s+Hash="([0-9a-fA-F]+)")?\s*>([^<]*)<\/Data>/.exec(text);
    if (!data) throw new KdbxError(t('Die Schlüsseldatei ist fehlerhaft'), 'keyfile');
    if (/<Version>\s*2\./.test(text)) {
      const key = Buffer.from(data[2].replace(/\s+/g, ''), 'hex');
      if (data[1] && sha256(key).subarray(0, 4).toString('hex') !== data[1].toLowerCase()) throw new KdbxError(t('Die Schlüsseldatei ist fehlerhaft'), 'keyfile');
      return key;
    }
    return Buffer.from(data[2].trim(), 'base64');
  }
  if (b.length === 32) return b;
  if (b.length === 64 && /^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  return sha256(b);
}

function compositeKey(password, keyFile) {
  const parts = [];
  if (password != null && password !== '') parts.push(sha256(Buffer.from(password, 'utf8')));
  if (keyFile) parts.push(keyFileHash(keyFile));
  if (!parts.length) throw new KdbxError(t('Master-Passwort oder Schlüsseldatei angeben'), 'key');
  return sha256(...parts);
}

/** KDBX 4 key derivation parameters (VariantDictionary). */
function readVariantDictionary(b) {
  const out = {};
  let p = 2;
  for (;;) {
    const type = b[p++];
    if (!type) break;
    const kl = b.readInt32LE(p); p += 4;
    const key = b.subarray(p, p + kl).toString('utf8'); p += kl;
    const vl = b.readInt32LE(p); p += 4;
    const v = b.subarray(p, p + vl); p += vl;
    out[key] = type === 0x04 ? v.readUInt32LE(0) : type === 0x05 ? Number(v.readBigUInt64LE(0)) : type === 0x08 ? v[0] !== 0
      : type === 0x0c ? v.readInt32LE(0) : type === 0x0d ? Number(v.readBigInt64LE(0)) : type === 0x18 ? v.toString('utf8') : Buffer.from(v);
  }
  return out;
}

function aesKdf(key, seed, rounds) {
  const cipher = crypto.createCipheriv('aes-256-ecb', seed, null).setAutoPadding(false);
  let k = Buffer.from(key);
  // Rounds in chunks: one update per round would be slow; ECB encrypts each 16-byte block on its own, so a buffer of
  // the two key blocks is encrypted round after round.
  for (let i = 0; i < rounds; i++) k = cipher.update(k);
  return sha256(k);
}

async function transformKey(composite, kdf) {
  const uuid = kdf.$UUID.toString('hex');
  if (KDF_AES.includes(uuid)) return aesKdf(composite, kdf.S, kdf.R);
  if (uuid === KDF_ARGON2D || uuid === KDF_ARGON2ID) {
    if (kdf.V && kdf.V !== 0x13) throw new KdbxError(t('Diese Argon2-Version wird nicht unterstützt'));
    if (kdf.A?.length) throw new KdbxError(t('Unbekanntes Schlüsselverfahren in der KeePass-Datei'));
    const tag = await (uuid === KDF_ARGON2D ? argon2d : argon2id)({
      password: composite, salt: kdf.S, parallelism: kdf.P, iterations: kdf.I, memorySize: Math.floor(kdf.M / 1024), hashLength: 32,
      outputType: 'binary', ...(kdf.K?.length ? { secret: kdf.K } : {}),
    });
    return Buffer.from(tag);
  }
  throw new KdbxError(t('Unbekanntes Schlüsselverfahren in der KeePass-Datei'));
}

// ---------------------------------------------------------------- file

function readHeader(b) {
  const minor = b.readUInt16LE(8);
  const major = b.readUInt16LE(10);
  if (major !== 3 && major !== 4) throw new KdbxError(t('Diese KeePass-Version wird nicht unterstützt ({version})', { version: `${major}.${minor}` }));
  const fields = {};
  let p = 12;
  for (;;) {
    const id = b[p];
    const size = major === 4 ? b.readUInt32LE(p + 1) : b.readUInt16LE(p + 1);
    p += major === 4 ? 5 : 3;
    const data = b.subarray(p, p + size);
    p += size;
    if (id === 0) break;
    fields[id] = Buffer.from(data);
  }
  return { major, fields, end: p };
}

function decryptPayload(cipherId, key, iv, data) {
  if (cipherId === CIPHER_AES) {
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([d.update(data), d.final()]);
    } catch {
      throw wrongKey();
    }
  }
  if (cipherId === CIPHER_CHACHA) return chacha20(key, iv).xor(data);
  if (cipherId === CIPHER_TWOFISH) throw new KdbxError(t('KeePass-Dateien mit Twofish-Verschlüsselung werden nicht unterstützt – in KeePass auf AES oder ChaCha20 umstellen'));
  throw new KdbxError(t('Unbekannte Verschlüsselung in der KeePass-Datei'));
}

function innerStream(id, key) {
  if (id === 2) return salsa20(sha256(key), SALSA_IV);
  if (id === 3) {
    const h = sha512(key);
    return chacha20(h.subarray(0, 32), h.subarray(32, 44));
  }
  throw new KdbxError(t('Unbekannter Schutz der Kennwörter in der KeePass-Datei'));
}

/** Protected values (passwords, hidden fields) in document order: un-XORed with the inner stream. */
function unprotectXml(xml, stream) {
  return xml.replace(/<(\w+)((?:\s+[\w:]+="[^"]*")*?\s+Protected="True"(?:\s+[\w:]+="[^"]*")*)\s*(\/>|>([^<]*)<\/\1>)/g, (all, tag, attrs, rest, content) => {
    const plain = stream.xor(Buffer.from(content || '', 'base64'));
    if (tag !== 'Value') return `<${tag}${attrs}/>`;
    const text = plain.toString('utf8').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<${tag}${attrs}>${text}</${tag}>`;
  });
}

/**
 * Decrypts a .kdbx file → KeePass XML with plain values. password and/or keyFile (bytes of the key file) as set in
 * KeePass. Throws KdbxError (code 'key' for a wrong password/key file).
 */
export async function decryptKdbx(bytes, { password = '', keyFile = null } = {}) {
  const b = Buffer.from(bytes);
  if (!isKdbx(b)) throw new KdbxError(t('Keine KeePass-Datei (.kdbx)'));
  const { major, fields, end } = readHeader(b);
  const cipherId = fields[2]?.toString('hex');
  const compressed = fields[3]?.readUInt32LE(0) === 1;
  const masterSeed = fields[4];
  const iv = fields[7];
  const composite = compositeKey(password, keyFile);
  if (major === 3) {
    const transformed = await transformKey(composite, { $UUID: Buffer.from(KDF_AES[0], 'hex'), S: fields[5], R: Number(fields[6].readBigUInt64LE(0)) });
    const plain = decryptPayload(cipherId, sha256(masterSeed, transformed), iv, b.subarray(end));
    if (!plain.subarray(0, 32).equals(fields[9])) throw wrongKey();
    const blocks = [];
    for (let p = 32; p < plain.length;) {
      const hash = plain.subarray(p + 4, p + 36);
      const size = plain.readUInt32LE(p + 36);
      p += 40;
      if (size === 0) break;
      const data = plain.subarray(p, p + size);
      if (!sha256(data).equals(hash)) throw new KdbxError(t('Die KeePass-Datei ist beschädigt'));
      blocks.push(data);
      p += size;
    }
    const content = compressed ? zlib.gunzipSync(Buffer.concat(blocks)) : Buffer.concat(blocks);
    return unprotectXml(content.toString('utf8'), innerStream(fields[10].readUInt32LE(0), fields[8]));
  }
  // KDBX 4: header checked by HMAC (wrong key shows here), payload in HMAC-protected blocks, inner header in front.
  const transformed = await transformKey(composite, readVariantDictionary(fields[11]));
  const hmacBase = sha512(masterSeed, transformed, Buffer.from([1]));
  const blockKey = (index) => sha512(u64(index), hmacBase);
  const header = b.subarray(0, end);
  if (!sha256(header).equals(b.subarray(end, end + 32))) throw new KdbxError(t('Die KeePass-Datei ist beschädigt'));
  if (!crypto.createHmac('sha256', blockKey(2n ** 64n - 1n)).update(header).digest().equals(b.subarray(end + 32, end + 64))) throw wrongKey();
  const blocks = [];
  for (let p = end + 64, index = 0; p < b.length; index++) {
    const mac = b.subarray(p, p + 32);
    const size = b.readInt32LE(p + 32);
    const data = b.subarray(p + 36, p + 36 + size);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32LE(size);
    if (!crypto.createHmac('sha256', blockKey(index)).update(Buffer.concat([u64(index), sizeBuf, data])).digest().equals(mac)) {
      throw new KdbxError(t('Die KeePass-Datei ist beschädigt'));
    }
    if (size === 0) break;
    blocks.push(data);
    p += 36 + size;
  }
  const plain = decryptPayload(cipherId, sha256(masterSeed, transformed), iv, Buffer.concat(blocks));
  const content = compressed ? zlib.gunzipSync(plain) : plain;
  let p = 0;
  let streamId = 0;
  let streamKey = null;
  for (;;) {
    const id = content[p];
    const size = content.readUInt32LE(p + 1);
    const data = content.subarray(p + 5, p + 5 + size);
    p += 5 + size;
    if (id === 0) break;
    if (id === 1) streamId = data.readUInt32LE(0);
    if (id === 2) streamKey = Buffer.from(data);
  }
  return unprotectXml(content.subarray(p).toString('utf8'), innerStream(streamId, streamKey));
}
