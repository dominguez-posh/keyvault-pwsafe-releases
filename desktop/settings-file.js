// Settings file (#478): a copy of the app settings in OneDrive and the export/import in the menu. Plain JSON, not
// encrypted – so only an allowlist goes in (the settings that travel with the personal vault: vault list, view,
// behaviour) and never a PIN, device key, token, licence or recovery material. Reading is strict: marker, version,
// only allowlisted keys with the right type, vault addresses only https://<name>.vault.azure.net. No Electron here
// (unit tests import it).

import fs from 'node:fs/promises';
import path from 'node:path';

export const SETTINGS_MARKER = 'kvpwsafe-settings';
export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = 'Keevault-Einstellungen.json';
export const SETTINGS_FOLDER = 'Keevault';
/** Larger files are not read at all. */
export const SETTINGS_MAX_BYTES = 256 * 1024;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,10}$/i;
const VAULT_URL = /^https:\/\/([a-z0-9-]{3,24})\.vault\.azure\.net\/?$/i;
// Container ids: Key Vault host names or file vault ids – no paths, no spaces.
const CONTAINER_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const oneOf = (...values) => (v) => values.includes(v);
const bool = (v) => typeof v === 'boolean';
const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const ids = (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => CONTAINER_ID.test(x));
const tenant = (v) => v === '' || (typeof v === 'string' && (GUID.test(v) || DOMAIN.test(v)));

/** https://<name>.vault.azure.net/ (normalized) or null. */
export function vaultUrlOf(v) {
  const m = typeof v === 'string' ? VAULT_URL.exec(v.trim()) : null;
  return m ? `https://${m[1].toLowerCase()}.vault.azure.net/` : null;
}

/** A vault of the list: name, address, tenant – anything else is left out. Null when it is not valid. */
function cleanContainer(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const vaultUrl = vaultUrlOf(c.vaultUrl);
  if (!vaultUrl) return null;
  if (c.name !== undefined && !text(c.name, 200)) return null;
  if (c.tenantId !== undefined && c.tenantId !== '' && !tenant(c.tenantId)) return null;
  return { name: c.name || '', vaultUrl, ...(c.tenantId ? { tenantId: c.tenantId } : {}) };
}

/**
 * The allowlist: the settings that travel with the personal vault (SYNC_KEYS in desktop/config.js – a unit test keeps
 * both equal) except the break-glass accounts: those get "manage" on every new vault, so a planted file must never set
 * them – they are neither written nor read here (#478 review). Each key: a check, or a function that cleans the value
 * (undefined = not valid).
 */
export const SETTINGS_FILE_KEYS = {
  containers: (v) => (Array.isArray(v) && v.length <= 200 ? v.map(cleanContainer).filter(Boolean) : undefined),
  hiddenContainers: ids,
  containerOrder: ids,
  defaultContainer: (v) => v === '' || CONTAINER_ID.test(v),
  tenantId: tenant,
  clientId: (v) => v === '' || (typeof v === 'string' && GUID.test(v)),
  autoLockMinutes: int(0, 1440),
  clipboardSeconds: int(0, 600),
  unlockPrompt: oneOf('none', 'select_account', 'login'),
  language: oneOf('auto', 'de', 'en'),
  zoom: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 3,
  transparency: oneOf('off', 'light', 'strong'),
  theme: oneOf('system', 'light', 'dark'),
  sourceBadges: bool,
  autoTypeKeys: oneOf('CommandOrControl+Shift', 'CommandOrControl+Alt', ''),
  updateMode: oneOf('ask', 'auto', 'off'),
  updateChannel: oneOf('stable', 'beta'),
  autoDiscover: bool,
  signInWindows: bool,
  pimOnLock: bool,
  adminPim: bool,
  adminOffered: bool,
};
/** Travel with the personal vault, but never in the plain file. */
export const NEVER_IN_FILE = ['breakGlass'];
// This one cleans its value (drops what is not valid) instead of refusing it as a whole.
const CLEANERS = new Set(['containers']);

/** Only the allowlisted, valid values of these settings (what an export or the OneDrive copy writes). */
export function pickSettings(settings) {
  const out = {};
  for (const [key, check] of Object.entries(SETTINGS_FILE_KEYS)) {
    if (!Object.hasOwn(settings || {}, key)) continue;
    const v = settings[key];
    if (CLEANERS.has(key)) {
      const clean = check(v);
      // A list of vaults none of which is valid counts as not valid (an empty list given stays empty).
      if (clean !== undefined && !(key === 'containers' && !clean.length && v.length)) out[key] = clean;
    } else if (check(v)) out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

/** The file's content (pretty JSON): marker, version, device and time, the allowlisted settings. */
export function buildSettingsFile(settings, { device = '', now = new Date() } = {}) {
  return `${JSON.stringify({
    marker: SETTINGS_MARKER,
    version: SETTINGS_VERSION,
    device: text(device, 100) ? device : '',
    exportedAt: now.toISOString(),
    settings: pickSettings(settings),
  }, null, 2)}\n`;
}

/**
 * Reads a settings file strictly. → { settings, device, exportedAt, dropped } – dropped names the keys left out
 * (unknown or not valid). Throws with a short English reason when the file is not a Keevault settings file.
 */
export function parseSettingsFile(raw) {
  const str = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (str === null || Buffer.byteLength(str, 'utf8') > SETTINGS_MAX_BYTES) throw new Error('not a settings file (size)');
  let data;
  try {
    data = JSON.parse(str.replace(/^﻿/, ''));
  } catch {
    throw new Error('not a settings file (JSON)');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.marker !== SETTINGS_MARKER) throw new Error('not a settings file (marker)');
  if (data.version !== SETTINGS_VERSION) throw new Error('settings file of another version');
  const given = data.settings;
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error('settings file without settings');
  const settings = pickSettings(given);
  const dropped = Object.keys(given).filter((k) => !Object.hasOwn(settings, k));
  // A vault list with some vaults left out counts as dropped too (the preview says so).
  if (Array.isArray(given.containers) && settings.containers && settings.containers.length !== given.containers.length) dropped.push('containers');
  const at = typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt)) ? new Date(data.exportedAt).toISOString() : '';
  return { settings, device: text(data.device, 100) ? data.device : '', exportedAt: at, dropped: [...new Set(dropped)] };
}

// ---------------------------------------------------------------- what an import may change (#478 review)
// A settings file may come from anywhere (a planted OneDrive copy, a mail attachment). It must not weaken this
// device: a setting that would make it less safe is not taken over – unless it is as strict or stricter than now.

const hostOf = (vaultUrl) => new URL(vaultUrl).host;
const notLonger = (v, cur) => v === cur || (v > 0 && (!(cur > 0) || v < cur)); // 0 = never
const STRICT = {
  autoLockMinutes: (v, cur) => notLonger(v, cur ?? 0),
  clipboardSeconds: (v, cur) => notLonger(v, cur ?? 0),
  unlockPrompt: (v, cur) => v !== 'none' || cur === 'none',
  updateMode: (v, cur) => v !== 'off' || cur === 'off',
  updateChannel: (v, cur) => v === cur || v === 'stable',
  autoDiscover: (v, cur) => v === !!cur || v === false,
};
/** Another app registration, or a vault new from the file as the default: only with the user's own tick in the preview. */
export const CONFIRM_KEYS = ['tenantId', 'clientId', 'defaultContainer'];
/** Never taken from a file: they make a look-alike vault easier to mistake for the real one (#478 re-review). */
export const NOT_IMPORTED = ['sourceBadges', 'containerOrder'];

const hostSafe = (vaultUrl) => { try { return hostOf(vaultUrl); } catch { return ''; } };
/**
 * The name a vault is shown with, in the form names are compared in: its name, else the first part of its host;
 * NFKC (full-width and other compatibility forms become the plain letter), without invisible format characters
 * (zero-width space, joiners, direction marks) and without any white space, without case (#511 review). A look-alike
 * that differs only in what the eye does not see counts as the same name; a name of nothing visible counts as none.
 */
const comparable = (s) => String(s || '').normalize('NFKC').replace(/[\p{Cf}\s]/gu, '').toLowerCase();
const shownName = (name, id) => comparable(name) || comparable(String(id || '').split('.')[0]);

/**
 * The user's vaults now (#478 re-review): the vaults of the list here and those the user sees (Key Vault hosts, file
 * vault ids). known: ids, or { id, name }. → Map id → name shown.
 */
function mineOf(current, known) {
  const mine = new Map();
  for (const c of current.containers || []) {
    const id = hostSafe(c?.vaultUrl);
    if (id) mine.set(id, shownName(c.name, id));
  }
  for (const k of known) {
    const id = typeof k === 'string' ? k : k?.id;
    if (typeof id === 'string' && id && !mine.has(id)) mine.set(id, shownName(typeof k === 'string' ? '' : k.name, id));
  }
  return mine;
}

/**
 * The vaults of the file this device does not have yet, one by one for the preview: { id, name, vaultUrl, tenantId,
 * clash } – clash: a vault of the user is shown with the same name (so it is another vault – a look-alike).
 */
export function newVaultsOf(settings, current = {}, { knownIds = [] } = {}) {
  const mine = mineOf(current, knownIds);
  const names = new Set(mine.values());
  const seen = new Set();
  const out = [];
  for (const c of settings.containers || []) {
    const id = hostSafe(c.vaultUrl);
    if (!id || mine.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: c.name || '', vaultUrl: c.vaultUrl, tenantId: c.tenantId || '', clash: names.has(shownName(c.name, id)) });
  }
  return out;
}

/**
 * Which of the file's (already checked) settings an import applies here. current: the settings now; knownIds: the
 * vaults the user sees now (ids, or { id, name }); confirmed: the keys of CONFIRM_KEYS the user ticked; vaults: the ids
 * of the new vaults the user ticked (newVaultsOf) – none without a tick; complete: false while the vault search still
 * runs and knownIds may lack vaults of the user (#511 review).
 * → { take, refused, confirm } – take: the settings applied (containers: only the ticked new vaults); refused: keys
 * left out for safety; confirm: keys that need the tick and did not get it.
 *
 * What the file brings along never makes a vault of the user vanish or takes its place as the default (#478
 * re-review): a file may list the user's own vault next to a look-alike of the same name.
 */
export function importPlan(settings, current = {}, { knownIds = [], confirmed = [], vaults = [], complete = true } = {}) {
  const take = {};
  const refused = [];
  const confirm = [];
  const mine = mineOf(current, knownIds);
  const fresh = new Set(newVaultsOf(settings, current, { knownIds }).map((c) => c.id));
  const ticked = new Set((Array.isArray(vaults) ? vaults : []).filter((id) => fresh.has(id)));
  const hiddenNow = new Set(current.hiddenContainers || []);
  for (const [key, v] of Object.entries(settings)) {
    let ok = true;
    if (NOT_IMPORTED.includes(key)) ok = false;
    else if (STRICT[key]) ok = STRICT[key](v, current[key]);
    else if (key === 'containers') {
      const chosen = v.filter((c) => ticked.has(hostSafe(c.vaultUrl)));
      if (chosen.length) take.containers = chosen;
      continue;
    } else if (key === 'defaultContainer') {
      // A vault of the user, or none; a vault new from the file only when ticked as a vault and as the default.
      if (v !== '' && !mine.has(v)) {
        if (!fresh.has(v)) ok = false;
        else if (!confirmed.includes(key)) {
          confirm.push(key);
          continue;
        } else ok = ticked.has(v);
      }
    } else if (key === 'hiddenContainers') {
      // Only vaults the user does not have; whether the file lists them too does not count. While the vault search
      // still runs (first start), which vaults are the user's is not known yet: nothing hidden then (#511 review).
      ok = complete && v.every((id) => !mine.has(id) || hiddenNow.has(id));
    } else if (CONFIRM_KEYS.includes(key) && v !== (current[key] ?? '')) {
      if (!confirmed.includes(key)) {
        confirm.push(key);
        continue;
      }
    }
    if (ok) take[key] = v;
    else refused.push(key);
  }
  return { take, refused, confirm };
}

/**
 * OneDrive\Keevault is a junction or symbolic link (a reparse point), or the file is: the copy would land somewhere
 * else than the user sees – nothing is written there (#478 review).
 */
export async function linkedCopyFolder(folder) {
  const dir = path.join(folder, SETTINGS_FOLDER);
  for (const p of [dir, path.join(dir, SETTINGS_FILE_NAME)]) {
    const st = await fs.lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) return true;
  }
  const real = await fs.realpath(dir).catch(() => null);
  const base = await fs.realpath(folder).catch(() => folder);
  return !!real && path.resolve(real).toLowerCase() !== path.resolve(base, SETTINGS_FOLDER).toLowerCase();
}
