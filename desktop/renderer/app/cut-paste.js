// #467: Ctrl+X marks entries for moving, Ctrl+V (or "Paste" in the context menu) moves them to the open vault or folder.
// Nothing goes to the system clipboard: only the keys of the entries are kept here, in the window. The move itself runs
// through the same way as dragging (plan with the question about linked assets, then move / moveWithAssets).

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { items, st, ui } from './state.js';
import { writable } from './helpers.js';
import { renderDetail } from './detail.js';
import { renderList } from './list.js';
import { clearSelection, moveItemsTo, moveManyToFolder, multiItems, selectionSize } from './multi.js';
import { reloadAll } from './shell.js';

let marked = []; // keys of the entries marked for moving

export const cutCount = () => marked.length;
export const isCut = (key) => marked.includes(key);

/** Forgets the mark (Esc, after pasting, when locking). */
export function clearCut() {
  if (!marked.length) return;
  marked = [];
  renderList();
}

/** The entries a cut acts on: the selection when it holds several, else the entry of the right-click or the open one. */
const targetsOf = (list) => (list?.length ? list : selectionSize() ? multiItems() : items.filter((i) => i.key === ui.selected)).filter(Boolean);

/** Marks entries for moving; entries in a vault without the write right are left out (a move deletes in the source). */
export function cutItems(list) {
  const mine = targetsOf(list).filter((i) => writable(st.containers.find((c) => c.id === i.containerId) || {}));
  if (!mine.length) {
    toast(t('Zuerst einen Eintrag auswählen, den du ändern darfst'), 'error');
    return false;
  }
  marked = mine.map((i) => i.key);
  renderList();
  toast(mine.length === 1 ? t('„{title}“ zum Verschieben vorgemerkt', { title: mine[0].title }) : t('{n} Einträge zum Verschieben vorgemerkt', { n: mine.length }));
  return true;
}

/**
 * Moves the marked entries into `containerId` (and `folder` when given). Same vault: only the folder changes; other
 * vault: with the plan question for linked assets. The mark is cleared afterwards, even when something failed.
 */
export async function pasteInto({ containerId, folder = null }) {
  const list = marked.map((k) => items.find((i) => i.key === k)).filter(Boolean);
  const target = st.containers.find((c) => c.id === containerId);
  if (!list.length) {
    marked = [];
    return toast(t('Nichts zum Einfügen vorgemerkt'), 'error');
  }
  if (!target || !writable(target)) return toast(t('Im Tresor „{vault}“ fehlt das Schreibrecht', { vault: target?.name || '' }), 'error');
  marked = [];
  const same = list.filter((i) => i.containerId === containerId);
  const other = list.filter((i) => i.containerId !== containerId);
  if (same.length) await moveManyToFolder(same.map((i) => i.key), folder ?? '');
  if (other.length) {
    const failed = await moveItemsTo(other, containerId, folder === null ? null : () => folder);
    if (folder !== null) {
      if (!failed) toast(other.length === 1 ? t('Verschoben') : t('{n} Einträge verschoben', { n: other.length }));
      await reloadAll();
    }
  }
  clearSelection();
  renderList();
  return renderDetail();
}

/** Where Ctrl+V pastes: the vault and folder that is open; null when the list shows all vaults. */
export function pasteTarget() {
  return ui.containerId ? { containerId: ui.containerId, folder: ui.folder || '' } : null;
}

/** Context menu entry "Cut" for entries (null list = the selection). */
export const cutAction = (list) => ({ action: 'cut', icon: 'move', label: t('Ausschneiden'), onClick: () => cutItems(list) });

/** Context menu entry "Paste" – only when entries are marked; names their number. `where`: { containerId, folder? }. */
export function pasteAction(where) {
  if (!marked.length) return null;
  const c = st.containers.find((x) => x.id === where.containerId);
  return {
    action: 'paste', icon: 'move', disabled: !c || !writable(c),
    label: marked.length === 1 ? t('1 Eintrag einfügen') : t('{n} Einträge einfügen', { n: marked.length }),
    onClick: () => pasteInto(where),
  };
}
