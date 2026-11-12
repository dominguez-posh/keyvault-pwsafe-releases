// OneDrive detection from several signals, as a fallback when the Cloud Files API (Keevault-Update.exe --location)
// says "local" or gives no answer (#514: a fresh profile / Windows Sandbox has the sync root, but the call fails).
// Pure functions, no Electron: signals are passed in, so the tests can vary them.

import path from 'node:path';

// Cloud Files attributes of a file or folder: recall on open / on data access, pinned, unpinned.
export const CLOUD_ATTRIBUTES = 0x40000 | 0x400000 | 0x80000 | 0x100000;

/** True when the attribute bits (number) of a path carry a Cloud Files / placeholder flag. */
export const hasCloudAttributes = (attrs) => Number.isInteger(attrs) && (attrs & CLOUD_ATTRIBUTES) !== 0;

/** Folders named by the OneDrive environment variables (business, personal, consumer). */
export function envRoots(env = process.env) {
  return ['OneDriveCommercial', 'OneDrive', 'OneDriveConsumer'].map((k) => env[k]).filter((v) => typeof v === 'string' && v.trim());
}

/** UserFolder values from the output of `reg query HKCU\Software\Microsoft\OneDrive\Accounts /s /v UserFolder`. */
export function parseRegistryRoots(output) {
  const roots = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = /^\s*UserFolder\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (m) roots.push(m[1]);
  }
  return roots;
}

const norm = (p) => path.win32.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

/** Is `target` the folder `root` or below it (case-insensitive, whole path segments)? */
export function isUnder(target, root) {
  if (!target || !root) return false;
  const t = norm(target);
  const r = norm(root);
  return t === r || t.startsWith(r + '\\');
}

/**
 * Cloud location from fallback signals, or null when none points to OneDrive. Signals: `env`, `registryRoots` (the
 * UserFolder values of the OneDrive accounts) and `attrs` (attribute bits of the folder, null when unknown).
 * The folder name alone ("OneDrive - Org") is no signal: a local folder can carry it.
 */
export function detectOneDrive(target, { env = process.env, registryRoots = [], attrs = null } = {}) {
  const hit = [...registryRoots, ...envRoots(env)].some((root) => isUnder(target, root)) || hasCloudAttributes(attrs);
  return hit ? { kind: 'cloud', provider: 'OneDrive', providerStatus: 'unknown', file: false, inSync: null, pinned: null } : null;
}
