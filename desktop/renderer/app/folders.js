// Folders in the list: rows, menu, symbols, renaming and creating.

import { h, icon, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { pickImage } from '../../../extension/core/image.js';
import { MAX_FOLDER_DEPTH } from '../../../extension/core/model.js';
import { FOLDER_ICONS, MAX_FOLDER_IMAGE, isFolderImage } from '../../../extension/core/folder-icons.js';
import { call } from './ipc.js';
import { explicitFolders, folderIconMap, items, ui } from './state.js';
import { field, writable } from './helpers.js';
import { mcpScopeAction } from './agents.js';
import { renderDetail } from './detail.js';
import { dropTarget, endDrag, startDrag } from './dragdrop.js';
import { renderList } from './list.js';
import { contextMenu } from './menus.js';
import { folderList, folderScope, nsFolder } from './modes.js';
import { clearSelection, deleteMany, selectRow } from './multi.js';
import { reloadAll } from './shell.js';
import { syncNewEntryTarget } from './sidebar.js';
import { deleteNotice } from './trash.js';
import { featureAllowed } from './vault-menu.js';

/** Folder view of a container: breadcrumb, subfolders of the current folder, then its entries. */
export function folderRows(container, list, row, rerender) {
  const all = new Set([...folderList(container.id), ...list.map((i) => i.folder).filter(Boolean)]);
  for (const f of [...all]) {
    const parts = f.split('/');
    for (let k = 1; k < parts.length; k++) all.add(parts.slice(0, k).join('/'));
  }
  const cur = all.has(ui.folder) ? ui.folder : '';
  const prefix = cur ? `${cur}/` : '';
  const inside = (f) => list.filter((i) => i.folder === f || (i.folder || '').startsWith(`${f}/`)).length;
  const children = [...all].filter((f) => f.startsWith(prefix) && f !== cur && !f.slice(prefix.length).includes('/')).sort((a, b) => a.localeCompare(b));
  const open = (f) => {
    ui.folder = f;
    rerender();
    syncNewEntryTarget();
  };
  const out = [];
  if (cur) {
    const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
    out.push(h('li', { class: 'folder-crumb', ...dropTarget(parent, container) },
      h('button', { class: 'icon-btn', title: t('Übergeordneter Ordner'), onclick: () => open(parent) }, icon('back', 16)),
      folderGlyph(container.id, cur, 16), h('b', {}, cur.split('/').join(' / '))));
  }
  for (const f of children) {
    const count = inside(f);
    const name = f.slice(prefix.length);
    const dragFolder = writable(container) && featureAllowed(container, 'folders');
    out.push(h('li', { class: `row-item folder-row ${ui.multiFolders.has(f) ? 'multi' : ''}`, dataset: { folder: f },
      // Ctrl/Shift select folders (together with entries); a plain click opens the folder.
      onclick: (e) => {
        if (selectRow(e, `folder:${f}`)) { rerender(); renderDetail(); return; }
        clearSelection();
        ui.anchor = null;
        open(f);
      },
      oncontextmenu: (e) => contextMenu(e, folderActions(container, f, count, open)), ...dropTarget(f, container),
      draggable: dragFolder ? 'true' : false,
      ondragstart: dragFolder ? (e) => {
        if (e.target !== e.currentTarget) return;
        const selected = ui.multiFolders.has(f);
        startDrag(e, container, selected ? [...ui.multi] : [], selected ? [...ui.multiFolders] : [f]);
      } : undefined,
      ondragend: dragFolder ? endDrag : undefined },
      h('span', { class: 'folder-icon' }, folderGlyph(container.id, f, 18)),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, name), h('div', { class: 'row-sub' }, t('{count} Einträge', { count }))),
      !count && writable(container) ? h('button', { class: 'icon-btn', title: t('Leeren Ordner löschen'), onclick: async (e) => {
        e.stopPropagation();
        try {
          await call('removeFolder', container.id, nsFolder(f));
          explicitFolders.set(container.id, await call('folders', container.id));
          rerender();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, icon('trash', 14)) : null));
  }
  out.push(...list.filter((i) => (i.folder || '') === cur).map((i) => () => row(i)));
  if (out.length === (cur ? 1 : 0)) out.push(h('li', { class: 'empty' }, icon('folder', 32), t('Ordner ist leer')));
  return out;
}

/** Functions of a folder (right-click in the list). */
export function folderActions(c, folder, count, open) {
  const canWrite = writable(c) && featureAllowed(c, 'folders');
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  const reloadFolders = async () => {
    explicitFolders.set(c.id, await call('folders', c.id));
    folderIconMap.set(c.id, await call('folderIcons', c.id).catch(() => ({})));
    await reloadAll();
  };
  return [
    { action: 'open-folder', icon: 'folder', label: t('Öffnen'), onClick: () => open(folder) },
    { action: 'folder-icon', icon: 'image', label: t('Symbol ändern …'), disabled: !canWrite, onClick: () => folderIconDialog(c, folder) },
    folder.split('/').length < MAX_FOLDER_DEPTH
      ? { action: 'subfolder', icon: 'folder-plus', label: t('Neuer Unterordner'), disabled: !canWrite, onClick: () => newFolderDialog(c, `${folder}/`) } : null,
    { action: 'rename-folder', icon: 'edit', label: t('Umbenennen'), disabled: !canWrite, onClick: () => renameFolderDialog(c, folder) },
    mcpScopeAction(c.id, folder),
    '-',
    { action: 'delete-folder', icon: 'trash', label: t('Löschen'), danger: true, disabled: !canWrite, onClick: async () => {
      try {
        const inside = items.filter((i) => i.containerId === c.id && (i.folder === folder || (i.folder || '').startsWith(`${folder}/`)));
        if (inside.length) {
          // First the choice (keep the entries, or delete them too), then a second warning for the destructive one.
          const choice = await new Promise((resolve) => {
            modal(t('Ordner löschen'), h('div', {},
              h('p', {}, t('„{folder}“ enthält {count} Einträge (inklusive Unterordner). Was soll mit ihnen passieren?', { folder, count: inside.length })),
              h('p', { class: 'muted small' }, t('„Nur Ordner“ verschiebt die Einträge eine Ebene nach oben ({parent}). „Mit Inhalt“ löscht sie.', { parent: parent || t('Ohne Ordner') }))), [
              { label: t('Abbrechen'), onClick: () => resolve(null) },
              { label: t('Nur Ordner löschen'), onClick: () => resolve('keep') },
              { label: t('Mit Inhalt löschen'), danger: true, onClick: () => resolve('delete') },
            ]);
          });
          if (!choice) return;
          if (choice === 'delete') {
            if (!(await confirmDialog(t('Wirklich alle Einträge löschen?'), `${t('Achtung: {count} Einträge aus „{folder}“ und allen Unterordnern werden gelöscht.', { folder, count: inside.length })} ${await deleteNotice(c)}`, { confirmLabel: t('Ja, {count} Einträge löschen', { count: inside.length }), danger: true }))) return;
            const failed = await deleteMany(inside.map((i) => i.key));
            if (failed) toast(t('{n} Einträge konnten nicht gelöscht werden', { n: failed }), 'error');
          } else {
            const r = await call('renameFolder', c.id, folder, parent, folderScope());
            for (const err of r.errors) toast(err, 'error');
          }
        }
        await call('removeFolder', c.id, nsFolder(folder)).catch(() => {});
        // Subfolders that only existed as empty folders.
        for (const f of folderList(c.id).filter((x) => x.startsWith(`${folder}/`))) await call('removeFolder', c.id, nsFolder(f)).catch(() => {});
        if (ui.folder === folder || ui.folder.startsWith(`${folder}/`)) ui.folder = parent;
        toast(t('Ordner gelöscht'));
        await reloadFolders();
      } catch (e) {
        toast(e.message, 'error');
      }
    } },
  ];
}

/** Symbol of a folder in the list: the chosen one, its own image, or the plain folder. */
function folderGlyph(containerId, folder, size) {
  const value = folderIconMap.get(containerId)?.[nsFolder(folder)];
  if (isFolderImage(value)) return h('img', { class: 'folder-img', src: value, width: size, height: size, alt: '' });
  return icon(value || 'folder', size);
}

function folderIconDialog(c, folder) {
  const current = folderIconMap.get(c.id)?.[nsFolder(folder)] || '';
  const save = async (value) => {
    await call('setFolderIcon', c.id, nsFolder(folder), value);
    folderIconMap.set(c.id, await call('folderIcons', c.id));
    renderList();
  };
  const { close } = modal(t('Symbol für „{folder}“', { folder: folder.split('/').pop() }), h('div', {},
    h('div', { class: 'icon-grid' }, ...FOLDER_ICONS.map((name) => h('button', {
      type: 'button', class: `icon-choice ${(current || 'folder') === name ? 'on' : ''}`, title: name, dataset: { icon: name },
      onclick: async () => {
        try {
          await save(name === 'folder' ? '' : name);
          close();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    }, icon(name, 22)))),
    isFolderImage(current) ? h('p', { class: 'muted small inline' }, h('img', { class: 'folder-img', src: current, width: 22, height: 22, alt: '' }), t('Eigenes Bild')) : null), [
    { label: t('Eigenes Bild …'), onClick: async () => {
      const url = await pickImage({ size: 32, maxChars: MAX_FOLDER_IMAGE });
      if (!url) return false;
      await save(url);
      return true;
    } },
    { label: t('Standard'), onClick: () => save('') },
    { label: t('Schließen') },
  ]);
}

function renameFolderDialog(c, folder) {
  const name = h('input', { value: folder });
  modal(t('Ordner umbenennen'), h('div', {},
    h('p', { class: 'muted' }, t('Unterordner und Einträge werden mit umbenannt. Mit „/“ verschiebst du den Ordner, z. B. Kunden/Alt.')),
    field(t('Ordner'), name)), [
    { label: t('Abbrechen') },
    { label: t('Umbenennen'), primary: true, onClick: async () => {
      const r = await call('renameFolder', c.id, folder, name.value, folderScope());
      for (const err of r.errors) toast(err, 'error');
      const next = name.value.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      if (ui.folder === folder || ui.folder.startsWith(`${folder}/`)) ui.folder = next + ui.folder.slice(folder.length);
      explicitFolders.set(c.id, await call('folders', c.id));
      toast(t('Ordner umbenannt'));
      await reloadAll();
    } },
  ]);
  setTimeout(() => name.select(), 0);
}

export function newFolderDialog(c, prefix) {
  const name = h('input', { placeholder: t('z. B. Kunden/Contoso') });
  if (prefix || ui.folder) name.value = prefix || `${ui.folder}/`;
  modal(t('Neuer Ordner'), h('div', {},
    h('p', { class: 'muted' }, t('Unterordner trennst du mit „/“, z. B. Kunden/Contoso. Einträge verschiebst du über „Bearbeiten“ → Ordner.')),
    field(t('Ordner'), name)), [
    { label: t('Abbrechen') },
    { label: t('Anlegen'), primary: true, onClick: async () => {
      await call('addFolder', c.id, nsFolder(name.value));
      explicitFolders.set(c.id, await call('folders', c.id));
      ui.folder = name.value.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      renderList();
    } },
  ]);
  setTimeout(() => name.focus(), 0);
}
