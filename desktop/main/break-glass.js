// #539 Etappe 10: the break-glass stick of secured file vaults (Lucas: required before a shared file vault is created or
// converted; Konrad: user verification at the stick, real PRF, a test unlock in a second ceremony, never a credential
// of another member, highlighted in the change log). The core rule: ../../extension/core/members-mp.js (addBreakGlass).

import { t } from '../../extension/core/i18n.js';
import { app } from 'electron';
import { smokeTest } from './boot.js';
import { breakGlassExclude, isSecurityKey } from '../member-keys-logic.js';
import { files } from './state.js';
import { passkeyCeremony, registerPasskey } from './passkey-window.js';

/**
 * Registers the emergency stick (a security key, user verification and PRF – prf.js refuses one without PRF with a clear
 * message) and opens it once more in a second ceremony: only a stick that gives the same PRF output counts.
 * exclude: credential IDs already in the file – the authenticator refuses a stick that holds one (the same stick as the
 * creator's passkey). The smoke run has one virtual authenticator for all credentials and passes none.
 */
export async function registerBreakGlass(containerName, exclude = []) {
  // Konrad N2a: the smoke exception never in an installed app.
  const stick = await registerPasskey(containerName, t('Notfall-Stick (Break-Glass)'), breakGlassExclude(exclude, { smokeTest, packaged: app.isPackaged }), 'cross-platform', { hints: ['security-key'] });
  // Konrad N2b: a security key (USB, NFC, BLE) – not Windows Hello, not a phone passkey over hybrid.
  if (!isSecurityKey(stick)) throw new Error(t('Der Notfall-Zugang muss ein FIDO-Sicherheitsschlüssel sein, nicht Windows Hello oder ein Smartphone.'));
  if (!stick.prfOutput) throw new Error(t('Der Notfall-Stick liefert keine Schlüsselableitung (PRF)'));
  const check = await passkeyCeremony({
    mode: 'evaluate', containerName: `${containerName} – ${t('Test des Notfall-Sticks')}`,
    passkeys: [{ credentialId: stick.credentialId, prfSalt: stick.prfSalt }], autoStart: !smokeTest,
  });
  if (check?.credentialId !== stick.credentialId || check.prfOutput !== stick.prfOutput) {
    throw new Error(t('Der Test mit dem Notfall-Stick ist fehlgeschlagen – nichts angelegt. Bitte erneut versuchen.'));
  }
  return stick;
}

/** Konrad M1: changing a role only for an active member (the core checks it again in the file's queue). */
export function requireActiveMember(containerId, memberId) {
  const v = files.get(containerId);
  if (v?.roster?.current(memberId)?.status !== 'active') throw new Error(t('Nur aktive Mitglieder haben eine Rolle – Anfragen werden mit dem Sicherheitscode freigegeben'));
}

/** Members view for the window: the code of someone else's request is not shown – the admin types it (Konrad). */
export function withoutForeignCodes(view) {
  return { ...view, members: (view.members || []).map((m) => (m.me ? m : { ...m, safetyCode: null, codeNeeded: m.status === 'pending' || undefined })) };
}

/** Credential IDs of the file's break-glass members (left out of the everyday passkey unlock). */
export function breakGlassCredentials(containerId) {
  const members = files.get(containerId)?.doc?.keyring?.members || [];
  return new Set(members.filter((m) => m.breakGlass === true).flatMap((m) => (m.credentials || []).map((c) => c.credentialId).filter(Boolean)));
}

/** Change log: entries by a break-glass member are highlighted (Konrad). */
export function markBreakGlass(containerId, entries) {
  const ids = new Set((files.get(containerId)?.doc?.keyring?.members || []).filter((m) => m.breakGlass === true).map((m) => m.id));
  return entries.map((e) => (ids.has(e.by) ? { ...e, breakGlass: true } : e));
}
