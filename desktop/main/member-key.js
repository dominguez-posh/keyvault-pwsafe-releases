// #539 Etappe 8: the member identity of secured file vaults at the app's one master password.
// The member keys MK live in the personal vault of this device's record (lineage, #537 H2), so Hello, the master
// password or the PIN open them like everything else (DK → personal vault → MK). With them the app opens every secured
// file holding the person's app credential, links passkey members after their next passkey unlock, creates and
// requests secured files without a passkey, and renews the key after "master password compromised".
// Core: ../../extension/core/member-app.js, members-mp.js, filevault-mp.js.
//
// Konrad H1: an older app (0.9.34) changes the key of the personal vault without re-encrypting the member keys. So each
// device keeps its own copy sealed with DK (memberKeyDevice); a key whose fingerprint this device saw (memberKeySeen)
// and that the vault no longer opens is sealed again under the vault's current key. A first key is never created over
// an entry that is there but unreadable. When the master password was changed on such a device, the old proof (Hello,
// PIN or the old master password) opens the old DK once (MasterPasswordChanged) – the copy is rescued then (rescue()).
// Konrad M1: a list of keys (two devices creating the first one at once keep both). M2: a key marked compromised still
// opens, and every file it opens gets a new identity at once.

import { t } from '../../extension/core/i18n.js';
import { newMemberKey, ownAppCredentials, currentKey } from '../../extension/core/member-app.js';
import { readMemberKeys, writeMemberKeys, memberKeyCount, replaceOwnIdentity } from '../../extension/core/filevault-mp.js';
import { planMemberKeys, mayLink, RenewGate } from '../member-keys-logic.js';
import { passkeyOnlyEnabled } from '../../extension/core/members-mp.js';
import { keyVersionOf } from '../../extension/core/protect.js';
import { b64uDecode, b64uEncode } from '../../extension/core/util.js';
import { openWith, sealWith, subKey } from '../unlock-keys.js';
import { config, files } from './state.js';
import { personalEntries } from './personal.js';
import { unlockService } from './unlock.js';
import { strictVault } from './access.js';
import { diag } from './diag.js';

/** Organization policy SharedVaultPasskeyOnly = 1: never the master password for secured files. */
export const passkeyOnlyPolicy = () => !!config.get().enforced?.includes?.('sharedVaultPasskeyOnly') && config.get().sharedVaultPasskeyOnly === true;

/** The personal vault of this device's record, unlocked and in its lineage – or null. */
async function lineageEntry() {
  const record = await unlockService.readRecord();
  const id = record?.lineage?.vault;
  const entry = id ? personalEntries().find((e) => e.id === id) : null;
  if (!entry?.vault || entry.vault.locked) return null;
  return (await unlockService.inLineage(record, entry, entry.vault.ck)) ? entry : null;
}

// ---------------------------------------------------------------- what this device knows

// memberKeySeen: { vault, fps: [fingerprint…], gen } – fingerprints, never keys (PIN-only, device only).
const seenFor = (vaultId) => {
  const s = config.get().memberKeySeen;
  return s && typeof s === 'object' && s.vault === vaultId && Array.isArray(s.fps) ? s : null;
};
function noteSeen(vaultId, keys) {
  const s = seenFor(vaultId);
  const fps = [...new Set([...(s?.fps || []), ...keys.map((k) => k.fp)])].slice(-20);
  const gen = Math.max(s?.gen || 0, ...keys.map((k) => k.gen));
  if (s && fps.length === s.fps.length && gen === s.gen) return;
  config.update({ memberKeySeen: { vault: vaultId, fps, gen } });
}

const deviceAad = (vaultId) => `keevault/member-key-device/v1|${vaultId}`;
const toPlain = (keys) => JSON.stringify(keys.map((k) => ({ gen: k.gen, fp: k.fp, k: b64uEncode(k.mk), compromised: !!k.compromised })));
const fromPlain = (text) => JSON.parse(text).map((k) => ({ gen: k.gen, fp: k.fp, mk: b64uDecode(k.k), compromised: !!k.compromised }));

function openDevice(dk, vaultId) {
  const d = config.get().memberKeyDevice;
  if (!dk || d?.vault !== vaultId || typeof d.ct !== 'string') return [];
  const plain = openWith(subKey(dk, 'member-key', vaultId), d.ct, deviceAad(vaultId));
  try {
    return plain ? fromPlain(plain.toString('utf8')) : [];
  } catch {
    return [];
  }
}

function writeDevice(dk, vaultId, keys) {
  if (!dk || !keys.length) return;
  config.update({ memberKeyDevice: { vault: vaultId, ct: sealWith(subKey(dk, 'member-key', vaultId), Buffer.from(toPlain(keys)), deviceAad(vaultId)) } });
}

// The keys opened with the old DK when the master password was changed on another device – until the next unlock.
let rescued = null; // { vault, keys, until }

/** MasterPasswordChanged: the proof just given opened the old DK – keep this device's copy for the next unlock. */
export function rescue(oldDk) {
  const d = config.get().memberKeyDevice;
  const keys = d?.vault ? openDevice(oldDk, d.vault) : [];
  if (keys.length) rescued = { vault: d.vault, keys, until: Date.now() + 30 * 60_000 };
}

// ---------------------------------------------------------------- the keys

/**
 * The member keys: { keys (current first), current, entry } or null (policy, no personal vault of the record, locked).
 * dk: the device key just proven (else the recent one). create: the first key when the vault has no entry at all and
 * this device never saw one.
 */
export async function memberKeys({ create = false, dk = null } = {}) {
  if (passkeyOnlyPolicy()) return null;
  const entry = await lineageEntry();
  if (!entry) return null;
  const key = dk || unlockService.recentDk();
  const seen = seenFor(entry.id);
  const inVault = await readMemberKeys(entry.vault);
  const extra = [...openDevice(key, entry.id), ...(rescued?.vault === entry.id && Date.now() < rescued.until ? rescued.keys : [])];
  // H1: only keys this device saw come back; M-b: none readable → a new one next to the unreadable entries (planMemberKeys).
  const plan = planMemberKeys({ inVault, extra, seen, count: memberKeyCount(entry.vault), create });
  let { keys } = plan;
  const { back } = plan;
  if (back.length) {
    await files.serial(entry.id, () => writeMemberKeys(entry.vault, keys.filter((k) => back.some((b) => b.fp === k.fp))));
    diag(`MEMBERKEY ${back.length} key(s) sealed again under the current key of the personal vault`);
  }
  if (plan.createGen) {
    if (memberKeyCount(entry.vault) || seen) diag(`MEMBERKEY none usable – a new one next to the others (gen ${plan.createGen})`);
    await files.serial(entry.id, () => writeMemberKeys(entry.vault, [{ mk: newMemberKey(), gen: plan.createGen }]));
    keys = await readMemberKeys(entry.vault); // what the file holds after the merge (another device may have been first)
  }
  if (!keys.length) return null;
  if (back.length) rescued = null;
  noteSeen(entry.id, keys);
  writeDevice(key, entry.id, keys);
  return { keys, current: currentKey(keys), entry };
}

/** The key that opens this file's own app credential (current first): { key, member } or null. */
async function keyFor(keyring, keys) {
  for (const k of keys) {
    const own = await ownAppCredentials(keyring, k.mk);
    if (own.length) return { key: k, own };
  }
  return null;
}

const securedEntries = () => [...(files?.entries?.values() || [])].filter((e) => e.vault?.secure);

/**
 * Opens one secured file with whichever key fits. M2: opened with a compromised key – a new identity with the current
 * key at once (an admin's applies, everyone else's waits for the admins). → result of files.unlockWithMemberKey
 */
async function openFile(e, rec) {
  const hit = await keyFor(e.vault.doc.keyring, rec.keys);
  if (!hit) throw new Error(t('Diese Datei ist nicht mit deinem Masterpasswort verbunden'));
  const r = await files.unlockWithMemberKey(e.id, hit.key.mk);
  if (!r.pending && hit.key.compromised && rec.current && !e.vault.locked) {
    const x = await files.serial(e.id, () => replaceOwnIdentity(e.vault, rec.current.mk));
    diag(`MEMBERKEY ${e.id} opened with a compromised key – identity ${x.replaced ? 'replaced' : 'replacement requested'}`);
    files.onChange();
  }
  return r;
}

/** After the app was unlocked (DK → personal vault): every locked secured file with the own app credential. → count */
export async function openSecuredWithMemberKey(dk = null) {
  const rec = await memberKeys({ dk }).catch((e) => { diag(`MEMBERKEY read failed: ${e.message}`); return null; });
  if (!rec) return 0;
  let n = 0;
  for (const e of securedEntries().filter((x) => x.vault.locked && x.vault.doc)) {
    if (!(await keyFor(e.vault.doc.keyring, rec.keys))) continue;
    try {
      if (!(await openFile(e, rec)).pending) n += 1;
    } catch (err) {
      diag(`MEMBERKEY open failed (${e.id}): ${err.message}`);
    }
  }
  return n;
}

/** Opens one secured file with the member key (window: "Mit Masterpasswort öffnen"). */
export async function unlockSecuredWithMemberKey(containerId) {
  if (passkeyOnlyPolicy()) throw new Error(t('Deine Organisation erlaubt abgesicherte Tresore nur mit Passkey'));
  const rec = await memberKeys();
  if (!rec) throw new Error(t('Masterpasswort-Zugang braucht deinen geöffneten persönlichen Tresor'));
  const e = files.entries.get(containerId);
  if (!e?.vault?.secure) throw new Error(t('Nur abgesicherte Dateien haben Benutzer'));
  return openFile(e, rec);
}

/**
 * After a passkey unlock of a secured file: the same identity also at the master password (migration of passkey
 * members). Not with "passkeys only" (file or policy), not when an app credential of this member was removed before
 * (Konrad M4: removed on purpose stays removed), not under "Immer bestätigen" (linking would need its own confirmation).
 */
export async function linkAfterPasskey(containerId) {
  try {
    const v = files.get(containerId);
    if (!v?.secure || v.locked) return false;
    const me = v.doc.keyring.members.filter((m) => m.id === v.memberId);
    const base = { passkeyOnly: passkeyOnlyEnabled(v.doc.keyring, v.roster, v.known), member: me[0] || null, strict: await strictVault(containerId) };
    if (!mayLink({ ...base, hasKey: true })) return false; // checked before a member key is made
    const rec = await memberKeys({ create: true });
    const linked = !!rec && !!(await keyFor({ ...v.doc.keyring, members: me }, rec.keys));
    if (!mayLink({ ...base, linked, hasKey: !!rec?.current })) return false;
    await files.memberOp(containerId, { type: 'addAppCredential', mk: rec.current.mk });
    return true;
  } catch (e) {
    diag(`MEMBERKEY link failed (${containerId}): ${e.message}`);
    return false;
  }
}

/** For creating, requesting, converting or linking with the master password: the current member key, else an error. */
export async function memberKeyForNew() {
  if (passkeyOnlyPolicy()) throw new Error(t('Deine Organisation erlaubt abgesicherte Tresore nur mit Passkey'));
  const rec = await memberKeys({ create: true });
  if (!rec?.current) throw new Error(t('Masterpasswort-Zugang braucht deinen geöffneten persönlichen Tresor'));
  return rec.current.mk;
}

// ---------------------------------------------------------------- "master password compromised"

// Renewing is allowed only right after a real change of the master password of the record's personal vault (a key
// change with a new password, M3: also removing a recovery stick or renewing the recovery key): with the old
// (compromised) password still valid, whoever knows it would read the new member key as well.
const renewGate = new RenewGate();

/** After a key change of a personal vault (personal.js rebindPersonalKey). changed: the new password differs from the old. */
export function afterPersonalRekey(containerId, { changed = false } = {}) {
  renewGate.afterRekey(containerId, keyVersionOf(files.get(containerId)?.keyring), changed);
  memberKeys().catch(() => null); // the device copy under the new DK
}

function consumeRenew(entry) {
  if (!renewGate.consume(entry.id, keyVersionOf(entry.vault.keyring))) {
    throw new Error(t('Erst das Masterpasswort ändern (ein neues, nicht das bisherige) – dann die Mitgliedschaften erneuern'));
  }
}

/**
 * "Master password compromised": every key so far is marked compromised (it still opens, and each file it opens gets a
 * new identity – M2), a new current key. In every secured file open or openable now: a new identity at once (admin) or
 * as a request. → [{ id, name, replaced, safetyCode } | { id, name, error }]; files not attached now follow when opened.
 */
export async function renewMemberIdentity() {
  const rec = await memberKeys();
  if (!rec) throw new Error(t('Masterpasswort-Zugang braucht deinen geöffneten persönlichen Tresor'));
  consumeRenew(rec.entry);
  const mk = newMemberKey();
  const gen = Math.max(...rec.keys.map((k) => k.gen), seenFor(rec.entry.id)?.gen || 0) + 1;
  await files.serial(rec.entry.id, () => writeMemberKeys(rec.entry.vault, [...rec.keys.map((k) => ({ ...k, compromised: true })), { mk, gen }]));
  const now = await memberKeys();
  if (now?.current?.gen !== gen) throw new Error(t('Der neue Mitgliedsschlüssel ließ sich nicht speichern'));
  diag(`MEMBERKEY renewed (gen ${gen})`);
  const out = [];
  for (const e of securedEntries()) {
    if (!e.vault.doc || !(await keyFor(e.vault.doc.keyring, rec.keys))) continue;
    try {
      if (e.vault.locked) await files.unlockWithMemberKey(e.id, (await keyFor(e.vault.doc.keyring, rec.keys)).key.mk);
      if (e.vault.locked) throw new Error(t('Der Datei-Tresor ist gesperrt'));
      const r = await files.serial(e.id, () => replaceOwnIdentity(e.vault, mk));
      out.push({ id: e.id, name: e.vault.name, replaced: r.replaced, safetyCode: r.safetyCode });
    } catch (err) {
      out.push({ id: e.id, name: e.vault?.name || e.id, error: err.message });
    }
  }
  files.onChange();
  return out;
}

/** For the window: does this secured file open with the master password here? (own app credential, allowed) */
export async function opensWithMemberKey(containerId) {
  try {
    const v = files.get(containerId);
    if (!v?.secure || !v.doc || passkeyOnlyPolicy()) return false;
    const rec = await memberKeys();
    return !!rec && !!(await keyFor(v.doc.keyring, rec.keys));
  } catch {
    return false;
  }
}

/** The current member key for the members view (which identities are the own app ones), never handed to the window. */
export const memberKeyOrNull = () => memberKeys().then((r) => r?.current?.mk || null, () => null);
