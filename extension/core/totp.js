// TOTP (RFC 6238) for one-time codes stored in items: otpauth:// URIs or bare Base32 secrets.

import { t } from './i18n.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const s = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(t('Ungültiges TOTP-Geheimnis (Base32 erwartet)'));
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function parseTotp(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const config = { secret: null, digits: 6, period: 30, algorithm: 'SHA-1', issuer: '', account: '' };
  if (/^otpauth:\/\//i.test(s)) {
    const url = new URL(s);
    if (url.hostname.toLowerCase() !== 'totp') throw new Error(t('Nur TOTP wird unterstützt'));
    const p = url.searchParams;
    config.secret = base32Decode(p.get('secret') || '');
    config.digits = Number(p.get('digits')) || 6;
    config.period = Number(p.get('period')) || 30;
    const alg = (p.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
    config.algorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[alg] || 'SHA-1';
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const [issuer, account] = label.includes(':') ? label.split(':', 2) : ['', label];
    config.issuer = p.get('issuer') || issuer;
    config.account = account;
  } else {
    config.secret = base32Decode(s);
  }
  if (!config.secret.length) throw new Error(t('TOTP-Geheimnis ist leer'));
  return config;
}

export async function hotp(secret, counter, digits = 6, algorithm = 'SHA-1') {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Current code plus seconds until it changes. */
export async function totpCode(input, now = Date.now()) {
  const cfg = typeof input === 'string' ? parseTotp(input) : input;
  if (!cfg) return null;
  const seconds = Math.floor(now / 1000);
  const code = await hotp(cfg.secret, Math.floor(seconds / cfg.period), cfg.digits, cfg.algorithm);
  return { code, remaining: cfg.period - (seconds % cfg.period), period: cfg.period };
}
