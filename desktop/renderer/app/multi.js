// Several entries at once (Shift/Ctrl): selection, delete, move.

import { h, icon, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import * as progress from '../progress.js';
import { call } from './ipc.js';
import { panes } from './layout.js';
import { explicitFolders, items, st, ui } from './state.js';
import { field, writable, writableContainers } from './helpers.js';
import { renderDetail, splitKey } from './detail.js';
import { renderList } from './list.js';
import { folderList, modeItems, nsFolder } from './modes.js';
import { reloadAll } from './shell.js';
import { deleteNotice } from './trash.js';
import { cutItems } from './cut-paste.js';

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
    { action: 'multi-cut', icon: 'move', label: t('{n} Einträge ausschneiden', { n: list.length }), disabled: !canWrite, onClick: () => cutItems(list) },
    '-',
    { action: 'multi-delete', icon: 'trash', label: t('{n} Einträge löschen', { n: list.length }), danger: true, disabled: !canWrite, onClick: () => deleteManyDialog(list) },
    '-',
    { action: 'multi-clear', icon: 'x', label: t('Auswahl aufheben'), onClick: () => { clearSelection(); renderList(); renderDetail(); } },
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
      h('button', { type: 'button', class: 'btn', onclick: () => { clearSelection(); renderList(); renderDetail(); } }, t('Auswahl aufheben')))));
  return undefined;
}

/** What went wrong in deleteMany, with the reasons: a person has to know what to do about it (#407). */
export function deleteFailedText(reasons) {
  const shown = [...new Set(reasons)];
  return `${t('{n} Einträge konnten nicht gelöscht werden', { n: reasons.length })}: ${shown.slice(0, 3).join(' ')}${shown.length > 3 ? ' …' : ''}`;
}

/** Deletes entries one by one (recycle bin); → the reason of each failure. */
export async function deleteMany(keys) {
  const failed = [];
  let done = 0;
  const end = progress.begin('deleteMany', t('Einträge werden gelöscht …'));
  try {
    for (const key of keys) {
      const [containerId, id] = splitKey(key);
      try {
        await call('delete', containerId, id);
      } catch (e) {
        failed.push(e.message);
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
  toast(failed.length ? deleteFailedText(failed) : t('{n} Einträge in den Papierkorb verschoben', { n: list.length }), failed.length ? 'error' : undefined);
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

/**
 * #462: the plan of one entry for another vault, with the question when it takes linked assets along (or cannot move).
 * → null (stop: refused or declined, the reason was shown) or { ids, extras } – the entry alone has no extras.
 */
async function askMovePlan(i, targetId) {
  let plan;
  try {
    plan = await call('planMove', i.containerId, targetId, i.id);
  } catch (e) {
    toast(`${i.title}: ${e.message}`, 'error');
    return null;
  }
  if (plan.refused) {
    toast(`${i.title}: ${plan.refused}`, 'error');
    return null;
  }
  const extras = plan.members.filter((m) => m.role !== 'selected');
  if (!extras.length && !plan.blocked.length) return { extras: [], expected: null };
  const text = [
    extras.length ? t('Diese verknüpften Einträge werden mitverschoben: {list}.', { list: extras.map((m) => m.title).join(', ') }) : '',
    plan.blocked.length ? t('Diese verknüpften Einträge werden nicht verschoben: {list}.', { list: plan.blocked.map((b) => `${b.title} (${b.reason})`).join('; ') }) : '',
    t('Alles oder nichts: Schlägt ein Eintrag fehl, bleibt im Quelltresor alles unverändert.'),
  ].filter(Boolean).join(' ');
  if (!(await confirmDialog(t('„{title}“ mit verknüpften Assets verschieben?', { title: i.title }), text, { confirmLabel: extras.length ? t('Alle verschieben') : t('Verschieben') }))) return null;
  return { extras, expected: plan.members.map((m) => m.id) };
}

/** Moves entries into another vault (each is re-created there and deleted in the source); returns the failures. */
export async function moveItemsTo(list, targetId, folderOf = null) {
  let moved = 0;
  let failed = 0;
  let last = null;
  let dropped = null;
  const gone = new Set(); // entries that went along with an earlier one
  for (const i of list) {
    if (i.containerId === targetId || gone.has(i.id)) continue;
    try {
      const ask = await askMovePlan(i, targetId);
      if (!ask) { failed++; continue; }
      if (ask.expected) {
        const res = await call('moveWithAssets', i.containerId, targetId, i.id, { expected: ask.expected, ...(folderOf ? { folder: folderOf(i) } : {}) });
        for (const m of ask.expected) gone.add(m);
        last = res.saved;
        moved += res.moved?.length || 1;
        if (res.dropped?.length) dropped = res.saved;
      } else {
        last = await call('move', i.containerId, targetId, i.id, folderOf ? { folder: folderOf(i) } : undefined);
        moved++;
        if (last.droppedLinks?.length) dropped = last;
      }
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
