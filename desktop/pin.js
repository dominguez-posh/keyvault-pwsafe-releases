// App PIN: required before the app unlocks (Entra sign-in, file containers). Stored only as PBKDF2 hash.
// It keeps others out of an unlocked PC for a moment; it does not protect against someone who can edit the
// user's profile (for that: unlock prompt "login" or passkey-protected file containers).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);
const ITERATIONS = 310_000;

// #475: 6 since 2026-11-08 (before 4). Shorter PINs set earlier keep working; verifying one marks the record `short`
// so settings and the lock screen ask to change it.
export const MIN_PIN_LENGTH = 6;

export const isShortPin = (pin) => String(pin ?? '').length < MIN_PIN_LENGTH;

// #472 (review): settings that only the PIN functions write (setPin, verifyPin, the PIN guard, binding the personal
// vault). A settings patch from the window must not set, clear or replace them, not even with null.
// #512: windowHello likewise – switched on only through setWindowHello with the PIN.
export const PIN_ONLY_SETTINGS = Object.freeze(['appPin', 'pinGuard', 'personalDeviceKeys', 'windowHello']);

/** The PIN-only keys a settings patch tries to write (empty: the patch may go through). */
export const pinOnlyKeys = (patch) => (patch && typeof patch === 'object'
  ? PIN_ONLY_SETTINGS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k)) : []);

/** #475: the record after `pin` verified against it – marked `short` or not; null when nothing changes. */
export function markShort(record, pin) {
  const short = isShortPin(pin);
  if (!!record?.short === short) return null;
  const { short: _, ...rest } = record;
  return short ? { ...rest, short: true } : rest;
}

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

  /** unlock: false for checks that must not open the one unlock a verified PIN allows (passkey use, #439). */
  success({ unlock = true } = {}) {
    this.failures = 0;
    this.blockedUntil = 0;
    if (unlock) this.okUntil = Date.now() + 120_000;
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

// #439: PIN checks run one after the other. Parallel requests would all pass the "blocked?" test before any failure was
// counted and so get more guesses than the lock allows. One queue for every check that uses the shared counter.
let pinQueueTail = Promise.resolve();
export function inPinQueue(fn) {
  const run = pinQueueTail.then(() => fn());
  pinQueueTail = run.catch(() => {});
  return run;
}
