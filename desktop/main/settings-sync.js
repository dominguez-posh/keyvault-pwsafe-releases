// Settings that travel in the personal vault (other devices).

import { SYNC_KEYS } from '../config.js';
import { demo, smokeTest } from './boot.js';
import { config, files, opened, updater } from './state.js';
import { diag } from './diag.js';
import { personalEntries } from './personal.js';
import { applyLanguage, refreshAll, send, signedIn } from './session.js';
import { applyShortcuts } from './typing.js';
import { applyView } from './window.js';

let settingsTimer = null;
export function scheduleSettingsSync() {
  if (demo || smokeTest || !config?.get().settingsSync) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => syncSettings().catch((e) => diag(`SETTINGS sync failed: ${e.message}`)), 1500);
}

/**
 * Settings ↔ personal vault: changed there (another device) and not here → taken over here; changed here → written
 * there (on top of what is there). A device that never synced takes the vault's state first – so a new device does
 * not overwrite the vaults of the others. settingsLocalAt ≠ 0 marks a change here (no clock comparison between
 * devices). Returns 'pulled', 'pushed' or null.
 */
export async function syncSettings() {
  const s = config.get();
  if (!s.settingsSync) return null;
  const entry = personalEntries().find((e) => e.vault && !e.vault.locked && e.vault.ck);
  if (!entry) return null;
  const remote = await files.appSettings(entry.id);
  const dirty = !!s.settingsLocalAt;
  if (remote && (!s.settingsSyncedAt || (!dirty && remote.updated !== s.settingsSyncedAt))) {
    const patch = Object.fromEntries(Object.entries(remote.value || {}).filter(([k]) => SYNC_KEYS.includes(k)));
    const before = config.get();
    config.update({ ...patch, settingsSyncedAt: remote.updated, settingsLocalAt: 0 }, { synced: true });
    const after = config.get();
    applyLanguage();
    if (before.autoTypeKeys !== after.autoTypeKeys) applyShortcuts();
    if (before.zoom !== after.zoom || before.transparency !== after.transparency || before.theme !== after.theme) applyView();
    if (before.updateMode !== after.updateMode || before.updateChannel !== after.updateChannel) updater?.applyMode();
    diag('SETTINGS taken from the personal vault');
    if (opened && signedIn()) await refreshAll();
    send({ type: 'changed' });
    return 'pulled';
  }
  if (remote && !dirty) return null;
  const value = { ...(remote?.value || {}), ...config.syncSnapshot() };
  if (remote && JSON.stringify(remote.value) === JSON.stringify(value)) {
    config.update({ settingsLocalAt: 0 }, { synced: true });
    return null;
  }
  const at = Math.max(Date.now(), (remote?.updated || 0) + 1);
  await files.setAppSettings(entry.id, value, at);
  config.update({ settingsSyncedAt: at, settingsLocalAt: 0 }, { synced: true });
  return 'pushed';
}
