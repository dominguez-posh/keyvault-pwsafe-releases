// The context menu itself (positioning, submenus, keyboard).

import { h, icon, toast } from '../../../extension/core/dom.js';
import { call } from './ipc.js';

/** Context menu at the mouse position; closes on click elsewhere, Escape, scrolling or resizing. */
export function contextMenu(event, actions) {
  event.preventDefault();
  document.querySelector('.context-menu')?.remove();
  // Entries with "children" open a submenu (hover or click); it stays inside the menu's DOM.
  const item = (a) => {
    if (a === '-') return h('div', { class: 'context-sep' });
    if (a.children) {
      const sub = h('div', { class: 'context-menu context-sub', role: 'menu' }, ...a.children.filter(Boolean).map(item));
      const wrap = h('div', { class: 'context-group' });
      const place = () => sub.classList.toggle('left', wrap.getBoundingClientRect().right + 240 > window.innerWidth);
      wrap.append(h('button', {
        type: 'button', role: 'menuitem', 'aria-haspopup': 'true', class: 'has-sub', dataset: { action: a.action || '' },
        onclick: () => {
          if (wrap.classList.toggle('open')) place();
        },
        onmouseenter: () => {
          wrap.classList.add('open');
          place();
        },
      }, icon(a.icon, 15), h('span', {}, a.label), icon('caret', 13)), sub);
      wrap.addEventListener('mouseleave', () => wrap.classList.remove('open'));
      return wrap;
    }
    return h('button', {
      type: 'button', role: 'menuitem', class: a.danger ? 'danger' : '', disabled: a.disabled, dataset: { action: a.action || '' },
      onclick: async () => {
        close();
        try {
          await a.onClick();
        } catch (e) {
          // A refused action must say why (#407), otherwise nothing seems to happen; the log keeps it as before.
          toast(e.message, 'error');
          call('log', { level: 'error', message: e.message, detail: `menu: ${a.action || a.label}` }).catch(() => {});
        }
      },
    }, icon(a.icon, 15), h('span', {}, a.label));
  };
  const menu = h('div', { class: 'context-menu', role: 'menu' }, ...actions.filter(Boolean).map(item));
  const close = () => {
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  };
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.body.append(menu);
  const { innerWidth: w, innerHeight: hgt } = window;
  // Taller than the window (small window, long menu): it scrolls from the top edge – submenus then open inside it.
  if (menu.getBoundingClientRect().height > hgt - 16) menu.classList.add('scrolls');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, w - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, hgt - rect.height - 8))}px`;
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  menu.querySelector('button:not(:disabled)')?.focus();
}
