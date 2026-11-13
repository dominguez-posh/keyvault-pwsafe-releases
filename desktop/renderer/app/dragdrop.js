// Drag and drop: entries, folders and passkeys onto folders and vaults, order of the vaults.

import { toast, confirmDialog } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { MAX_FOLDER_DEPTH } from '../../../extension/core/model.js';
import { ROOT_ONLY } from '../../../extension/core/private.js';
import { call } from './ipc.js';
import { explicitFolders, items, st, ui } from './state.js';
import { writable } from './helpers.js';
import { renderDetail, splitKey } from './detail.js';
import { conflictDialog } from './item-actions.js';
import { renderList } from './list.js';
import { folderList, folderScope, modeItems } from './modes.js';
import { clearSelection, moveFolderTo, moveItemsTo, moveManyToFolder } from './multi.js';
import { reloadAll } from './shell.js';
import { renderSidebar } from './sidebar.js';
import { featureAllowed } from './vault-menu.js';

const DRAG_TYPE = 'application/x-kvpwsafe-item';
const DRAG_FOLDER = 'application/x-kvpwsafe-folder';
export const DRAG_VAULT = 'application/x-kvpwsafe-vault';
export const DRAG_PASSKEY = 'application/x-kvpwsafe-passkey';
export let draggedPasskey = null; // { from: entry key, credentialId } while a passkey is dragged
export let draggedVault = null; // container id while a vault row is dragged
// What is being dragged right now (dataTransfer can only be read on drop; the vault rows decide earlier whether they accept).
let draggedKeys = [];
let draggedFolder = null; // { containerId, folders: [...] } while folders are dragged (alone or with entries)

/** Starts dragging entries (keys) and folders of container c; either list may be empty. */
export function startDrag(e, c, keys, folders) {
  if (keys.length) e.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
  if (folders.length) e.dataTransfer.setData(DRAG_FOLDER, [c.id, ...folders].join('\n'));
  e.dataTransfer.effectAllowed = 'move';
  draggedKeys = keys;
  draggedFolder = folders.length ? { containerId: c.id, folders } : null;
}

export function endDrag() {
  draggedKeys = [];
  draggedFolder = null;
  clearDropMarks();
}

// #491: how a drop target shows itself while something is dragged over it. "ok": accent frame, slight lift and the
// label "Hierher verschieben"; "blocked": muted red frame with the reason (shown under the row, as a tooltip too –
// Chromium shows no tooltips during a drag). Only the look: whether a drop is taken stays with the rules below.
const MARKS = ['drop', 'drop-blocked', 'drop-before', 'drop-after'];
function clearMark(el) {
  if (el.classList.contains('drop-blocked')) el.removeAttribute('title');
  el.classList.remove(...MARKS);
  delete el.dataset.dropLabel;
}
/** Removes every drop mark (the drag ended somewhere else, e.g. outside the window). */
export function clearDropMarks() {
  document.querySelectorAll(MARKS.map((m) => `.${m}`).join(',')).forEach(clearMark);
}
function mark(el, blocked, label) {
  const cls = blocked ? 'drop-blocked' : 'drop';
  if (el.classList.contains(cls) && el.dataset.dropLabel === label) return; // dragover fires many times a second
  clearMark(el);
  el.classList.add(cls);
  el.dataset.dropLabel = label;
  if (blocked) el.title = label;
}
/** Short feedback right after a drop (a pulse of the row; without motion under prefers-reduced-motion). */
function pulse(el) {
  el.classList.remove('drop-done');
  void el.offsetWidth; // restarts the animation
  el.classList.add('drop-done');
  setTimeout(() => el.classList.remove('drop-done'), 700);
}

/** Why the dragged entries (or folder) may not go into vault c – null when that is no target at all (their own vault). */
function vaultBlockReason(c, keys, folder) {
  const own = folder ? folder.containerId === c.id : keys.every((k) => splitKey(k)[0] === c.id);
  if (own || (!folder && !keys.length)) return null;
  if (c.locked) return t('Tresor ist gesperrt');
  if (c.error) return t('Tresor nicht erreichbar');
  if (!writable(c)) return t('Kein Schreibrecht in diesem Tresor');
  if (folder && !featureAllowed(c, 'folders')) return t('Ordner sind in diesem Tresor nicht freigeschaltet');
  if (c.personal) return t('Einträge aus geteilten Tresoren lassen sich nicht in den persönlichen Tresor verschieben');
  return null;
}

/** "Nur für mich" entries live only in the root folder (#476): a subfolder is no target for them. */
const privateBlockReason = (keys, folder) => (folder && keys.some((k) => items.find((i) => i.key === k)?.privateOwner) ? ROOT_ONLY() : null);

/** What a drop carries: entry keys and { containerId, folders } (or null). */
function dropped(e) {
  const keys = e.dataTransfer.types.includes(DRAG_TYPE) ? e.dataTransfer.getData(DRAG_TYPE).split('\n').filter(Boolean) : [];
  const [containerId, ...folders] = e.dataTransfer.types.includes(DRAG_FOLDER) ? e.dataTransfer.getData(DRAG_FOLDER).split('\n').filter(Boolean) : [];
  endDrag();
  return { keys, folder: containerId && folders.length ? { containerId, folders } : null };
}

/** Entries that travel inside one of the dragged folders anyway (they keep their place in it). */
const outsideFolders = (keys, folder) => keys.filter((k) => {
  const i = items.find((x) => x.key === k);
  const at = i?.folder || '';
  return !folder || !folder.folders.some((f) => at === f || at.startsWith(`${f}/`));
});

/** Whether the dragged entries (or folder) may go into vault c: writable, from another vault, nothing shared into the personal one. */
function vaultAccepts(c, keys, folder = null) {
  if (folder) {
    if (!writable(c) || !featureAllowed(c, 'folders') || folder.containerId === c.id) return false;
    if (c.personal && !st.containers.find((x) => x.id === folder.containerId)?.personal) return false;
    // Entries dragged along with the folders must fit as well.
    return !keys.length || vaultAccepts(c, keys);
  }
  if (!keys.length || !writable(c)) return false;
  const sources = keys.map((k) => splitKey(k)[0]);
  if (sources.every((id) => id === c.id)) return false;
  return !(c.personal && sources.some((id) => !st.containers.find((x) => x.id === id)?.personal));
}

/** Sidebar vault row as drop target: moves the dragged entries into that vault after a short confirmation. */
/** Sidebar order: the ids in the setting first (in that order), the rest after them as they come. */
export function orderedVaults(list) {
  const order = st.settings.containerOrder || [];
  const rank = (c, i) => { const k = order.indexOf(c.id); return k < 0 ? order.length + i : k; };
  return list.map((c, i) => [c, rank(c, i)]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/** A vault dropped onto another one: before it (upper half) or after it (lower half); remembered in the settings. */
async function reorderVault(id, targetId, after) {
  const ids = orderedVaults(st.containers.filter((c) => !c.personal)).map((c) => c.id).filter((x) => x !== id);
  const at = ids.indexOf(targetId);
  if (at < 0) return;
  ids.splice(after ? at + 1 : at, 0, id);
  const settings = await call('updateSettings', { containerOrder: ids }); // #535: assigned after the wait
  st.settings = settings;
  renderSidebar();
}

export function vaultDropTarget(c) {
  const half = (e) => e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2;
  return {
    ondragover: (e) => {
      // Reordering: another vault (not the personal one) is dragged over this row.
      if (e.dataTransfer.types.includes(DRAG_VAULT)) {
        if (c.personal || !draggedVault || draggedVault === c.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.toggle('drop-after', half(e));
        e.currentTarget.classList.toggle('drop-before', !half(e));
        return;
      }
      const types = e.dataTransfer.types;
      const withFolder = types.includes(DRAG_FOLDER);
      if (!withFolder && !types.includes(DRAG_TYPE)) return;
      const ok = withFolder ? vaultAccepts(c, draggedKeys, draggedFolder) : vaultAccepts(c, draggedKeys);
      if (!ok) {
        const why = vaultBlockReason(c, draggedKeys, withFolder ? draggedFolder : null);
        if (why) mark(e.currentTarget, true, why);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(e.currentTarget, false, t('Hierher verschieben'));
    },
    ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) clearMark(e.currentTarget); },
    ondrop: async (e) => {
      e.preventDefault();
      const after = half(e);
      const accepted = e.currentTarget.classList.contains('drop');
      clearMark(e.currentTarget);
      if (accepted) pulse(e.currentTarget);
      if (e.dataTransfer.types.includes(DRAG_VAULT)) {
        const id = e.dataTransfer.getData(DRAG_VAULT);
        draggedVault = null;
        if (id && id !== c.id && !c.personal) await reorderVault(id, c.id, after);
        return;
      }
      const { keys: all, folder } = dropped(e);
      if (folder) {
        if (!vaultAccepts(c, all, folder)) return;
        const rest = outsideFolders(all, folder).map((k) => items.find((i) => i.key === k)).filter(Boolean);
        if (folder.folders.length === 1 && !rest.length) {
          await moveFolderTo(folder.containerId, folder.folders[0], c);
          return;
        }
        // Several folders (and entries): one question for all of them.
        if (!(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: c.name }),
          t('{folders} Ordner (mit Unterordnern) und {n} Einträge nach „{vault}“ verschieben? Danach sehen alle mit Zugriff auf „{vault}“ die Einträge. Sie werden im Ziel neu angelegt und in der Quelle gelöscht.', { folders: folder.folders.length, n: rest.length, vault: c.name }),
          { confirmLabel: t('Verschieben') }))) return;
        for (const f of folder.folders) await moveFolderTo(folder.containerId, f, c, { confirmed: true });
        if (rest.length) await moveItemsTo(rest, c.id);
        clearSelection();
        await reloadAll();
        return;
      }
      const keys = all;
      if (!vaultAccepts(c, keys)) return;
      const list = keys.map((k) => items.find((i) => i.key === k)).filter(Boolean).filter((i) => i.containerId !== c.id);
      if (!list.length) return;
      const what = list.length === 1 ? `„${list[0].title}“` : t('{n} Einträge', { n: list.length });
      if (!(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: c.name }),
        t('{what} nach „{vault}“ verschieben? Danach sehen ihn alle mit Zugriff auf „{vault}“. Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht.', { what, vault: c.name }),
        { confirmLabel: t('Verschieben') }))) return;
      await moveItemsTo(list, c.id);
    },
  };
}

/**
 * Drag & drop target "folder" (a folder row, or the bar of the parent folder): takes dragged entries – and a dragged
 * folder of the same vault, which moves in with its subfolders and entries (never into itself or a subfolder of it).
 */
export function dropTarget(folder, container = null) {
  // Folders go in only within their vault, never into themselves or a subfolder of theirs; one that already lies
  // directly in the target stays where it is (and does not block the others).
  const oneFits = (f) => f !== folder && !folder.startsWith(`${f}/`);
  const folderFits = (src) => !!src && !!container && src.containerId === container.id && src.folders.every(oneFits)
    && src.folders.some((f) => parentOf(f) !== folder);
  return {
    ondragover: (e) => {
      const types = e.dataTransfer.types;
      if (types.includes(DRAG_FOLDER)) {
        if (!folderFits(draggedFolder)) {
          // Into a subfolder of its own: say why; its own row and the folder it already lies in stay quiet.
          const inside = draggedFolder?.containerId === container?.id && draggedFolder.folders.some((f) => folder.startsWith(`${f}/`));
          if (inside) mark(e.currentTarget, true, t('Ein Ordner kann nicht in sich selbst verschoben werden'));
          return;
        }
      } else if (!types.includes(DRAG_TYPE)) return;
      else {
        const why = privateBlockReason(draggedKeys, folder);
        if (why) { mark(e.currentTarget, true, why); return; }
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(e.currentTarget, false, t('Hierher verschieben'));
    },
    ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) clearMark(e.currentTarget); },
    ondrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const accepted = e.currentTarget.classList.contains('drop');
      clearMark(e.currentTarget);
      if (accepted) pulse(e.currentTarget);
      const { keys: all, folder: src } = dropped(e);
      if (src) {
        if (!folderFits(src)) return;
        moveSelectionInto(container, src.folders, outsideFolders(all, src), folder);
        return;
      }
      if (all.length > 1) moveManyToFolder(all, folder);
      else if (all[0]) moveToFolder(all[0], folder);
    },
  };
}

const parentOf = (folder) => (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '');

/** Folders and entries dragged together into folder target of the same vault: the folders first, then the entries. */
async function moveSelectionInto(c, folders, keys, target) {
  for (const f of folders) if (parentOf(f) !== target) await moveFolderInto(c, f, target);
  if (keys.length) await moveManyToFolder(keys, target);
  clearSelection();
  renderList();
  renderDetail();
}

/** Moves folder src (with subfolders and entries) into target ('' = top level) of the same vault. */
async function moveFolderInto(c, src, target) {
  const name = src.split('/').pop();
  const next = target ? `${target}/${name}` : name;
  if (next === src) return;
  // The deepest subfolder must stay within MAX_FOLDER_DEPTH levels.
  const depth = (f) => f.split('/').filter(Boolean).length;
  const inside = [...modeItems(c.id).map((i) => i.folder || ''), ...folderList(c.id)]
    .filter((f) => f === src || f.startsWith(`${src}/`));
  const deepest = Math.max(depth(src), ...inside.map(depth));
  if (depth(next) + deepest - depth(src) > MAX_FOLDER_DEPTH) {
    toast(t('Dort wären es mehr als {n} Ordnerebenen', { n: MAX_FOLDER_DEPTH }), 'error');
    return;
  }
  try {
    const r = await call('renameFolder', c.id, src, next, folderScope());
    for (const err of r.errors) toast(err, 'error');
    if (ui.folder === src || ui.folder.startsWith(`${src}/`)) ui.folder = next + ui.folder.slice(src.length);
    explicitFolders.set(c.id, await call('folders', c.id));
    toast(t('Ordner „{name}“ verschoben', { name }));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function moveToFolder(key, folder) {
  const [containerId, id] = splitKey(key);
  try {
    const item = await call('item', containerId, id);
    if ((item.folder || '') === folder) return;
    let saved;
    try {
      saved = await call('save', containerId, { ...item, folder }, item.version);
    } catch (e) {
      if (e.name !== 'ConflictError') throw e;
      saved = await conflictDialog(containerId, item, { ...item, folder });
      if (!saved) return;
    }
    toast(t('„{title}“ verschoben nach {folder}', { title: item.title, folder: folder || t('Ohne Ordner') }));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setDraggedVault(value) { draggedVault = value; if (value === null) clearDropMarks(); return value; }
export function setDraggedPasskey(value) { draggedPasskey = value; return value; }
