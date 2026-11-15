// Passkey window of the desktop app: runs WebAuthn (with PRF) on http://localhost, which the main process
// serves itself – the app's own app:// origin is not allowed to use WebAuthn.

import { h, icon, setChildren } from '../../extension/core/dom.js';
import { evaluatePrf, registerPrf } from '../../extension/core/prf.js';
import { setLanguage, t } from '../../extension/core/i18n.js';
import { assertApproval, registerApprover } from './approval.js';

const main = document.getElementById('main');
const id = new URLSearchParams(location.search).get('id');
const request = await window.passkeyBridge.request(id);
setLanguage(request.language);

const finish = (result) => window.passkeyBridge.done(id, result);
const cancelled = () => ({ ok: false, error: t('Passkey-Vorgang abgebrochen oder abgelaufen') });
let running = null; // AbortController of the WebAuthn call in progress (#536)

// #536: drawn before WebAuthn starts – the window shows what to do while Windows' dialog is open, never an empty page.
// requestAnimationFrame waits for the frame of the visible window; a hidden one (smoke test) never gets one.
const painted = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, 300);
  requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
});

async function run() {
  const controller = new AbortController();
  running = controller;
  setChildren(main, head(),
    h('p', {}, h('span', { class: 'spinner' }), ' ', t('Bestätige den Passkey im Windows-Dialog …')),
    h('p', { class: 'muted small' }, t('Kein Dialog zu sehen? Er kann hinter anderen Fenstern oder auf einem anderen Bildschirm liegen. Abbrechen oder Esc beendet den Vorgang.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: cancel }, t('Abbrechen'))));
  await painted();
  // The main process brings this window to the front: Windows opens its security dialog over it.
  if (controller.signal.aborted || !(await window.passkeyBridge.started(id))) return;
  const signal = controller.signal;
  try {
    const result = request.mode === 'approver-register'
      ? await registerApprover({ label: request.userName, timeout: request.timeoutMs, signal })
      : request.mode === 'approve'
        ? await assertApproval({ challenge: request.challenge, credentials: request.credentials, timeout: request.timeoutMs, signal })
        : request.mode === 'register'
      ? await registerPrf('localhost', { userName: request.userName, displayName: request.displayName, excludeCredentialIds: request.exclude || [], timeout: request.timeoutMs, attachment: request.attachment, hints: request.hints, signal })
      : await evaluatePrf('localhost', request.passkeys, { timeout: request.timeoutMs, signal });
    if (!signal.aborted) finish({ ok: true, result });
  } catch (e) {
    if (signal.aborted) return;
    setChildren(main, head(), h('div', { class: 'notice error' }, e.message), buttons(t('Erneut versuchen')));
  } finally {
    if (running === controller) running = null;
  }
}

/** Cancel (button, Esc): ends WebAuthn – Windows closes its dialog – and the ceremony. */
function cancel() {
  running?.abort();
  running = null;
  finish(cancelled());
}

function head() {
  return h('div', { class: 'head' }, icon('key', 32), h('div', {},
    h('h3', {}, request.mode === 'approve' ? 'Release freigeben' : request.mode === 'approver-register' ? 'Sicherheitsschlüssel für Releases' : request.mode === 'register' ? t('Passkey registrieren') : t('Mit Passkey entsperren')),
    h('div', { class: 'muted small' }, request.containerName)));
}

function buttons(label) {
  return h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: cancel }, t('Abbrechen')),
    h('button', { class: 'btn primary', onclick: run }, label));
}

document.title = t('Passkey');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
if (request.autoStart) run();
else setChildren(main, head(), h('p', {}, t('Halte deinen Sicherheitsschlüssel bereit oder nutze Windows Hello bzw. dein Smartphone.')), buttons(t('Weiter')));
