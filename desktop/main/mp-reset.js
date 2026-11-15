// #537 stage 6 (2a, E1): "Masterpasswort vergessen?" – the recovery stick (FIDO security key with PRF, an asymmetric
// keyring entry of the personal vault, role recovery) resets the one master password of the app. A real key change
// (#402): new key, new generation, new recovery key to confirm; the sticks stay (carried without the stick), passkeys
// end. The stick's PRF is the proof (Konrad); the logic lives in desktop/unlock-service.js (resetWithStick).

import os from 'node:os';
import { t } from '../../extension/core/i18n.js';
import { escrowEntries, keyVersionOf, unlockWithEscrow } from '../../extension/core/protect.js';
import { resetsOf, unseenResets, withReset } from '../mp-reset-log.js';
import { demo, RP_ID, smokeTest } from './boot.js';
import { config, files } from './state.js';
import { diag } from './diag.js';
import { MP_MIN_LENGTH } from '../unlock-keys.js';
import { passkeyCeremony, registerPasskey } from './passkey-window.js';
import { markRecoveryRenewed, personalEntries } from './personal.js';
import { actor, changed } from './session.js';
import { consumeFresh, isMigrated, unlockService, verifyPasswordCounted } from './unlock.js';

const recoverySticks = (entry) => (entry?.vault?.keyring ? escrowEntries(entry.vault.keyring, RP_ID, 'recovery') : []);
/** Konrad N3: the personal vault of this device's record (lineage) – only that one, and only with a recovery stick. */
async function stickVault() {
  const record = await unlockService.readRecord().catch(() => null);
  const id = record?.lineage?.vault;
  return (id && personalEntries().find((e) => e.id === id && recoverySticks(e).length)) || null;
}

/** For the lock screen: a reset with a stick is possible here (master password set up, a recovery stick in the vault). */
export const stickResetAvailable = async () => isMigrated() && !!(await stickVault());

/**
 * The reset: new master password, then the stick. Works on the lock screen (the app is locked). → { recoveryKey } and
 * exactly one unlock is allowed, as after a correct master password.
 */
export async function resetMasterPasswordWithStick({ password } = {}) {
  const entry = isMigrated() ? await stickVault() : null;
  if (!entry) throw new Error(t('Für deinen persönlichen Tresor ist kein Wiederherstellungs-Schlüssel eingerichtet.'));
  const wasLocked = entry.vault.locked;
  try {
    return await resetEntry(entry, password);
  } catch (e) {
    // Konrad N1: the key change or the unlock failed – the vault opened here for it does not stay open in memory.
    if (wasLocked && !entry.vault.locked) entry.vault.lock();
    throw e;
  }
}

async function resetEntry(entry, password) {
  const { recoveryKey, dk } = await unlockService.resetWithStick(entry, password, {
    open: async () => {
      const prf = await passkeyCeremony({ mode: 'evaluate', containerName: entry.vault.name || t('Persönlich'), passkeys: recoverySticks(entry), autoStart: !smokeTest });
      return unlockWithEscrow(entry.vault.keyring, prf.credentialId, prf.prfOutput, { role: 'recovery' });
    },
    rekey: async (ck, newPassword) => {
      if (entry.vault.locked) await entry.vault.unlock(new Uint8Array(ck.raw));
      const r = await files.updateKeyring(entry.id, { type: 'rekey', password: newPassword }, actor()); // onRekey → new DK
      markRecoveryRenewed(entry.id); // #399: the new recovery key is shown once and has to be confirmed
      await logReset(entry).catch((e) => diag(`RESET log not written: ${e.message}`));
      return r;
    },
  });
  await unlockService.unlockWithDk(dk);
  changed();
  return { recoveryKey, id: entry.id };
}

/**
 * Settings: a recovery stick for the personal vault – only with a fresh master password or recovery key (Konrad), a
 * security key with PRF, never one already in the keyring (protect.js addEscrow test-opens it before it counts).
 */
export async function addRecoveryStick(containerId) {
  const entry = personalEntries().find((e) => e.id === containerId);
  if (!entry) throw new Error(t('Einen Wiederherstellungs-Schlüssel gibt es nur für den persönlichen Tresor.'));
  if (isMigrated()) consumeFresh('personal-keyring');
  const keyring = entry.vault.keyring;
  const exclude = keyring.entries.filter((e) => (e.type === 'passkey' || e.type === 'escrow') && e.credentialId).map((e) => e.credentialId);
  const passkey = await registerPasskey(entry.vault.name || t('Persönlich'), t('Wiederherstellung'), exclude, 'cross-platform', { hints: ['security-key'] });
  const r = await files.updateKeyring(entry.id, { type: 'addEscrow', stick: { ...passkey, role: 'recovery', label: passkey.label } }, actor());
  changed();
  return r;
}

/**
 * Konrad M1: a recovery stick ends only with a real key change (rekey, dropEscrow) – otherwise a lost stick would go on
 * opening the current and every later state of the vault. Older copies (e.g. OneDrive version history) it still opens,
 * with their old content. The current master password (counted) is the proof and stays the master
 * password; the vault gets a new key and recovery key (to confirm), passkeys end, PIN and Hello are set up again.
 */
export async function removeRecoveryStick(containerId, entryId, password, newPassword = null) {
  const entry = personalEntries().find((e) => e.id === containerId);
  if (!entry) throw new Error(t('Einen Wiederherstellungs-Schlüssel gibt es nur für den persönlichen Tresor.'));
  if (!entry.vault.keyring.entries.some((e) => e.id === entryId && e.type === 'escrow')) throw new Error(t('Diesen Wiederherstellungs-Schlüssel gibt es nicht mehr.'));
  const text = String(password ?? '');
  if (isMigrated()) await verifyPasswordCounted(text);
  // #539 M3: with "master password compromised" (or a lost stick) a new master password, different from the current one.
  const next = newPassword == null || newPassword === '' ? text : String(newPassword);
  if (newPassword && next === text) throw new Error(t('Das neue Masterpasswort muss sich vom bisherigen unterscheiden'));
  if (newPassword && next.length < MP_MIN_LENGTH) throw new Error(t('Das Masterpasswort braucht mindestens {n} Zeichen', { n: MP_MIN_LENGTH })); // N3
  const r = await files.updateKeyring(entry.id, { type: 'rekey', password: next, dropEscrow: [entryId] }, actor());
  markRecoveryRenewed(entry.id);
  changed();
  return { recoveryKey: r.recoveryKey, id: entry.id };
}

// ---------------------------------------------------------------- the reset log (shown once on every device)
const seen = () => (Array.isArray(config.get().mpResetsSeen) ? config.get().mpResetsSeen : []);

/** Notes the reset in the personal vault (under its new key); this device has seen it already. */
async function logReset(entry) {
  const at = new Date().toISOString();
  // Konrad N2: read, change and write in one step (no other write of the record in between).
  await files.updateAppSettings(entry.id, (value) => withReset(value, { at, device: demo ? 'Demo-PC' : os.hostname(), kv: keyVersionOf(entry.vault.keyring) }));
  config.update({ mpResetsSeen: [...seen(), at].slice(-20) });
}

/** Resets of the master password this device has not shown yet: [{ at, device }] – read from the open personal vault. */
export async function mpResetNotices() {
  const out = [];
  for (const entry of personalEntries()) {
    if (!entry.vault || entry.vault.locked) continue;
    const remote = await files.appSettings(entry.id).catch(() => null);
    out.push(...unseenResets(remote?.value, seen()).map((r) => ({ at: r.at, device: r.device || '' })));
  }
  return out;
}

/** The window showed these: not again on this device. Only entries that are in the log count. */
export async function mpResetsShown(ats = []) {
  const want = new Set((Array.isArray(ats) ? ats : []).filter((a) => typeof a === 'string'));
  const known = new Set();
  for (const entry of personalEntries()) {
    if (!entry.vault || entry.vault.locked) continue;
    for (const r of resetsOf((await files.appSettings(entry.id).catch(() => null))?.value)) known.add(r.at);
  }
  const add = [...want].filter((a) => known.has(a));
  if (add.length) config.update({ mpResetsSeen: [...seen(), ...add].slice(-20) });
  return true;
}
