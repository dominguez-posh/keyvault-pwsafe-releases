// The personal vault: where it lives (OneDrive …), creating and adopting it, its key bound to the PIN on this device.

import { app, net, Notification, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import { t } from '../../extension/core/i18n.js';
import { KEY_CHANGE } from '../../extension/core/protect.js';
import { demo, smokeTest } from './boot.js';
import { config, files, opened, win } from './state.js';
import { api } from './api/index.js';
import { diag } from './diag.js';
import { requireOpen } from './guards.js';
import { actor, changed, send } from './session.js';
import { helperExe } from './typing.js';

// ---------------------------------------------------------------- personal vault
// Free file vault for one person: in a synchronised folder (OneDrive, iCloud, Dropbox …) or on a network drive, never
// local. Encrypted with the master password (+ recovery key); on a device the PIN unlocks it – its key is stored
// encrypted with the PIN (PBKDF2) and bound to the Windows account (DPAPI). Nobody without these opens it.
const PERSONAL_FILE = 'Keevault-Persoenlich.kvpws';
export const fileLocations = new Map(); // file path → { kind, provider, providerStatus, inSync }
export let recentPin = null; // { pin, at } after a correct PIN – used once to bind / unlock the personal vault key

/**
 * Location of a folder or file (see locateRaw) plus, for cloud folders, whether the sync client runs (OneDrive.exe;
 * null for providers we cannot check) and whether the device is online – a quit OneDrive leaves the Cloud Files
 * status at its last value, so the file would silently stop syncing (#15).
 */
async function locate(target) {
  const info = await locateRaw(target);
  if (info?.kind !== 'cloud') return info;
  return { ...info, clientRunning: await syncClientRunning(info.provider), online: net.isOnline() };
}

/** Is the sync client of a cloud folder running? Known for OneDrive; null for other providers or when unknown. */
function syncClientRunning(provider) {
  if (smokeTest && process.env.KVPWSAFE_TEST_SYNC_CLIENT) return Promise.resolve(process.env.KVPWSAFE_TEST_SYNC_CLIENT === 'running');
  if (demo || process.platform !== 'win32' || !/onedrive/i.test(provider || '')) return Promise.resolve(demo ? true : null);
  return new Promise((resolve) => {
    execFileCb('tasklist', ['/FI', 'IMAGENAME eq OneDrive.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : /"OneDrive\.exe"/i.test(String(out))));
  });
}

/** Location of a folder or file via Keevault-Update.exe --location (Cloud Files API, drive type). */
function locateRaw(target) {
  // Smoke tests: a temporary folder stands in for a network drive (never the user's real OneDrive).
  if (smokeTest && process.env.KVPWSAFE_TEST_REMOTE && path.resolve(target).startsWith(path.resolve(process.env.KVPWSAFE_TEST_REMOTE))) return Promise.resolve(process.env.KVPWSAFE_TEST_PROVIDER ? { kind: 'cloud', provider: process.env.KVPWSAFE_TEST_PROVIDER, providerStatus: 'idle', inSync: true } : { kind: 'network', file: false });
  // Demo: its own OneDrive stand-in in the demo profile (the personal vault wizard never touches the real one).
  if (demo && path.resolve(target).startsWith(demoOneDrive())) return Promise.resolve({ kind: 'cloud', provider: 'OneDrive (Demo)', providerStatus: 'idle', inSync: true });
  const exe = helperExe();
  if (!exe || process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, ['--location', target], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

/** Re-checks where every file vault lives and whether it is in sync; true when something changed. */
export async function refreshFileLocations() {
  let changedAny = false;
  for (const p of config.get().fileContainers || []) {
    const info = await locate(p);
    const before = fileLocations.get(p);
    if (JSON.stringify(info) !== JSON.stringify(before || null)) changedAny = true;
    if (info) fileLocations.set(p, info);
    // The sync client just stopped: say so once, also when the window is in the background (#15).
    if (info?.clientRunning === false && before?.clientRunning !== false && opened) {
      const name = info.provider || 'OneDrive';
      send({ type: 'sync-stopped', path: p, provider: name });
      if (Notification.isSupported() && !smokeTest && !win?.isFocused()) {
        new Notification({ title: 'Keevault', body: t('{provider} läuft nicht – Änderungen an Tresoren in diesem Ordner werden nicht synchronisiert. Starte {provider}.', { provider: name }) }).show();
      }
    }
  }
  return changedAny;
}

const demoOneDrive = () => {
  const dir = path.join(app.getPath('userData'), 'OneDrive - Demo');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const defaultPersonalFolder = () => (demo ? demoOneDrive() : process.env.OneDriveCommercial || process.env.OneDrive || process.env.OneDriveConsumer || null);
export const personalPaths = () => config.get().personalVaults || [];

/**
 * Where the personal vault would go (default: OneDrive root) and whether a vault file is already there. There is one
 * personal vault per person ("Persönlich" / "Personal"); more structure comes from folders inside it.
 */
export async function personalInfo(folder = defaultPersonalFolder()) {
  const s = config.get();
  const filePath = folder ? path.join(folder, PERSONAL_FILE) : null;
  let exists = false;
  if (filePath) {
    try { exists = (await fs.stat(filePath)).isFile(); } catch { /* none yet */ }
  }
  return { folder, path: filePath, exists, location: folder ? await locate(folder) : null, configured: personalPaths(), pinSet: !!s.appPin };
}

function requirePersonalLocation(info) {
  if (!info.folder) throw new Error(t('Kein OneDrive eingerichtet – bitte OneDrive einrichten oder einen anderen synchronisierten Ordner bzw. ein Netzlaufwerk wählen.'));
  if (!info.location || !'cloud network'.split(' ').includes(info.location.kind)) {
    throw new Error(t('Der persönliche Tresor darf nicht lokal liegen – bitte einen synchronisierten Ordner (OneDrive, iCloud, Dropbox …) oder ein Netzlaufwerk wählen.'));
  }
}

export async function createPersonal({ folder, password, pin }) {
  requireOpen();
  if (!config.get().appPin) throw new Error(t('Bitte zuerst eine App-PIN festlegen – sie entsperrt den persönlichen Tresor im Alltag.'));
  await api.verifyPin(String(pin || '')); // the PIN binds the key on this device
  if (String(password || '').length < 12) throw new Error(t('Das Masterpasswort braucht mindestens 12 Zeichen'));
  if (personalPaths().length) throw new Error(t('Es gibt schon einen persönlichen Tresor – für mehr Ordnung darin Ordner anlegen.'));
  const info = await personalInfo(folder || defaultPersonalFolder());
  requirePersonalLocation(info);
  if (info.exists) throw new Error(t('Dort liegt schon ein persönlicher Tresor – „Bestehenden verwenden“ wählen.'));
  const r = await files.create(info.path, t('Persönlich'), { password }, actor());
  // In one write with the vault's listing: whatever ends the app from here on, the key still counts as not confirmed.
  config.update({ personalVaults: [...personalPaths().filter((p) => p !== info.path), info.path], personalRecoveryPending: { ...pendingRecovery(), [r.id]: recoveryEntryId(files.get(r.id)) } });
  fileLocations.set(info.path, await locate(info.path) || info.location);
  await bindPersonalKey(personalEntries().find((e) => e.path === info.path), { force: true }).catch(() => {});
  changed();
  return { id: r.id, recoveryKey: r.recoveryKey };
}

// The recovery key of a new personal vault has to be confirmed (#399). It is never kept to be shown again: stored are the
// vault's id and the id of its recovery entry, the wizard holds the key while it is open. Only the person's click makes
// a new key. The entry id tells whether the mark still means the current key: a key made another way (the protection
// dialog, another device) is someone's saved key, so the mark goes and that key stays. A key renewed here was shown once;
// not confirmed then, nobody can say it was saved, so only a further new key ends the wait (Konrad F12).
const pendingRecovery = () => config.get().personalRecoveryPending || {};
const renewedRecovery = () => config.get().personalRecoveryRenewed || {};
const recoveryEntryId = (vault) => vault?.keyring?.entries?.find((e) => e.type === 'recovery')?.id || null;

/** Personal vaults that still wait for a confirmation. Marks that no longer fit the keyring are dropped here. */
export function pendingRecoveryIds() {
  const pending = pendingRecovery();
  const open = [];
  const next = { ...pending };
  for (const entry of personalEntries()) {
    if (!Object.hasOwn(pending, entry.id) || !entry.vault?.keyring) continue;
    if (recoveryEntryId(entry.vault) === pending[entry.id]) open.push(entry.id);
    else delete next[entry.id];
  }
  if (Object.keys(next).length !== Object.keys(pending).length) {
    const renewed = Object.fromEntries(Object.entries(renewedRecovery()).filter(([id]) => Object.hasOwn(next, id)));
    config.update({ personalRecoveryPending: next, personalRecoveryRenewed: renewed });
  }
  return open;
}

/** Of those, the ones whose key was renewed in the app and never confirmed: "I have stored it" is no answer there. */
export const renewedRecoveryIds = () => pendingRecoveryIds().filter((id) => renewedRecovery()[id] === pendingRecovery()[id]);

/** A new recovery key is a real key change (#402): the vault gets a new key, a new master password and the new key. */
export async function renewPersonalRecovery(id, password) {
  requireOpen();
  if (!pendingRecoveryIds().includes(id)) throw new Error(t('Der Wiederherstellungsschlüssel ist schon bestätigt.'));
  const { recoveryKey } = await files.updateKeyring(id, KEY_CHANGE.enabled ? { type: 'rekey', password } : { type: 'newRecovery' }, actor());
  const entry = recoveryEntryId(files.get(id));
  config.update({ personalRecoveryPending: { ...pendingRecovery(), [id]: entry }, personalRecoveryRenewed: { ...renewedRecovery(), [id]: entry } });
  changed();
  return { recoveryKey };
}

export function confirmPersonalRecovery(id) {
  requireOpen();
  const next = { ...pendingRecovery() };
  const renewed = { ...renewedRecovery() };
  delete next[id];
  delete renewed[id];
  config.update({ personalRecoveryPending: next, personalRecoveryRenewed: renewed });
  changed();
  return true;
}

export async function usePersonal({ folder }) {
  requireOpen();
  if (!config.get().appPin) throw new Error(t('Bitte zuerst eine App-PIN festlegen – sie entsperrt den persönlichen Tresor im Alltag.'));
  if (personalPaths().length) {
    // The same vault again: the wizard's first try had a wrong master password, the vault is listed already (#400).
    const again = (await personalInfo(folder || defaultPersonalFolder()).catch(() => null))?.path;
    const listed = again && personalPaths().includes(again) && [...(files?.entries?.values() || [])].find((e) => e.path === again);
    if (listed) return { id: listed.id };
    throw new Error(t('Es gibt schon einen persönlichen Tresor – für mehr Ordnung darin Ordner anlegen.'));
  }
  const info = await personalInfo(folder || defaultPersonalFolder());
  requirePersonalLocation(info);
  if (!info.exists) throw new Error(t('Dort liegt kein persönlicher Tresor.'));
  const id = await files.open(info.path);
  const { [info.path]: _old, ...keys } = config.get().personalDeviceKeys || {};
  config.update({ personalVaults: [...personalPaths(), info.path], personalDeviceKeys: keys });
  fileLocations.set(info.path, await locate(info.path) || info.location);
  changed();
  return { id };
}

export const personalEntries = () => [...(files?.entries?.values() || [])].filter((e) => e.path && personalPaths().includes(e.path));

/** Binds every unlocked personal vault (force: also those bound before, e.g. after a PIN change). */
export async function bindPersonalKeys({ force = false } = {}) {
  for (const entry of personalEntries()) await bindPersonalKey(entry, { force });
}

/** Stores an unlocked personal vault's key for this device: PIN-derived AES-GCM, then DPAPI (Windows account). */
async function bindPersonalKey(entry, { force = false } = {}) {
  if (!entry?.vault || entry.vault.locked || !entry.vault.ck?.raw) return;
  if (!force && config.get().personalDeviceKeys?.[entry.path]) return;
  if (!recentPin || Date.now() - recentPin.at > 10 * 60_000 || !(await safeStorage.isAsyncEncryptionAvailable())) return;
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(recentPin.pin, salt, 310_000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`keevault-personal|${entry.id}`));
  const ct = Buffer.concat([cipher.update(Buffer.from(entry.vault.ck.raw)), cipher.final(), cipher.getAuthTag()]);
  const blob = JSON.stringify({ v: 1, vault: entry.id, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });
  config.update({ personalDeviceKeys: { ...config.get().personalDeviceKeys, [entry.path]: (await safeStorage.encryptStringAsync(blob)).toString('base64') } });
}

/** After a key change (#402): the device binding holds the old key – renewed with the PIN just entered, otherwise dropped. */
export async function rebindPersonalKey(entry) {
  if (!entry?.path || !personalPaths().includes(entry.path)) return;
  const { [entry.path]: _old, ...keys } = config.get().personalDeviceKeys || {};
  config.update({ personalDeviceKeys: keys });
  await bindPersonalKey(entry).catch(() => {});
}

/** A correct PIN unlocks every personal vault on this device whose key was bound here before. */
export async function unlockPersonalWithPin(pin) {
  for (const entry of personalEntries()) {
    try {
      await unlockPersonalEntry(entry, pin);
    } catch (e) {
      diag(`PERSONAL pin unlock failed (${path.basename(entry.path)}): ${e.message}`);
    }
  }
}

async function unlockPersonalEntry(entry, pin) {
  const stored = config.get().personalDeviceKeys?.[entry.path];
  if (!stored || !entry?.vault || !entry.vault.locked) return;
  const blob = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result);
  if (blob.vault !== entry.id) return;
  const key = crypto.pbkdf2Sync(pin, Buffer.from(blob.salt, 'base64'), 310_000, 32, 'sha256');
  const data = Buffer.from(blob.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAAD(Buffer.from(`keevault-personal|${entry.id}`));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const raw = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  try {
    await entry.vault.unlock(new Uint8Array(raw));
  } catch (e) {
    // The key was changed on another device (#402): the binding is useless now and goes; the master password opens it.
    if (e.name === 'UnlockError') {
      const { [entry.path]: _old, ...keys } = config.get().personalDeviceKeys || {};
      config.update({ personalDeviceKeys: keys });
    }
    throw e;
  }
  changed();
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setRecentPin(value) { recentPin = value; return value; }
