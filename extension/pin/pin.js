// #465: the app PIN for one passkey sign-in, inside the Keevault tag at the top of the page (lib/pin-frame.js). Nothing
// is kept here: the field is emptied with every attempt and whenever the frame loses the focus, so a page that pulls the
// focus away mid-typing never gets a PIN sent in parts. Enter counts only while the field has been really visible for
// a while (visible-guard.js, also inside this frame); the tag checks the frame from outside as well. Esc cancels.

import { h, setChildren, showPinProblem } from '../core/dom.js';
import { setLanguage, t } from '../core/i18n.js';
import { call, unlockError } from '../lib/api.js';

const [requestId = '', choice = ''] = location.hash.slice(1).split(':').map((x) => decodeURIComponent(x));
const [containerId, itemId, credentialId] = choice.split('|');
const main = document.getElementById('main');
let pin = null;

const cancel = () => call('webauthn:cancel', { requestId }).catch(() => {});
const refused = () => t('Nicht angemeldet: Die Leiste war verdeckt, verschoben oder gerade erst erschienen. Bitte die PIN erneut eingeben.');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
});
window.addEventListener('blur', () => { if (pin) pin.value = ''; });
window.addEventListener('focus', () => pin?.focus());

(async () => {
  const st = await call('state').catch(() => null);
  if (st?.settings?.language) setLanguage(st.settings.language);
  document.documentElement.lang = st?.settings?.language || 'de';
  const problem = h('div', { class: 'problem', role: 'alert', hidden: true });
  let d;
  try {
    d = await call('webauthn:pinFrame', { requestId });
  } catch (e) {
    setChildren(main, [h('div', { class: 'problem', role: 'alert' }, e.message)]);
    return;
  }
  if (d.pin?.required && !d.pin.pinSet) {
    setChildren(main, [h('div', { class: 'problem' }, t('Für Passkeys braucht Keevault eine App-PIN. Lege sie in der Keevault-App unter Einstellungen → Sicherheit fest.'))]);
    return;
  }
  pin = h('input', { type: 'password', class: 'pin', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('App-PIN'), placeholder: t('App-PIN') });
  const guard = globalThis.kvpwsafeVisibleGuard?.(pin) || null; // without the API nothing counts as visible (#373)
  let busy = false;
  pin.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !e.isTrusted || busy) return;
    e.preventDefault();
    const typed = pin.value;
    pin.value = ''; // one attempt, one use: never kept for a second try
    if (!typed) return;
    if (!guard?.clear()) {
      showPinProblem(problem, refused());
      return;
    }
    busy = true;
    // #508: the app checks the PIN and signs – the field is locked meanwhile and says so, never looks frozen.
    pin.disabled = true;
    problem.hidden = true;
    status.hidden = false;
    try {
      await call('webauthn:pinApprove', { requestId, containerId, itemId, credentialId, pin: typed });
      // Signed in: the tag shows the success and removes this frame.
    } catch (err) {
      // Wrong PIN, blocked for a while (countdown), covered, no answer in time: the request stays open, the frame stays.
      showPinProblem(problem, unlockError(err));
    } finally {
      busy = false;
      status.hidden = true;
      pin.disabled = false;
      pin.focus();
    }
  });
  const status = h('div', { class: 'busy', role: 'status', hidden: true }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('Entsperre …'));
  setChildren(main, [h('label', {}, t('App-PIN eingeben, um diese Anmeldung zu erlauben')), pin, status, problem]);
  if (document.hasFocus()) pin.focus();
})();
