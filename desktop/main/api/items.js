// API: entries – reading, saving, moving, versions, trash, copy and auto-type, import and export.

import { dialog } from 'electron';
import fs from 'node:fs/promises';
import { decryptKdbx } from '../../kdbx.js';
import { SAMPLE_CSV } from '../../../extension/core/import-sample.js';
import { mapLimit } from '../../../extension/core/util.js';
import { t } from '../../../extension/core/i18n.js';
import { CERT_MAX_BYTES, limitFolderDepth } from '../../../extension/core/model.js';
import { itemsToCsv } from '../../../extension/core/export.js';
import { smokeTest } from '../boot.js';
import { config, files, vault, win } from '../state.js';
import { api } from './index.js';
import { refreshStaleForBrowser } from '../browser.js';
import { copyToClipboard } from '../clipboard.js';
import { checkDeviceLinks } from '../devices.js';
import { requireFeature, requireOpen } from '../guards.js';
import { changed, refreshAll, send } from '../session.js';
import { autoTypeCalls, autoTypeText, autoTypeValue, selectedKey, setSelectedKey } from '../typing.js';

// Import: entries per block (progress and, in a file vault, one write each).
const IMPORT_BLOCK = 50;

export const itemsApi = {
  async refresh() {
    requireOpen();
    const discoverError = await refreshAll();
    return { ...(await api.state()), discoverError };
  },
  async items() {
    requireOpen();
    refreshStaleForBrowser().catch(() => {});
    return vault.summaries({ maxAgeMs: Infinity });
  },
  item: (containerId, id, fresh) => vault.getItem(containerId, id, { fresh }),
  save: async (containerId, item, expectedVersion) => {
    if (item?.type === 'server' && item.server) checkDeviceLinks(containerId, item.server);
    const saved = await vault.saveItem(containerId, item, { expectedVersion });
    config.update({ defaultContainer: containerId });
    return saved;
  },
  delete: (containerId, id) => vault.deleteItem(containerId, id),
  /** Entries (assets, linked logins) that use this login – "Show linked assets" in admin mode (#307). */
  linkedEntries: (containerId, id) => vault.linkedEntries(containerId, id),
  move: (fromId, toId, id, opts) => vault.moveItem(fromId, toId, id, opts),
  /**
   * Moves a passkey to another login (saved in the wrong entry). Added to the target first, removed from the source
   * after that – if the second step fails the passkey is in both entries, never in none.
   */
  async movePasskey({ from, to, credentialId }) {
    requireOpen();
    if (from.containerId === to.containerId && from.id === to.id) return false;
    const source = await vault.getItem(from.containerId, from.id, { fresh: true });
    const passkey = source.passkeys.find((p) => p.credentialId === credentialId);
    if (!passkey) throw new Error(t('Der Passkey ist nicht mehr in diesem Eintrag'));
    const target = await vault.getItem(to.containerId, to.id, { fresh: true });
    if (target.type !== 'login') throw new Error(t('Passkeys lassen sich nur in Login-Einträge verschieben'));
    if (!target.passkeys.some((p) => p.credentialId === credentialId)) {
      await vault.saveItem(to.containerId, {
        ...target, passkeys: [...target.passkeys, passkey], username: target.username || passkey.userName || '',
      }, { expectedVersion: target.version });
    }
    await vault.saveItem(from.containerId, { ...source, passkeys: source.passkeys.filter((p) => p.credentialId !== credentialId) }, { expectedVersion: source.version });
    return true;
  },
  history: (containerId, id) => vault.history(containerId, id),
  version: (containerId, id, version) => vault.getVersion(containerId, id, version),
  restoreVersion: (containerId, id, version) => vault.restoreVersion(containerId, id, version),
  trash: (containerId) => vault.trash(containerId),
  restore: (containerId, id) => vault.restore(containerId, id),
  async purge(containerId, id) {
    await requireFeature(containerId, 'purge');
    return vault.purge(containerId, id);
  },

  /** CSV export of a vault's entries – only when an admin enabled it in the vault settings. */
  async exportItems(containerId) {
    requireOpen();
    const c = await requireFeature(containerId, 'export');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Einträge exportieren'),
      defaultPath: `${String(c.name || 'Tresor').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    const list = (await vault.summaries()).filter((s) => s.containerId === containerId);
    let done = 0;
    const items = await mapLimit(list, 4, async (s) => {
      const item = await vault.getItem(containerId, s.id, { fresh: true });
      send({ type: 'progress', done: ++done, total: list.length });
      return item;
    });
    await fs.writeFile(filePath, itemsToCsv(items), 'utf8');
    return { filePath, count: items.length };
  },

  async changelog(containerId, itemId) {
    const c = await vault.container(containerId);
    return c.kind === 'file' ? files.changelog(containerId, itemId) : [];
  },
  async duplicate(containerId, id) {
    requireOpen();
    const r = await vault.duplicateItem(containerId, id);
    changed();
    return r;
  },

  copy: (text) => copyToClipboard(String(text)),
  /**
   * Auto-type for Strg+Umschalt+U/P/O: minimizes the app so that the previous window gets the focus back and
   * types user name, password or current one-time code there – no clipboard involved.
   */
  /** Types a freshly generated password into the previous window (generator dialog). */
  async typeGenerated(text) {
    if (!text) return false;
    if (smokeTest) {
      autoTypeCalls.push('generated');
      return true;
    }
    win?.minimize();
    await new Promise((r) => setTimeout(r, 400));
    await autoTypeText(String(text));
    return true;
  },
  /** The renderer reports the selected entry; global auto-type uses it. */
  selectItem: (key) => {
    setSelectedKey(key || null);
  },
  async autoType(containerId, itemId, what) {
    requireOpen();
    const value = await autoTypeValue(`${containerId}/${itemId}`, what);
    // Tests: never type into the desktop of whoever runs them – only record the call.
    if (smokeTest) {
      autoTypeCalls.push(what);
      return true;
    }
    win?.minimize();
    await new Promise((r) => setTimeout(r, 400));
    await autoTypeText(value);
    return true;
  },
  // No export: entries never leave the app as a plain file (only encrypted owner backups, see createBackup). The only file the
  // app writes on request is the built-in import sample – never content passed in by the renderer.
  /** The certificate file of one entry, on explicit request (Save as…) – the file itself is what the entry holds. */
  async saveCertificate(name, data) {
    requireOpen();
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length || bytes.length > CERT_MAX_BYTES) throw new Error(t('Ungültige Zertifikatsdatei'));
    const safeName = String(name || 'zertifikat.pfx').replace(/[\\/:*?"<>|]+/g, '_');
    const ext = (safeName.match(/\.([a-z0-9]+)$/i) || [])[1];
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Zertifikat speichern'),
      defaultPath: safeName,
      filters: ext ? [{ name: t('Zertifikat'), extensions: [ext] }] : [],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, bytes);
    return filePath;
  },
  async saveSampleCsv() {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'kvpwsafe-import-sample.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, SAMPLE_CSV, 'utf8');
    return filePath;
  },
  /** KeePass database for the import: decrypted here (never leaves the app), returned as KeePass XML. */
  decryptKdbx(bytes, { password = '', keyFile = null } = {}) {
    requireOpen();
    return decryptKdbx(Buffer.from(bytes), { password: String(password || ''), keyFile: keyFile ? Buffer.from(keyFile) : null });
  },
  async importItems(containerId, items, { folderIcons = {}, folders = [] } = {}) {
    requireOpen();
    await requireFeature(containerId, 'import');
    // At most three folder levels: deeper source folders go into the third level's name ("A/B/C/D" → "A/B/C – D").
    items = items.map((i) => ({ ...i, folder: limitFolderDepth(i.folder) }));
    // Folder symbols of the source (e.g. KeePass group icons): set where no symbol is chosen yet; a deeper folder keeps
    // its symbol under its shortened path.
    const icons = [...new Map(Object.entries(folderIcons || {}).map(([p, v]) => [limitFolderDepth(p), v]).filter(([p, v]) => p && v)).entries()];
    if (icons.length) {
      const have = await vault.folderIcons(containerId).catch(() => ({}));
      const patch = Object.fromEntries(icons.filter(([p]) => !have[p]));
      try {
        if (Object.keys(patch).length) await vault.setFolderIcons(containerId, patch);
      } catch {
        // Too many own images for the vault: the standard symbols at least.
        await vault.setFolderIcons(containerId, Object.fromEntries(Object.entries(patch).filter(([, v]) => !v.startsWith('data:')))).catch(() => {});
      }
    }
    // Folders of the source without entries (#327 – empty KeePass groups) are created as well.
    const used = new Set(items.flatMap((i) => i.folder.split('/').map((_, n, parts) => parts.slice(0, n + 1).join('/'))));
    for (const f of new Set((folders || []).map(limitFolderDepth))) {
      if (f && !used.has(f)) await vault.addFolder(containerId, f).catch(() => {});
    }
    // In blocks (#326): a file vault writes each block at once; every entry that fails is named.
    const errors = [];
    let done = 0;
    for (let i = 0; i < items.length; i += IMPORT_BLOCK) {
      const block = items.slice(i, i + IMPORT_BLOCK);
      const results = await vault.saveItems(containerId, block);
      results.forEach((r, n) => { if (r?.error || !r?.item) errors.push(`${block[n].title}: ${r?.error || t('Nicht gespeichert')}`); });
      done += block.length;
      send({ type: 'progress', done, total: items.length });
    }
    changed();
    return { imported: items.length - errors.length, errors };
  },
};
