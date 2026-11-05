// Several entries at once (Shift/Ctrl): selection, delete, move.

import { h, icon, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import * as progress from '../progress.js';
import { call } from './ipc.js';
import { panes } from './layout.js';
import { explicitFolders, items, st, ui } from './state.js';
import { field, writable, writableContainers } from './helpers.js';
import { renderDetail, splitKey } from './detail.js';
import { folderList, modeItems, nsFolder } from './modes.js';
import { reloadAll } from './shell.js';
import { deleteNotice } from './trash.js';

/** Clears the selection of entries and folders. */
export function clearSelection() {
  ui.multi.clear();
  ui.multiFolders.clear();
}

/** Entries and folders selected together. */
export const selectionSize = () => ui.multi.size + ui.multiFolders.size;

/**
 * Ctrl/Shift on a row of the list (entry or folder). token: "key:<entry key>" or "folder:<path>". Shift selects the
 * range from the last clicked row, Ctrl toggles one row; folders and entries mix freely. Returns false for a plain click.
 */
export function selectRow(e, token) {
  const add = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.add(tk.slice(7)) : ui.multi.add(tk.slice(4)));
  const has = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.has(tk.slice(7)) : ui.multi.has(tk.slice(4)));
  const drop = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.delete(tk.slice(7)) : ui.multi.delete(tk.slice(4)));
  const anchor = ui.anchor || (ui.selected ? `key:${ui.selected}` : null);
  if (e.shiftKey && anchor) {
    const order = [...document.querySelectorAll('.list li.row-item')].map((el) => (el.dataset.key ? `key:${el.dataset.key}` : el.dataset.folder != null ? `folder:${el.dataset.folder}` : null)).filter(Boolean);
    const a = order.indexOf(anchor);
    const b = order.indexOf(token);
    if (a >= 0 && b >= 0) {
      add(anchor);
      for (const tk of order.slice(Math.min(a, b), Math.max(a, b) + 1)) add(tk);
      return true;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    if (!selectionSize() && anchor && anchor !== token) add(anchor);
    if (has(token)) drop(token);
    else add(token);
    ui.anchor = token;
    return true;
  }
  return false;
}

const multiKeys = () => [...ui.multi].filter((k) => items.some((i) => i.key === k));
export const multiItems = () => multiKeys().map((k) => items.find((i) => i.key === k));

/** Context menu for a selection of several entries. */
export function multiActions() {
  const list = multiItems();
  const containerIds = [...new Set(list.map((i) => i.containerId))];
  const oneVault = containerIds.length === 1;
  const canWrite = list.every((i) => writable(st.containers.find((c) => c.id === i.containerId) || {}));
  return [
    { action: 'multi-folder', icon: 'folder', label: t('{n} Einträge in Ordner verschieben …', { n: list.length }), disabled: !oneVault || !canWrite, onClick: () => folderPickDialog(containerIds[0], list.map((i) => i.key)) },
    { action: 'multi-move', icon: 'move', label: t('{n} Einträge in anderen Tresor verschieben …', { n: list.length }), disabled: !canWrite, onClick: () => moveManyDialog(list) },
    '-',
    { action: 'multi-delete', icon: 'trash', label: t('{n} Einträge löschen', { n: list.length }), danger: true, disabled: !canWrite, onClick: () => deleteManyDialog(list) },
    '-',
    { action: 'multi-clear', icon: 'x', label: t('Auswahl aufheben'), onClick: () => { clearSelection(); renderRows(); renderDetail(); } },
  ];
}

export function renderMultiSelection() {
  const list = multiItems();
  const folders = [...ui.multiFolders].sort((a, b) => a.localeCompare(b));
  // With folders in the selection the buttons act on the entries only – dragging moves everything.
  const actions = list.length ? multiActions().filter((a) => a !== '-' && a.action !== 'multi-clear') : [];
  const lines = [...folders.map((f) => h('li', { class: 'multi-folder' }, icon('folder', 13), f.split('/').pop())), ...list.map((i) => h('li', {}, i.title))];
  panes.detail.replaceChildren(h('div', { class: 'placeholder multi-selection' }, icon('check', 40),
    h('h2', {}, folders.length ? t('{folders} Ordner und {n} Einträge ausgewählt', { folders: folders.length, n: list.length }) : t('{n} Einträge ausgewählt', { n: list.length })),
    h('p', { class: 'muted small' }, t('Shift+Klick wählt einen Bereich, Strg+Klick einzelne Einträge und Ordner. Ziehen verschiebt alles in einen Ordner oder Tresor.')),
    h('ul', { class: 'multi-list' }, ...lines.slice(0, 12), lines.length > 12 ? h('li', { class: 'muted' }, `… +${lines.length - 12}`) : null),
    h('div', { class: 'actions' }, ...actions.map((a) => h('button', { type: 'button', class: a.danger ? 'btn danger' : 'btn', disabled: a.disabled, onclick: a.onClick }, icon(a.icon), a.label)),
      h('button', { type: 'button', class: 'btn', onclick: () => { clearSelection(); renderRows(); renderDetail(); } }, t('Auswahl aufheben')))));
  return undefined;
}

/** Deletes entries one by one (recycle bin); → number of failures. */
export async function deleteMany(keys) {
  let failed = 0;
  let done = 0;
  const end = progress.begin('deleteMany', t('Einträge werden gelöscht …'));
  try {
    for (const key of keys) {
      const [containerId, id] = splitKey(key);
      try {
        await call('delete', containerId, id);
      } catch {
        failed++;
      }
      ui.multi.delete(key);
      if (ui.selected === key) ui.selected = null;
      progress.set('deleteMany', ++done, keys.length);
    }
  } finally {
    end();
  }
  return failed;
}

export async function deleteManyDialog(list) {
  const notices = [...new Set(await Promise.all([...new Set(list.map((i) => i.containerId))].map((id) => deleteNotice(st.containers.find((x) => x.id === id)))))];
  if (!(await confirmDialog(t('Einträge löschen'), `${t('{n} Einträge löschen?', { n: list.length })} ${notices.join(' ')}`, { confirmLabel: t('Löschen'), danger: true }))) return;
  const failed = await deleteMany(list.map((i) => i.key));
  toast(failed ? t('{n} Einträge konnten nicht gelöscht werden', { n: failed }) : t('{n} Einträge in den Papierkorb verschoben', { n: list.length }), failed ? 'error' : undefined);
  await reloadAll();
}

export async function moveManyToFolder(keys, folder) {
  let moved = 0;
  let done = 0;
  const end = progress.begin('moveMany', t('Einträge werden verschoben …'));
  try {
    for (const key of keys) {
      progress.set('moveMany', ++done, keys.length);
      const item = items.find((i) => i.key === key);
      if (!item || (item.folder || '') === folder) continue;
      try {
        const [containerId, id] = splitKey(key);
        const full = await call('item', containerId, id);
        await call('save', containerId, { ...full, folder }, full.version);
        moved++;
      } catch (e) {
        toast(`${item.title}: ${e.message}`, 'error');
      }
    }
  } finally {
    end();
  }
  if (moved) toast(t('{n} Einträge verschoben nach {folder}', { n: moved, folder: folder || t('Ohne Ordner') }));
  await reloadAll();
}

/** Picks a folder of the vault (existing ones, or a new path) for several entries. */
function folderPickDialog(containerId, keys) {
  const known = [...new Set([...folderList(containerId), ...modeItems(containerId).map((i) => i.folder).filter(Boolean)])].sort();
  const input = h('input', { list: 'folder-pick-options', placeholder: t('optional, z. B. Kunden/Contoso'), value: ui.containerId === containerId ? ui.folder : '' });
  const options = h('datalist', { id: 'folder-pick-options' }, h('option', { value: '' }), ...known.map((f) => h('option', { value: f })));
  modal(t('In Ordner verschieben'), h('div', {}, field(t('{n} Einträge verschieben nach', { n: keys.length }), h('div', {}, input, options)),
    h('p', { class: 'muted small' }, t('Leer lassen für „Ohne Ordner“. Ein neuer Pfad legt den Ordner an.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: () => moveManyToFolder(keys, input.value.split('/').map((x) => x.trim()).filter(Boolean).join('/')) },
  ]);
  setTimeout(() => input.focus(), 0);
}

function moveManyDialog(list) {
  // The personal vault is a target only when every selected entry already comes from it.
  const fromShared = list.some((i) => !st.containers.find((x) => x.id === i.containerId)?.personal);
  const targets = writableContainers().filter((c) => !list.every((i) => i.containerId === c.id) && !(c.personal && fromShared));
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Einträge verschieben'), h('div', {},
    field(t('{n} Einträge verschieben nach', { n: list.length }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht. Der bisherige Verlauf bleibt bis zum Ende der Aufbewahrungsfrist in der Quelle.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: () => moveItemsTo(list, target.value) },
  ]);
}

/**
 * A folder with everything in it into another vault: it lands there under its own name at the top level
 * ("Kunden/Contoso" → "Contoso", subfolders along); an existing folder of that name is merged. The source folder is
 * removed once every entry arrived.
 */
export async function moveFolderTo(sourceId, folder, target, { confirmed = false } = {}) {
  const source = st.containers.find((c) => c.id === sourceId);
  const name = folder.split('/').pop();
  const inside = (f) => f === folder || f.startsWith(`${folder}/`);
  const map = (f) => name + f.slice(folder.length);
  const list = modeItems(sourceId).filter((i) => inside(i.folder || ''));
  if (!confirmed && !(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: target.name }),
    t('Ordner „{folder}“ ({n} Einträge, mit Unterordnern) nach „{vault}“ verschieben? Danach sehen alle mit Zugriff auf „{vault}“ die Einträge. Sie werden im Ziel neu angelegt und in der Quelle gelöscht; gibt es dort schon einen Ordner „{folder}“, landet alles darin.', { folder: name, n: list.length, vault: target.name }),
    { confirmLabel: t('Verschieben') }))) return;
  try {
    // Empty subfolders too (folders without entries exist only in the folder list).
    explicitFolders.set(sourceId, await call('folders', sourceId));
    const explicit = folderList(sourceId).filter(inside);
    for (const f of [folder, ...explicit]) await call('addFolder', target.id, nsFolder(map(f))).catch(() => {});
    const failed = await moveItemsTo(list, target.id, (i) => map(i.folder));
    if (!failed) await call('removeFolder', sourceId, nsFolder(folder)).catch(() => {});
    explicitFolders.delete(sourceId);
    explicitFolders.delete(target.id);
    if (ui.containerId === sourceId && inside(ui.folder || '')) ui.folder = '';
    if (!failed) toast(t('„{folder}“ nach „{vault}“ verschoben', { folder: name, vault: target.name }));
    await reloadAll();
  } catch (e) {
    toast(`${source?.name || ''}: ${e.message}`, 'error');
  }
}

/** #328: an asset moved to another vault leaves its linked accounts behind – they have to be chosen again there. */
export function droppedLinksText(saved) {
  return t('„{title}“ verschoben – verknüpfte Konten bleiben im alten Tresor. Im Asset neu auswählen.', { title: saved.title });
}

/** Moves entries into another vault one by one (each is re-created there and deleted in the source); returns the failures. */
export async function moveItemsTo(list, targetId, folderOf = null) {
  let moved = 0;
  let failed = 0;
  let last = null;
  let dropped = null;
  for (const i of list) {
    if (i.containerId === targetId) continue;
    try {
      last = await call('move', i.containerId, targetId, i.id, folderOf ? { folder: folderOf(i) } : undefined);
      moved++;
      if (last.droppedLinks?.length) dropped = last;
    } catch (e) {
      failed++;
      toast(`${i.title}: ${e.message}`, 'error');
    }
  }
  clearSelection();
  ui.selected = list.length === 1 && last ? last.key : null;
  if (dropped) toast(droppedLinksText(dropped));
  else if (moved && !folderOf) toast(moved === 1 ? t('Verschoben') : t('{n} Einträge verschoben', { n: moved }));
  if (!folderOf) await reloadAll();
  return failed;
}
