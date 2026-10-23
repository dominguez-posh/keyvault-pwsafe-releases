// Password generator with unbiased random selection (rejection sampling).

import { t } from './i18n.js';

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
};
const AMBIGUOUS = /[Il1O0o|`'"]/g;

function randomIndex(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

export const DEFAULT_OPTIONS = { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true };

export function generatePassword(options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const length = Math.max(4, Math.min(128, Number(o.length) || 20));
  const groups = Object.keys(SETS)
    .filter((k) => o[k])
    .map((k) => (o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));
  if (!groups.length) groups.push(SETS.lower);
  const all = groups.join('');
  // One character from each selected group, the rest from all, then shuffle.
  const chars = groups.map((g) => g[randomIndex(g.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join('');
}

/** Rough entropy estimate for the strength meter: { bits, label, level 0..4 }. */
export function passwordStrength(password) {
  const pw = String(password || '');
  if (!pw) return { bits: 0, label: '', level: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 32;
  const unique = new Set(pw).size;
  const bits = Math.round(Math.log2(pool || 1) * Math.min(pw.length, unique * 2));
  const level = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, level, label: ['', t('schwach'), t('mittel'), t('gut'), t('stark')][level] };
}
