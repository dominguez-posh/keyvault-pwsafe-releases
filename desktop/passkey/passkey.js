// Passkey window of the desktop app: runs WebAuthn (with PRF) on http://localhost, which the main process
// serves itself – the app's own app:// origin is not allowed to use WebAuthn.

import { h, icon, setChildren } from '../../extension/core/dom.js';
import { evaluatePrf, registerPrf } from '../../extension/core/prf.js';
import { setLanguage, t } from '../../extension/core/i18n.js';

const main = document.getElementById('main');
const id = new URLSearchParams(location.search).get('id');
const request = await window.passkeyBridge.request(id);
setLanguage(request.language);

const finish = (result) => window.passkeyBridge.done(id, result);

async function run() {
  setChildren(main, head(), h('p', {}, h('span', { class: 'spinner' }), ' ', t('Bestätige den Passkey im Windows-Dialog …')));
  try {
    const result = request.mode === 'register'
      ? await registerPrf('localhost', { userName: request.userName, displayName: request.displayName, excludeCredentialIds: request.exclude || [], timeout: request.timeoutMs, attachment: request.attachment })
      : await evaluatePrf('localhost', request.passkeys, { timeout: request.timeoutMs });
    finish({ ok: true, result });
  } catch (e) {
    setChildren(main, head(), h('div', { class: 'notice error' }, e.message), buttons(t('Erneut versuchen')));
  }
}

function head() {
  return h('div', { class: 'head' }, icon('key', 32), h('div', {},
    h('h3', {}, request.mode === 'register' ? t('Passkey registrieren') : t('Mit Passkey entsperren')),
    h('div', { class: 'muted small' }, request.containerName)));
}

function buttons(label) {
  return h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => finish({ ok: false, error: t('Passkey-Vorgang abgebrochen oder abgelaufen') }) }, t('Abbrechen')),
    h('button', { class: 'btn primary', onclick: run }, label));
}

document.title = t('Passkey');
if (request.autoStart) run();
else setChildren(main, head(), h('p', {}, t('Halte deinen Sicherheitsschlüssel bereit oder nutze Windows Hello bzw. dein Smartphone.')), buttons(t('Weiter')));
