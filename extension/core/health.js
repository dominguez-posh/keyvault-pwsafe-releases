// Health of the stored data: expiry dates of entries and the quality of passwords (weak, reused, old). Pure
// functions – the desktop app adds the network part (Have I Been Pwned range check) on top.

import { passwordStrength } from './generator.js';

export const EXPIRY_SOON_DAYS = 30;
export const OLD_PASSWORD_DAYS = 365;

const DAY = 86_400_000;

/** 'YYYY-MM-DD' → '' | 'soon' (within EXPIRY_SOON_DAYS) | 'expired' */
export function expiryState(expires, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires || '')) return '';
  const end = Date.parse(`${expires}T23:59:59Z`);
  if (Number.isNaN(end)) return '';
  if (end < now) return 'expired';
  return end - now <= EXPIRY_SOON_DAYS * DAY ? 'soon' : '';
}

/** Calendar days until the date (0 = today, negative when it has passed). */
export function daysUntil(expires, now = Date.now()) {
  return Math.floor((Date.parse(`${expires}T23:59:59Z`) - now) / DAY);
}

/** Entries (summaries or items with `expires`) that are expired or expire soon, soonest first. */
export function expiringEntries(list, now = Date.now()) {
  return list
    .map((e) => ({ entry: e, state: expiryState(e.expires, now) }))
    .filter((x) => x.state)
    .sort((a, b) => a.entry.expires.localeCompare(b.entry.expires));
}

/**
 * Password problems of full items: weak (strength level 0–1), reused (same password in several entries) and
 * old (not changed for OLD_PASSWORD_DAYS). Notes and entries without a password are skipped.
 * → { items: [{ key, title, containerId, username, weak, reused, old, strength }], counts }
 */
export function passwordReport(items, now = Date.now()) {
  const withPassword = items.filter((i) => i.type !== 'note' && i.password);
  const uses = new Map();
  for (const i of withPassword) uses.set(i.password, (uses.get(i.password) || 0) + 1);
  const out = withPassword.map((i) => {
    const strength = passwordStrength(i.password);
    const changed = Date.parse(i.passwordChanged || i.updated || i.created || '') || 0;
    return {
      key: i.key, title: i.title, containerId: i.containerId, username: i.username, folder: i.folder || '',
      strength: strength.level,
      weak: strength.level <= 1,
      reused: uses.get(i.password) > 1,
      old: changed > 0 && now - changed > OLD_PASSWORD_DAYS * DAY,
      pwned: i.pwnedCount || null, // set by the HIBP check (count of leaks) when the user allows it
    };
  }).filter((r) => r.weak || r.reused || r.old || r.pwned);
  return {
    items: out,
    counts: {
      checked: withPassword.length,
      weak: out.filter((r) => r.weak).length,
      reused: out.filter((r) => r.reused).length,
      old: out.filter((r) => r.old).length,
      pwned: out.filter((r) => r.pwned).length,
    },
  };
}

/** SHA-1 of a password split for the HIBP range API (k-anonymity: only the first 5 hex digits leave the PC). */
export async function hibpParts(password) {
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

/** Number of leaks for a suffix in a range response ("SUFFIX:COUNT" lines; padded responses contain ":0"). */
export function hibpCount(rangeText, suffix) {
  for (const line of String(rangeText).split(/\r?\n/)) {
    const [s, n] = line.trim().split(':');
    if (s === suffix) return Number(n) || 0;
  }
  return 0;
}
