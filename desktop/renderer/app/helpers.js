// Small helpers used all over the window: copy with confirmation, dates, form rows, tabs, notices.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t, locale } from '../../../extension/core/i18n.js';
import { sharedNames, vaultChoiceLabel } from '../../../extension/core/session-meta.js';
import { call } from './ipc.js';
import { accessPrompt } from './confirm-each.js';
import { isSealed, sealedPath } from '../../../extension/core/sealed.js';
import { st, ui } from './state.js';

export const LEVEL_LABEL = { read: 'Lesen', write: 'Bearbeiten', manage: 'Verwalten', none: 'Ohne Datenzugriff' };

export const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
/** Every copy confirms itself ("… in die Zwischenablage kopiert") or says that it failed. */
// #480: containerId names the vault the value comes from; a vault that wants the app PIN for copying asks for it first.
export const copy = (text, label = t('Wert'), containerId = null) => Promise.resolve(text)
  .then((value) => withAccess(() => call('copy', value, containerId).catch(async (e) => {
    if (e.name !== 'CopyPinRequired' || !(await copyPinPrompt(containerId || ui.containerId))) throw e;
    return call('copy', value, containerId);
  })))
  .then(() => toast(t('{label} in die Zwischenablage kopiert', { label })))
  .catch((e) => toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error'));

/**
 * #537 2b: a call the main process may refuse with AccessConfirmRequired ("Immer bestätigen" in the personal vault):
 * asks for the proof for exactly that use, then tries once more. Cancelled → the refusal stands.
 */
export async function withAccess(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.name !== 'AccessConfirmRequired' || !e.access || !(await accessPrompt(e.access))) throw e;
    return fn();
  }
}

/** #537 2b: a value of entry containerId/id to copy – a held-back secret (marker) is copied by the main process itself. */
export function copyFrom(containerId, id, value, label = t('Wert')) {
  if (!isSealed(value)) return copy(value, label, containerId);
  return withAccess(() => call('copySecret', containerId, id, sealedPath(value)))
    .then(() => toast(t('{label} in die Zwischenablage kopiert', { label })))
    .catch((e) => toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error'));
}

/** #537 2b: the entry with its secrets (editing, "Anzeigen") – asks for the proof when its vault wants one. */
export const revealItem = (containerId, id) => withAccess(() => call('item', containerId, id, true, { reveal: true }));

/** #537 live test (Lucas): the same words in every dialog that takes Windows Hello, the master password or the PIN. */
export const HELLO_ALLOW = 'Mit Windows Hello erlauben';
export const HELLO_OR = 'Oder mit Masterpasswort oder PIN:';
export const HELLO_AGAIN = 'Erneut mit Windows Hello';

/**
 * #537 risk 3 (Lucas 14.11.2026, "überall automatisch"): with Windows Hello on, a dialog that shows its request asks Hello
 * by itself – once, when it is on screen and has the focus (never a script without a visible request). The field for
 * the master password or the PIN shows only when Hello fails, is cancelled or is not there; then "Erneut mit Windows
 * Hello". start(): the one automatic start (false when it already ran or the dialog is gone).
 */
export function autoHelloOnce(isOn, { skipped = null } = {}) {
  let done = false;
  return (start) => {
    if (done || window.kvSmokeNoAutoHello) return false; // smoke areas that answer the questions themselves
    const go = () => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', go);
      // Konrad M1: what isOn says at the moment of the start counts (one request open, this dialog on top, …) – not, then
      // never automatically for this request; skipped() shows the field at once.
      if (!isOn() || document.visibilityState !== 'visible') { skipped?.(); return; }
      start();
    };
    if (document.hasFocus()) setTimeout(go, 250); // drawn first, so the request stays visible behind Hello
    else window.addEventListener('focus', go);
    return true;
  };
}

/**
 * #537 stage 4 / risk 3: Windows Hello as the recommended way (primary button) above the field for the master password
 * or the PIN – when Hello is on. Hello starts by itself once (autoHelloOnce); field (the .field element) stays hidden until
 * it fails. The main process asks Windows Hello itself for this one use; onProof({ hello: true }) sends only the wish and
 * returns false when it did not go through. null without Hello (the dialog stays as it was, the field shown at once).
 */
export function helloProofButton(onProof, { field: fieldEl = null } = {}) {
  if (!st?.unlock?.hello) return null;
  const or = h('p', { class: 'muted small hello-or' }, t(HELLO_OR));
  const label = h('span', {}, t(HELLO_ALLOW));
  let action = null; // Lena 1: the footer's action – hidden while Hello runs and the field is hidden, it would do nothing
  const reveal = (again = true) => {
    if (fieldEl) fieldEl.hidden = false;
    or.hidden = false;
    if (action) action.hidden = false;
    if (again) label.textContent = t(HELLO_AGAIN);
    fieldEl?.querySelector('input')?.focus();
  };
  const run = async () => {
    button.disabled = true;
    let ok = false;
    try {
      ok = (await onProof({ hello: true })) !== false;
    } catch {
      ok = false;
    } finally {
      button.disabled = false;
    }
    if (!ok) reveal();
  };
  const button = h('button', { type: 'button', class: 'btn primary block hello-proof', onclick: () => run() }, icon('shield'), label);
  const box = h('div', { class: 'hello-proof-box' }, button, or);
  if (autoHelloOnce(() => button.isConnected, { skipped: () => reveal(false) })(run) && fieldEl) { // the field waits for Hello
    fieldEl.hidden = true;
    or.hidden = true;
    setTimeout(() => { // the dialog is built by now
      action = box.closest('dialog')?.querySelector('.modal-footer .btn:last-child') || null;
      if (action && fieldEl.hidden) action.hidden = true;
    }, 0);
  }
  return box;
}

/** #537: the label of the secret a gate asks – the master password or the PIN once set up, else the app PIN. */
export const secretLabel = () => (st?.unlock?.migrated ? t('Masterpasswort oder PIN') : t('App-PIN'));

/** The app PIN for copies from one vault (checked in the main process, valid a minute). → true when confirmed */
function copyPinPrompt(containerId) {
  if (!containerId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const mp = !!st?.unlock?.migrated;
    const pin = h('input', { type: 'password', ...(mp ? {} : { inputmode: 'numeric' }), autocomplete: 'off', class: 'copy-pin', 'aria-label': secretLabel() });
    let ok = false;
    const pinField = field(secretLabel(), pin);
    const hello = helloProofButton(async (proof) => {
      try {
        ok = await call('confirmCopyPin', containerId, proof);
        close();
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }, { field: pinField });
    const { dialog, close } = modal(mp ? t('Bestätigen zum Kopieren') : t('App-PIN zum Kopieren'), h('div', {},
      h('p', {}, mp ? t('Dieser Tresor verlangt beim Kopieren eine Bestätigung (Masterpasswort, PIN oder Windows Hello).') : t('Dieser Tresor verlangt beim Kopieren die App-PIN.')),
      hello, pinField), [
      { label: t('Abbrechen') },
      { label: t('Kopieren'), primary: !st.unlock?.hello, onClick: async () => { // Lena: one primary button – Hello's
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
