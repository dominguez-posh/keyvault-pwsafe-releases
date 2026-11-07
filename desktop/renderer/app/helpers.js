// Small helpers used all over the window: copy with confirmation, dates, form rows, tabs, notices.

import { h, icon, toast } from '../../../extension/core/dom.js';
import { t, locale } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';

export const LEVEL_LABEL = { read: 'Lesen', write: 'Bearbeiten', manage: 'Verwalten', none: 'Ohne Datenzugriff' };

export const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
/** Every copy confirms itself ("… in die Zwischenablage kopiert") or says that it failed. */
export const copy = (text, label = t('Wert')) => Promise.resolve(text).then((value) => call('copy', value))
  .then(() => toast(t('{label} in die Zwischenablage kopiert', { label })))
  .catch((e) => toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error'));
export const openUrl = (url) => call('openExternal', url);
export const formatDate = (iso) => new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
let fieldSeq = 0;
// The label belongs to its control (screen readers, click on the label); a control that has no id gets one.
export const field = (label, input, hint) => {
  const control = input instanceof Element && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName) ? input : null;
  if (control && !control.id) control.id = `fld-${++fieldSeq}`;
  return h('div', { class: 'field' }, h('label', control ? { for: control.id } : {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
};

/** Tab bar + panels for a dialog; the active tab per key survives closing (e.g. reopening the settings after Save). */
const activeTabs = {};
export function tabbed(key, pages) {
  const panels = pages.map((p) => h('div', { class: 'tab-panel' }, ...p.content));
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = (i) => {
    activeTabs[key] = i;
    [...bar.children].forEach((b, n) => b.classList.toggle('active', n === i));
    panels.forEach((p, n) => { p.hidden = n !== i; });
  };
  pages.forEach((p, i) => bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(i) }, p.icon ? icon(p.icon, 16) : null, h('span', {}, p.label))));
  show(Math.min(activeTabs[key] || 0, pages.length - 1));
  return h('div', { class: 'tabbed' }, bar, ...panels);
}
export const notice = (text, kind = 'error') => h('div', { class: `notice ${kind}` }, text);
export const writable = (c) => c.access?.write !== false && !c.error && !c.locked;
export const writableContainers = () => st.containers.filter(writable).map((c) => ({ id: c.id, name: c.name, personal: !!c.personal }));
