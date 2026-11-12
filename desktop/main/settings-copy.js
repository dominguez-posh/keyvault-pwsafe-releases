// Settings as a file (#478): the copy in OneDrive (OneDrive\Keevault\Keevault-Einstellungen.json, kept up to date),
// the question at the first start and export/import from the menu. Plain JSON without anything secret: what goes in
// and what is read back is decided in desktop/settings-file.js. The sync over the personal vault (settings-sync.js)
// stays as it is; this is a second, visible way.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vaultHost } from '../../extension/core/keyvault.js';
import { buildSettingsFile, importPlan, linkedCopyFolder, newVaultsOf, parseSettingsFile, SETTINGS_FILE_NAME, SETTINGS_FOLDER, SETTINGS_MAX_BYTES } from '../settings-file.js';
import { demo, smokeTest } from './boot.js';
import { config, vault } from './state.js';
import { diag } from './diag.js';
import { demoOneDrive } from './personal.js';
import { send, vaultListComplete } from './session.js';

/**
 * The OneDrive folder of this device, or null. Smoke runs: only the test folder in KVPWSAFE_TEST_ONEDRIVE ('none' =
 * not connected); the demo: its own stand-in in the demo profile. Never the user's real OneDrive in a test.
 */
export async function oneDriveFolder() {
  if (smokeTest && process.env.KVPWSAFE_TEST_ONEDRIVE) return process.env.KVPWSAFE_TEST_ONEDRIVE === 'none' ? null : process.env.KVPWSAFE_TEST_ONEDRIVE;
  if (demo) return demoOneDrive();
  if (smokeTest) return null;
  const candidates = [process.env.OneDriveCommercial, process.env.OneDrive, process.env.OneDriveConsumer, ...(await registryFolders())];
  for (const dir of candidates.filter(Boolean)) {
    if (await fs.stat(dir).then((s) => s.isDirectory(), () => false)) return dir;
  }
  return null;
}

/** OneDrive accounts known to Windows (HKCU\Software\Microsoft\OneDrive\Accounts\*\UserFolder), business first. */
function registryFolders() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts', '/s', '/v', 'UserFolder'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      const found = [];
      let business = false;
      for (const line of String(out).split(/\r?\n/)) {
        if (/^HKEY_/i.test(line)) business = /\\Business\d+$/i.test(line.trim());
        const m = /^\s+UserFolder\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
        if (m) found[business ? 'unshift' : 'push'](m[1].trim());
      }
      resolve(found);
    });
  });
}

const copyPath = (folder) => path.join(folder, SETTINGS_FOLDER, SETTINGS_FILE_NAME);
const deviceName = () => (demo ? 'Demo-PC' : os.hostname());

/** Reads and checks a settings file → { settings, device, exportedAt, dropped } (throws when it is none). */
export async function readSettingsFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > SETTINGS_MAX_BYTES) throw new Error('not a settings file (size)');
  return parseSettingsFile(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------- the copy in OneDrive
let copyTimer = null;
let lastWritten = '';
const comparable = (content) => content.replace(/"exportedAt": "[^"]*",?/, '');

/** After every change of the settings (debounced): the copy follows, when OneDrive is there and the copy is on. */
export function scheduleSettingsCopy() {
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => writeSettingsCopy().catch((e) => diag(`SETTINGS copy failed: ${e.message}`)), smokeTest ? 300 : 2000);
}

/** The copy is blocked by a link (the folder in it): shown in Settings and once as a notice. */
export let copyBlocked = '';

/**
 * Windows refuses to replace a file another program has open for a moment (EPERM/EBUSY/EACCES: OneDrive, a virus
 * scanner, a reader): a few more tries before the copy counts as failed (#353; seen in the smoke run when the check read
 * the file at the moment of the rename). The temporary file goes when it still fails.
 */
async function renameWithRetry(from, to, tries = 8) {
  for (let i = 1; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        await fs.rm(from, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100 * i));
    }
  }
}

/**
 * Writes the copy when its content changed – only after the user agreed (settingsCopy true; #478 review: never
 * without asking, also not on installations from before). Not while the first start still asks whether to take the
 * settings of another device (settingsCopyPending): a new device would otherwise overwrite them with its empty
 * defaults. → the path written, or null.
 */
export async function writeSettingsCopy() {
  const s = config.get();
  if (s.settingsCopy !== true || s.settingsCopyPending) return null;
  // Nothing set up here and the first start not reached yet: there is nothing to keep, and a copy would replace one.
  if (!s.setupOffered && !s.containers.length && !s.fileContainers.length) return null;
  const folder = await oneDriveFolder();
  if (!folder) return null;
  const file = copyPath(folder);
  const linked = async () => {
    if (!(await linkedCopyFolder(folder))) return false;
    const was = copyBlocked;
    copyBlocked = path.join(folder, SETTINGS_FOLDER);
    diag('SETTINGS copy not written: the Keevault folder in OneDrive is a link');
    if (!was) send({ type: 'settingsCopyBlocked', folder: copyBlocked });
    return true;
  };
  if (await linked()) return null;
  copyBlocked = '';
  const content = buildSettingsFile(config.user, { device: deviceName() });
  if (!lastWritten) lastWritten = await fs.readFile(file, 'utf8').catch(() => '');
  if (comparable(content) === comparable(lastWritten)) return null;
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Checked again right before writing and before the rename (#478 re-review): a link put in place meanwhile gets
  // nothing. Node has no flag on Windows that refuses a junction in the path, so a tiny window remains.
  if (await linked()) return null;
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  if (await linked()) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return null;
  }
  await renameWithRetry(tmp, file);
  lastWritten = content;
  return file;
}

// ---------------------------------------------------------------- import (first start and menu)
// What was read and shown, until the user confirms: the window gets a token, never a path to hand back.
const pending = new Map();

/** The vaults the user sees now: { id, name } (Key Vault hosts, file vault ids). */
async function knownIds() {
  const list = await Promise.resolve(vault?.containers?.()).catch(() => null);
  return Array.isArray(list) ? list.filter((c) => c?.id).map((c) => ({ id: c.id, name: c.name || '' })) : [];
}

async function offer(read, source) {
  const token = crypto.randomBytes(16).toString('hex');
  pending.clear();
  pending.set(token, read.settings);
  // Read before the list: a search that ends in between still counts as running (#511 review).
  const complete = vaultListComplete();
  const known = await knownIds();
  const plan = importPlan(read.settings, config.get(), { knownIds: known, complete });
  // Each vault new from the file on its own line, to tick or not (#478 re-review). discovering: the vault search still
  // runs, the list may lack vaults of the user – none is ticked in advance, the window says to import again shortly.
  const newVaults = newVaultsOf(read.settings, config.get(), { knownIds: known });
  return { token, source, device: read.device, exportedAt: read.exportedAt, settings: read.settings, dropped: read.dropped, refused: plan.refused, confirm: plan.confirm, newVaults, discovering: !complete };
}

/** First start: is OneDrive there, and does it hold settings of another device? → { oneDrive, found, preview? }. */
export async function settingsCopyStatus() {
  const folder = await oneDriveFolder();
  if (!folder) return { oneDrive: false, found: false };
  const file = copyPath(folder);
  const exists = await fs.stat(file).then((x) => x.isFile(), () => false);
  if (!exists) return { oneDrive: true, found: false };
  try {
    return { oneDrive: true, found: true, preview: await offer(await readSettingsFile(file), 'onedrive') };
  } catch (e) {
    diag(`SETTINGS copy not readable: ${e.message}`);
    return { oneDrive: true, found: false, invalid: true };
  }
}

/** Menu import: a file the user picked, checked → the preview. */
export async function previewSettingsFile(file) {
  return offer(await readSettingsFile(file), 'file');
}

/**
 * The settings of a confirmed preview, as a patch for updateSettings: only the new vaults ticked in the preview are
 * added (none is removed), what would weaken this device is left out (importPlan), another app registration or a new
 * default vault only with confirmed naming it; everything else replaces the value here. Null when the token is unknown.
 */
export async function takeImport(token, confirmed = [], vaults = []) {
  const settings = pending.get(String(token || ''));
  pending.clear();
  if (!settings) return null;
  const ok = Array.isArray(confirmed) ? confirmed.filter((k) => typeof k === 'string') : [];
  const chosen = Array.isArray(vaults) ? vaults.filter((v) => typeof v === 'string') : [];
  const complete = vaultListComplete();
  const patch = importPlan(settings, config.get(), { knownIds: await knownIds(), confirmed: ok, vaults: chosen, complete }).take;
  if (patch.containers) {
    const here = config.get().containers || [];
    const known = new Set(here.map((c) => { try { return vaultHost(c.vaultUrl); } catch { return ''; } }));
    patch.containers = [...here, ...patch.containers.filter((c) => !known.has(vaultHost(c.vaultUrl)))];
  }
  return patch;
}

/** The export: the same content as the copy, for a file the user chose. */
export function exportContent() {
  return buildSettingsFile(config.user, { device: deviceName() });
}

/** The first start's question is answered (imported, declined, no OneDrive): from now on the copy is kept, when agreed. */
export function settingsCopyDecided() {
  if (config.get().settingsCopyPending) config.update({ settingsCopyPending: false });
  scheduleSettingsCopy();
}

/** Asking for the copy is due: not answered yet (also installations from before) and OneDrive is there. */
export async function settingsCopyConsentDue() {
  const s = config.get();
  if (s.settingsCopy === true || s.settingsCopy === false || s.settingsCopyPending) return false;
  return !!(await oneDriveFolder());
}

/** The user's answer (question or Settings): yes writes the copy now, no keeps nothing. */
export function setSettingsCopy(on) {
  config.update({ settingsCopy: on === true });
  scheduleSettingsCopy();
  return config.get().settingsCopy;
}
