// Small helpers used all over the window: copy with confirmation, dates, form rows, tabs, notices.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t, locale } from '../../../extension/core/i18n.js';
import { sharedNames, vaultChoiceLabel } from '../../../extension/core/session-meta.js';
import { call } from './ipc.js';
import { st, ui } from './state.js';

export const LEVEL_LABEL = { read: 'Lesen', write: 'Bearbeiten', manage: 'Verwalten', none: 'Ohne Datenzugriff' };

export const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
/** Every copy confirms itself ("… in die Zwischenablage kopiert") or says that it failed. */
// #480: containerId names the vault the value comes from; a vault that wants the app PIN for copying asks for it first.
export const copy = (text, label = t('Wert'), containerId = null) => Promise.resolve(text)
  .then((value) => call('copy', value, containerId).catch(async (e) => {
    if (e.name !== 'CopyPinRequired' || !(await copyPinPrompt(containerId || ui.containerId))) throw e;
    return call('copy', value, containerId);
  }))
  .then(() => toast(t('{label} in die Zwischenablage kopiert', { label })))
  .catch((e) => toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error'));

/** The app PIN for copies from one vault (checked in the main process, valid a minute). → true when confirmed */
function copyPinPrompt(containerId) {
  if (!containerId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'copy-pin', 'aria-label': t('App-PIN') });
    let ok = false;
    const { dialog } = modal(t('App-PIN zum Kopieren'), h('div', {}, h('p', {}, t('Dieser Tresor verlangt beim Kopieren die App-PIN.')), field(t('App-PIN'), pin)), [
      { label: t('Abbrechen') },
      { label: t('Kopieren'), primary: true, onClick: async () => {
        try {
          ok = await call('confirmCopyPin', containerId, pin.value);
          return true;
        } catch (err) {
          toast(err.message, 'error');
          pin.select();
          return false;
        }
      } },
    ]);
    dialog.addEventListener('close', () => resolve(ok));
    setTimeout(() => pin.focus(), 0);
  });
}
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
/** Name of a vault in a select (save, move, new, import): with its host when the name comes from the vault or is taken twice (#479). */
export const choiceName = (c) => vaultChoiceLabel(c, sharedNames(st.containers));
export const writableContainers = () => st.containers.filter(writable).map((c) => ({ id: c.id, name: choiceName(c), personal: !!c.personal }));
