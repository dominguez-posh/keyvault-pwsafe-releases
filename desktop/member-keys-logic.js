// #539 Etappe 8: the decisions of desktop/main/member-key.js without Electron, so that unit tests check the behavior.

import { uniteKeys, removedAppCredential } from '../extension/core/member-app.js';

/**
 * Which member keys count, which go back into the vault, whether a new one is made.
 * inVault: the keys the vault opens now; extra: the device copy and rescued keys; seen: { fps, gen } or null; count:
 * entries in the vault (readable or not); create: a key is needed now.
 * → { keys (current first, without the new one), back: keys to seal again under the vault's key, createGen: generation
 *   of a new key or null }
 * H1: only keys this device saw come back. M-b (Konrad): when none is readable although entries are there (or this
 * device saw some), a new one is made next to them – never over them – with a higher generation than any known.
 */
export function planMemberKeys({ inVault = [], extra = [], seen = null, count = 0, create = false }) {
  const back = extra.filter((k) => {
    if (!seen?.fps?.includes(k.fp)) return false;
    const v = inVault.find((x) => x.fp === k.fp);
    return !v || (k.compromised && !v.compromised); // missing in the vault, or its mark "compromised" lost
  });
  const keys = uniteKeys(inVault, back);
  let createGen = null;
  if (create && !keys.some((k) => !k.compromised)) {
    createGen = Math.max(0, seen?.gen || 0, ...keys.map((k) => k.gen)) + 1;
    if (!count && !seen) createGen = 1;
  }
  return { keys, back, createGen };
}

/**
 * After a passkey unlock: link the same identity to the master password? Not with "passkeys only", not when an app
 * credential of this member was removed before (M4: removed on purpose stays removed), not under "Immer bestätigen",
 * not when it is linked already, never without a member key.
 */
export function mayLink({ passkeyOnly = false, member = null, strict = false, linked = false, hasKey = false }) {
  // Etappe 10: never the break-glass member – the stick in the safe must not end up behind someone's master password.
  return !!member && member.breakGlass !== true && !passkeyOnly && !strict && !linked && hasKey && !removedAppCredential(member);
}

/**
 * M3: renewing the memberships ("master password compromised") only within ten minutes after a key change of the
 * record's personal vault with a NEW password, once, and only while the vault is still at that key generation.
 */
export class RenewGate {
  constructor(now = Date.now, ms = 10 * 60_000) {
    Object.assign(this, { now, ms, allowed: null });
  }

  afterRekey(vaultId, kv, changed) {
    this.allowed = changed ? { vault: vaultId, kv, until: this.now() + this.ms } : null;
  }

  /** Takes the permission (once); false when there is none for this vault and generation. */
  consume(vaultId, kv) {
    const r = this.allowed;
    this.allowed = null;
    return !!r && r.vault === vaultId && r.kv === kv && this.now() <= r.until;
  }
}

// ---------------------------------------------------------------- break-glass (#539 Etappe 10)

/** Konrad N2a: credentials the stick registration excludes – none only in a smoke run of a not installed app. */
export const breakGlassExclude = (exclude, { smokeTest = false, packaged = true } = {}) => (smokeTest && !packaged ? [] : exclude);

/** Konrad N2b: the emergency stick is a security key (USB, NFC, BLE) – not Windows Hello, not a phone over hybrid. */
export const isSecurityKey = (stick) => stick?.device === 'key' && !stick.platform;
