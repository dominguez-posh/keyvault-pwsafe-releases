// The personal vault: where it lives (OneDrive …), creating and adopting it, its key bound to the PIN on this device.

import { app, net, Notification, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import { t } from '../../extension/core/i18n.js';
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
  config.update({ personalVaults: [...personalPaths().filter((p) => p !== info.path), info.path] });
  fileLocations.set(info.path, await locate(info.path) || info.location);
  await bindPersonalKey(personalEntries().find((e) => e.path === info.path), { force: true }).catch(() => {});
  changed();
  return { id: r.id, recoveryKey: r.recoveryKey };
}

export async function usePersonal({ folder }) {
  requireOpen();
  if (!config.get().appPin) throw new Error(t('Bitte zuerst eine App-PIN festlegen – sie entsperrt den persönlichen Tresor im Alltag.'));
  if (personalPaths().length) throw new Error(t('Es gibt schon einen persönlichen Tresor – für mehr Ordnung darin Ordner anlegen.'));
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
  await entry.vault.unlock(new Uint8Array(raw));
  changed();
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setRecentPin(value) { recentPin = value; return value; }
