// Settings as a file (#478): the copy in OneDrive (OneDrive\Keevault\Keevault-Einstellungen.json, kept up to date),
// the question at the first start and export/import from the menu. What goes in and what is read back is decided in
// desktop/settings-file.js. #537 stage 5 (E5): the copy in OneDrive is encrypted with a key from the personal vault's
// container key (desktop/settings-sealed.js) – no personal vault, no copy; the plain copy of before is replaced (or
// removed) once; only the export from the menu is still plain. A new device takes the copy with the master password
// (adoptOneDriveSetup). The sync over the personal vault (settings-sync.js) stays as it is.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vaultHost } from '../../extension/core/keyvault.js';
import { keyVersionOf } from '../../extension/core/protect.js';
import { t } from '../../extension/core/i18n.js';
import { buildSettingsFile, importPlan, linkedCopyFolder, newVaultsOf, parseSettingsFile, pickSettings, SETTINGS_FILE_NAME, SETTINGS_FOLDER, SETTINGS_MAX_BYTES } from '../settings-file.js';
import { openSealedFile, peekSealedFile, sealSettingsFile } from '../settings-sealed.js';
import { demo, smokeTest } from './boot.js';
import { config, files, vault } from './state.js';
import { diag } from './diag.js';
import { demoOneDrive, personalEntries, personalInfo, personalPaths, refreshFileLocations, requirePersonalLocation } from './personal.js';
import { isMigrated, mayBind, migrate } from './unlock.js';
import { changed, send, vaultListComplete } from './session.js';

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

/** The file's text, at most SETTINGS_MAX_BYTES; null when there is none. */
async function readLimited(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > SETTINGS_MAX_BYTES) throw new Error('not a settings file (size)');
  return fs.readFile(file, 'utf8');
}

/** The old plain copy (#478, version 1)? Only that one counts as plain – anything else is no copy of ours. */
function isPlainCopy(text) {
  try {
    peekSealedFile(text);
    return false;
  } catch (e) {
    return e.code === 'plain';
  }
}

/**
 * E5: the key of the copy – from the personal vault that is open here and bound to the app's master password (its
 * lineage), with the key generation it is at. Null without one: no personal vault, no copy.
 */
async function copyKey() {
  for (const entry of personalEntries()) {
    const v = entry.vault;
    if (!v || v.locked || !v.ck?.raw || !v.keyring) continue;
    const kv = keyVersionOf(v.keyring);
    if ((v.ck.kv ?? kv) !== kv) continue; // the key changed elsewhere and is not followed here yet
    if (isMigrated() && !(await mayBind(entry, v.ck).catch(() => false))) continue;
    return { ckRaw: Buffer.from(v.ck.raw), vaultId: entry.id, kv };
  }
  return null;
}

/**
 * Reads and checks a settings file → { settings, device, exportedAt, dropped } (throws when it is none). An encrypted
 * copy (E5) opens only with the personal vault open here; a plain file (the export) is read as before.
 */
export async function readSettingsFile(file) {
  const raw = await readLimited(file);
  if (raw == null) throw new Error('not a settings file (missing)');
  let sealed = false;
  try {
    sealed = JSON.parse(raw.replace(/^﻿/, ''))?.version === 2;
  } catch {
    // parseSettingsFile says why
  }
  if (!sealed) return { ...parseSettingsFile(raw), plain: true }; // Konrad (review of 8f5521b): its origin is not checked
  const key = await copyKey();
  if (!key) throw new Error('settings copy: personal vault not open');
  return openSealedFile(raw, key);
}

// ---------------------------------------------------------------- the copy in OneDrive
let copyTimer = null;
let lastStamp = ''; // what the copy holds (vault, key generation, device, settings) – compared instead of the ciphertext

/** After every change of the settings or a vault (debounced): the copy follows, when OneDrive is there and the copy is on. */
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

/** E5: the plain copy of before is gone – the user hears once that older versions may still be in OneDrive. */
function plainCopyGone(how) {
  diag(`SETTINGS plain copy ${how}`);
  // An older app on another device may write the plain copy again: it is replaced each time, the notice comes once per
  // device (Konrad, review of 8f5521b).
  const first = !config.get().settingsCopyPlainGone;
  config.update({ settingsCopyPlainGone: new Date().toISOString() });
  if (first) send({ type: 'settingsCopyPlainGone' });
}

/**
 * Writes the copy when its content changed – only after the user agreed (settingsCopy true; #478 review: never
 * without asking, also not on installations from before). Not while the first start still asks whether to take the
 * settings of another device (settingsCopyPending): a new device would otherwise overwrite them with its empty
 * defaults. E5: encrypted with the personal vault's key, written anew after every key change (the generation is part
 * of it); without a personal vault open nothing is written and a plain copy of before is removed. → the path written,
 * or null.
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
  const current = await readLimited(file).catch(() => null);
  const plainBefore = current != null && isPlainCopy(current);
  const key = await copyKey();
  if (!key) {
    if (plainBefore) {
      await fs.rm(file, { force: true });
      plainCopyGone('removed (no personal vault open)');
    }
    return null;
  }
  const stampOf = (device, settings) => JSON.stringify({ vault: key.vaultId, kv: key.kv, device, settings });
  const stamp = stampOf(deviceName(), pickSettings(config.user));
  if (!plainBefore && current != null) {
    if (stamp === lastStamp) return null;
    if (!lastStamp) {
      try {
        const r = openSealedFile(current, key);
        if (stampOf(r.device, r.settings) === stamp) {
          lastStamp = stamp;
          return null;
        }
      } catch {
        // another vault, an older key, changed: replaced below
      }
    }
  }
  const content = sealSettingsFile(config.user, { ...key, device: deviceName() });
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
  lastStamp = stamp;
  if (plainBefore) plainCopyGone('replaced by the encrypted copy');
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
  return { token, source, device: read.device, exportedAt: read.exportedAt, settings: read.settings, dropped: read.dropped, refused: plan.refused, confirm: plan.confirm, newVaults, discovering: !complete, plain: read.plain === true };
}

let offeredThisStart = false; // the new-device step took the copy already: the later first-start step does not offer it again

/**
 * First start: is OneDrive there, and does it hold settings of another device? → { oneDrive, found, preview?, plain?,
 * locked? }. E5: only the encrypted copy is offered, and only with the personal vault open here; the plain copy of
 * before is not taken by itself any more (plain: true – the menu import still reads it when the user picks it).
 */
export async function settingsCopyStatus() {
  const folder = await oneDriveFolder();
  if (!folder) return { oneDrive: false, found: false };
  try {
    const raw = await readLimited(copyPath(folder));
    if (raw == null || offeredThisStart) return { oneDrive: true, found: false };
    if (isPlainCopy(raw)) return { oneDrive: true, found: false, plain: true };
    peekSealedFile(raw);
    const key = await copyKey();
    if (!key) return { oneDrive: true, found: false, locked: true };
    return { oneDrive: true, found: true, preview: await offer(openSealedFile(raw, key), 'onedrive') };
  } catch (e) {
    diag(`SETTINGS copy not readable: ${e.message}`);
    return { oneDrive: true, found: false, invalid: true };
  }
}

// ---------------------------------------------------------------- new device (#537 E5)

/**
 * A new device: nothing set up here (no master password, no personal vault), and OneDrive holds the encrypted copy and
 * the personal vault. → { found, device?, exportedAt?, plain? } – device and date from the readable head.
 */
export async function oneDriveSetupStatus() {
  if (isMigrated() || personalPaths().length) return { found: false };
  const folder = await oneDriveFolder();
  if (!folder) return { found: false };
  try {
    const raw = await readLimited(copyPath(folder));
    if (raw == null) return { found: false };
    if (isPlainCopy(raw)) return { found: false, plain: true };
    const head = peekSealedFile(raw);
    if (!(await personalInfo(folder)).exists) return { found: false };
    return { found: true, device: head.device, exportedAt: head.exportedAt };
  } catch (e) {
    diag(`SETTINGS copy not readable: ${e.message}`);
    return { found: false };
  }
}

const ADOPT_ERRORS = {
  tampered: 'Die Konfiguration im OneDrive wurde verändert oder passt nicht zu deinem persönlichen Tresor – sie wird nicht übernommen.',
  older: 'Die Konfiguration im OneDrive stammt von einem älteren Schlüssel deines persönlichen Tresors – sie wird nicht übernommen.',
  newer: 'Die Konfiguration im OneDrive stammt von einem neueren Schlüssel – bitte Keevault aktualisieren oder später erneut versuchen.',
  vault: 'Die Konfiguration im OneDrive gehört zu einem anderen persönlichen Tresor – sie wird nicht übernommen.',
  format: 'Die Konfiguration im OneDrive ist beschädigt – sie wird nicht übernommen.',
};

/**
 * "Keevault-Konfiguration in OneDrive gefunden – übernehmen?" → the master password: the personal vault in OneDrive is
 * listed and opened with it (counted, as the move to the master password: desktop/unlock-service.js migrate), the
 * master password of the app is set up, then the copy is opened with the vault's key and checked strictly. A wrong
 * master password changes nothing. → { preview?, error? } – the preview goes through the same import as before
 * (importPlan, ticks); error: why the copy itself was not taken (the vault and the master password stay set up).
 */
export async function adoptOneDriveSetup(password) {
  if (isMigrated() || personalPaths().length) throw new Error(t('Keevault ist auf diesem Gerät schon eingerichtet.'));
  const folder = await oneDriveFolder();
  const raw = folder ? await readLimited(copyPath(folder)).catch(() => null) : null;
  if (raw == null) throw new Error(t('Im OneDrive liegt keine Keevault-Konfiguration.'));
  if (isPlainCopy(raw)) throw new Error(t('Im OneDrive liegt nur eine alte, unverschlüsselte Kopie der Einstellungen – sie wird nicht automatisch übernommen.'));
  const head = peekSealedFile(raw);
  const info = await personalInfo(folder);
  if (!info.exists) throw new Error(t('Im OneDrive liegt kein persönlicher Tresor.'));
  requirePersonalLocation(info);
  const listedBefore = [...(files?.entries?.values() || [])].some((e) => e.path === info.path);
  const id = await files.open(info.path);
  config.update({ personalVaults: [info.path] });
  try {
    await migrate({ password: String(password ?? ''), keepPin: false });
  } catch (e) {
    // Nothing taken over: the vault is not listed (unless it was before), the master password not set up.
    if (listedBefore) config.update({ personalVaults: [] });
    else files.remove(id);
    throw e;
  }
  refreshFileLocations().catch(() => {});
  offeredThisStart = true;
  let read = null;
  let error = null;
  try {
    const key = await copyKey();
    if (!key) throw Object.assign(new Error('personal vault not open'), { code: 'tampered' });
    if (head.vault !== key.vaultId) throw Object.assign(new Error('another vault'), { code: 'vault' });
    read = openSealedFile(raw, key);
  } catch (e) {
    error = e.code || 'format';
    diag(`SETTINGS copy not taken on the new device: ${error}`);
  }
  changed();
  diag('SETTINGS new device set up from OneDrive (personal vault, master password)');
  return { preview: read ? await offer(read, 'onedrive') : null, error: error ? t(ADOPT_ERRORS[error] || ADOPT_ERRORS.format) : null };
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
