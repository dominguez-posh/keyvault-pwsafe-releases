// App PIN: required before the app unlocks (Entra sign-in, file containers). Stored only as PBKDF2 hash.
// It keeps others out of an unlocked PC for a moment; it does not protect against someone who can edit the
// user's profile (for that: unlock prompt "login" or passkey-protected file containers).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);
const ITERATIONS = 310_000;

export const MIN_PIN_LENGTH = 4;

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(String(pin), salt, ITERATIONS, 32, 'sha256');
  return { v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), iterations: ITERATIONS };
}

export async function verifyPin(pin, record) {
  if (!record?.hash) return false;
  const hash = await pbkdf2(String(pin), Buffer.from(record.salt, 'base64'), record.iterations || ITERATIONS, 32, 'sha256');
  const expected = Buffer.from(record.hash, 'base64');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

/**
 * Wrong attempts: from the 5th on, a growing wait (30 s, 60 s, … up to 15 min). The caller persists toJSON() so a
 * restart of the app does not reset the counter (the PIN check is also reachable from the browser extension).
 */
export class PinGuard {
  constructor(state) {
    this.okUntil = 0;
    this.restore(state);
  }

  restore(state) {
    this.failures = Number(state?.failures) || 0;
    this.blockedUntil = Number(state?.blockedUntil) || 0;
  }

  toJSON() {
    return { failures: this.failures, blockedUntil: this.blockedUntil };
  }

  waitSeconds() {
    return Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000));
  }

  success() {
    this.failures = 0;
    this.blockedUntil = 0;
    this.okUntil = Date.now() + 120_000;
  }

  failure() {
    this.failures++;
    if (this.failures >= 5) this.blockedUntil = Date.now() + Math.min(30_000 * 2 ** (this.failures - 5), 900_000);
  }

  /** PIN verified recently (one unlock per verification). */
  consume() {
    const ok = Date.now() < this.okUntil;
    this.okUntil = 0;
    return ok;
  }
}
