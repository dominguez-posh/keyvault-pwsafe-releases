// #495: the popup's loading and error states. The skeleton itself is in popup.html, so it is on screen with the first
// paint, before any script or the service worker answers. Here: the step text ("Verbinde mit Keevault …",
// "Lade Tresore …"), a hint with "Erneut versuchen" when it takes unusually long, the error state, and the
// "wird aktualisiert" line above a list shown from the last known state.

import { h, icon, setChildren } from '../core/dom.js';
import { t } from '../core/i18n.js';

/** After this long without an answer the loading state says so and offers "Erneut versuchen" (it keeps waiting). */
export const SLOW_MS = 8000;

const skeleton = () => h('div', { class: 'loading-state', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
  h('div', { class: 'loading-bar' }, h('span')),
  h('p', { class: 'loading-step' }, t('Verbinde mit Keevault …')),
  h('ul', { class: 'list loading-skeleton', 'aria-hidden': 'true' }, ...[0, 1, 2, 3, 4].map(() => h('li', {}, h('i'), h('b'), h('em')))));

/**
 * Shows the loading state in view (the one from popup.html when it is still there) → { step(text), done() }.
 * onRetry: what "Erneut versuchen" in the hint for a long wait does.
 */
export function showLoading(view, { onRetry } = {}) {
  let el = view.querySelector(':scope > .loading-state');
  if (!el) {
    view.className = 'view';
    setChildren(view, skeleton());
    el = view.querySelector(':scope > .loading-state');
  }
  const text = el.querySelector('.loading-step');
  const step = (s) => {
    text.textContent = s;
    el.dataset.step = s;
  };
  step(t('Verbinde mit Keevault …'));
  const slow = setTimeout(() => {
    if (!el.isConnected || el.querySelector('.loading-slow')) return;
    el.append(h('div', { class: 'loading-slow' },
      h('p', { class: 'muted' }, t('Das dauert länger als üblich. Läuft die Keevault-App? Eine neue Verbindung bestätigst du dort.')),
      onRetry ? h('button', { type: 'button', class: 'btn', onclick: onRetry }, icon('refresh', 15), t('Erneut versuchen')) : null));
  }, SLOW_MS);
  return { step, done: () => clearTimeout(slow) };
}

/** Error state with the message and "Erneut versuchen" instead of an endless loading state. */
export function errorView(message, onRetry) {
  return h('div', { class: 'center load-error', role: 'alert' }, icon('shield', 40),
    h('h2', {}, t('Keevault antwortet nicht')),
    h('p', { class: 'muted' }, message || t('Keine Antwort vom Hintergrunddienst')),
    h('button', { type: 'button', class: 'btn primary', onclick: onRetry }, icon('refresh', 15), t('Erneut versuchen')));
}

/** The line above a list shown from the last known state while the fresh one loads. */
export const refreshingNote = () => h('div', { class: 'refreshing', role: 'status' }, h('span', { class: 'spinner' }), t('wird aktualisiert'));
