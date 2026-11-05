// API: folders and their symbols.

import { mapLimit } from '../../../extension/core/util.js';
import { t } from '../../../extension/core/i18n.js';
import { requireFolderDepth } from '../../../extension/core/model.js';
import { moveFolderIcons } from '../../../extension/core/folder-icons.js';
import { vault } from '../state.js';
import { diag } from '../diag.js';
import { requireFeature, requireOpen } from '../guards.js';
import { changed } from '../session.js';

export const foldersApi = {
  folders: (containerId) => vault.folders(containerId),
  async addFolder(containerId, folderPath) {
    await requireFeature(containerId, 'folders');
    await vault.addFolder(containerId, folderPath);
    changed();
  },
  async removeFolder(containerId, folderPath) {
    await requireFeature(containerId, 'folders');
    await vault.removeFolder(containerId, folderPath);
    changed();
  },
  folderIcons: (containerId) => vault.folderIcons(containerId),
  /** icon: a symbol name or a small image (data URL); '' = the plain folder again. */
  async setFolderIcon(containerId, folderPath, icon) {
    requireOpen();
    await requireFeature(containerId, 'folders');
    await vault.setFolderIcons(containerId, { [String(folderPath || '')]: icon || '' });
    changed();
  },
  /**
   * Renames a folder incl. subfolders and moves its entries along. to = '' moves everything one level up
   * (used when deleting a folder that still has content). Returns { moved, errors }.
   */
  async renameFolder(containerId, from, to, scope = '') {
    requireOpen();
    await requireFeature(containerId, 'folders');
    const clean = (p) => String(p || '').split('/').map((x) => x.trim()).filter(Boolean).join('/');
    const src = clean(from);
    const dst = clean(to);
    if (!src) throw new Error(t('Bitte einen Ordnernamen eingeben'));
    if (dst === src) return { moved: 0, errors: [] };
    if (dst.startsWith(`${src}/`)) throw new Error(t('Ein Ordner kann nicht in sich selbst verschoben werden'));
    const map = (p) => (p === src ? dst : p.startsWith(`${src}/`) ? clean(`${dst}/${p.slice(src.length + 1)}`) : p);
    // Nothing may end up deeper than the allowed folder levels – checked before anything changes.
    const inTree = (p) => p === src || p.startsWith(`${src}/`);
    // scope "assets" / "secrets": only that side's entries and empty folders (assets' carry the "assets:" prefix).
    const ns = scope === 'assets' ? 'assets:' : '';
    const ownSide = (s) => (scope === 'assets' ? s.type === 'server' : scope === 'secrets' ? s.type !== 'server' : true);
    const explicit = (await vault.folders(containerId)).filter((f) => !scope || f.startsWith('assets:') === (scope === 'assets')).map((f) => f.slice(ns.length));
    const icons = await vault.folderIcons(containerId).catch(() => ({}));
    const entries = (await vault.summaries()).filter((s) => s.containerId === containerId && ownSide(s));
    for (const p of [...explicit, ...entries.map((s) => s.folder || '')].filter(inTree)) requireFolderDepth(map(p));
    // Explicit (possibly empty) folders: add the new paths, then drop the old tree.
    for (const f of explicit) {
      if (inTree(f) && map(f)) await vault.addFolder(containerId, ns + map(f));
    }
    await vault.removeFolder(containerId, ns + src);
    // Symbols move along with the folder (removeFolder dropped them with the old tree).
    const iconPatch = Object.fromEntries(Object.entries(moveFolderIcons(icons, ns + src, dst ? ns + dst : '')).filter(([, v]) => v));
    if (Object.keys(iconPatch).length) await vault.setFolderIcons(containerId, iconPatch).catch((e) => diag(`FOLDER icons not moved: ${e.message}`));
    const errors = [];
    let moved = 0;
    const affected = entries.filter((s) => inTree(s.folder || ''));
    await mapLimit(affected, 4, async (s) => {
      try {
        const item = await vault.getItem(containerId, s.id, { fresh: true });
        await vault.saveItem(containerId, { ...item, folder: map(item.folder || '') }, { expectedVersion: item.version });
        moved++;
      } catch (e) {
        errors.push(`${s.title}: ${e.message}`);
      }
    });
    changed();
    return { moved, errors };
  },
};
