// Keyboard shortcuts of the window.

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st, ui } from './state.js';
import { newItem, renderDetail, splitKey } from './detail.js';
import { helpDialog } from './help.js';
import { renderList } from './list.js';
import { stepZoom } from './main-menu.js';
import { deviceMode } from './modes.js';
import { clearSelection, deleteManyDialog, multiItems, selectionSize } from './multi.js';

/**
 * Strg+Umschalt+U / P / O: types user name, password or current one-time code of the selected entry into the
 * previous window (the app minimizes itself first). Typing instead of pasting also works where pasting is blocked.
 */
async function typeSelected(what) {
  if (!ui.selected) return toast(t('Zuerst einen Eintrag auswählen'), 'error');
  try {
    const [containerId, id] = splitKey(ui.selected);
    return await call('autoType', containerId, id, what);
  } catch (e) {
    return toast(e.message, 'error');
  }
}

// Zoom: Ctrl + / Ctrl − / Ctrl 0 (also Ctrl with the number pad keys), everywhere in the window.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || !st) return;
  const key = e.key;
  const dir = key === '+' || key === '=' || e.code === 'NumpadAdd' ? 1 : key === '-' || e.code === 'NumpadSubtract' ? -1 : key === '0' || e.code === 'Numpad0' ? 0 : null;
  if (dir === null) return;
  e.preventDefault();
  stepZoom(dir);
});

document.addEventListener('keydown', (e) => {
  if (!st?.opened || document.querySelector('dialog[open]')) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    document.getElementById('search')?.focus();
  } else if (e.key === 'F1') {
    e.preventDefault();
    helpDialog();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (deviceMode()) newItem('server', { type: 'server', server: { kind: 'windows' } });
    else newItem('login');
  } else if (e.ctrlKey && e.shiftKey && ['u', 'p', 'o'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    typeSelected(e.key.toLowerCase());
  } else if (e.key === 'Escape' && ui.editing) {
    ui.editing = null;
    renderDetail();
  } else if (e.key === 'Escape' && selectionSize()) {
    clearSelection();
    renderList();
    renderDetail();
  } else if (e.key === 'Delete' && ui.multi.size > 1 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    deleteManyDialog(multiItems());
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    for (const el of document.querySelectorAll('.list li.row-item[data-key]')) ui.multi.add(el.dataset.key);
    renderList();
    renderDetail();
  }
});
