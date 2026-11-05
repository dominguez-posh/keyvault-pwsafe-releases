// The frame of the window: the three panes (sidebar, list, details) with their splitters, the top bar and the
// drag strip of the frameless window.

import { h } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';

export const root = document.getElementById('app');
// Windows: the window has no title bar (desktop/main.js) – a drag strip at the top and room for the window buttons.
if (/Win/.test(navigator.platform)) document.documentElement.classList.add('frameless');
document.body.prepend(h('div', { class: 'drag-strip', 'aria-hidden': 'true' }));
// Search field in the top bar (above list and details); renderList puts the current view's field into it.
export const topSearch = h('div', { class: 'top-search' });
// "New" in the top bar, at the content edge of the detail column.
export const topActions = h('div', { class: 'top-actions' });
// Window buttons (drawn by Windows) are dimmed with the page while a dialog is open.
if (/Win/.test(navigator.platform)) {
  let dimmed = false;
  new MutationObserver(() => {
    const now = !!document.querySelector('dialog.modal[open]');
    if (now === dimmed) return;
    dimmed = now;
    window.pwsafe.invoke('titleBarDim', [now]).catch?.(() => {});
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
}
export const panes = { sidebar: h('aside', { class: 'sidebar' }), list: h('section', { class: 'list-pane' }), detail: h('section', { class: 'detail-pane' }) };

// Default split: the list is the widest column (about half the window), the detail beside it.
// list: null = proportional (55 % of the width beside the sidebar) until the user drags it.
const PANE_DEFAULTS = { sidebar: 300, list: null };
// The sidebar never gets narrower than its head needs (logo, "Keevault for Admins", lock and menu button).
// The sidebar keeps room for longer vault names next to their marks (#19) – it is never dragged narrower than 280 px.
const PANE_LIMITS = { sidebar: [280, 420], list: [260, 960] };
const DETAIL_MIN = 340;

function paneWidths() {
  try {
    return { ...PANE_DEFAULTS, ...JSON.parse(localStorage.getItem('paneWidths') || '{}') };
  } catch {
    return { ...PANE_DEFAULTS };
  }
}

/** Two drag handles between sidebar, list and detail; widths are remembered, double-click restores the default. */
export function setupSplitters(shell) {
  const widths = paneWidths();
  const apply = () => {
    // Keep room for the detail pane when the window is narrow.
    const room = Math.max(0, shell.clientWidth - DETAIL_MIN);
    const sidebar = Math.min(Math.max(widths.sidebar, PANE_LIMITS.sidebar[0]), PANE_LIMITS.sidebar[1]);
    const wanted = widths.list ?? Math.round((shell.clientWidth - sidebar) * 0.55);
    const list = Math.max(PANE_LIMITS.list[0], Math.min(wanted, PANE_LIMITS.list[1], room > 0 ? room - sidebar : Infinity));
    shell.style.setProperty('--sidebar-w', `${sidebar}px`);
    shell.style.setProperty('--list-w', `${list}px`);
    handles.sidebar.style.left = `${sidebar}px`;
    handles.list.style.left = `${sidebar + list}px`;
  };
  const save = () => {
    try { localStorage.setItem('paneWidths', JSON.stringify(widths)); } catch {}
  };
  const handle = (pane) => {
    const el = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', title: t('Breite ziehen – Doppelklick setzt zurück') });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add('dragging');
      shell.classList.add('resizing');
      const startX = e.clientX;
      const start = parseInt(shell.style.getPropertyValue(pane === 'list' ? '--list-w' : '--sidebar-w'), 10) || 0;
      const move = (ev) => {
        widths[pane] = Math.round(start + ev.clientX - startX);
        apply();
      };
      const up = () => {
        el.classList.remove('dragging');
        shell.classList.remove('resizing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        // Store what is actually shown (after the limits).
        widths.sidebar = parseInt(shell.style.getPropertyValue('--sidebar-w'), 10);
        widths.list = parseInt(shell.style.getPropertyValue('--list-w'), 10);
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => {
      widths[pane] = PANE_DEFAULTS[pane];
      apply();
      save();
    });
    return el;
  };
  const handles = { sidebar: handle('sidebar'), list: handle('list') };
  shell.append(handles.sidebar, handles.list);
  apply();
  new ResizeObserver(apply).observe(shell);
}
