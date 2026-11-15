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
  // #537 stage 4: once the master password is set up: the MP or the PIN, or Windows Hello (asked by the app).
  const label = d.pin?.masterPassword ? t('Masterpasswort oder PIN') : t('App-PIN');
  const prompt0 = () => (d.pin?.masterPassword ? t('Masterpasswort oder PIN eingeben, um diese Anmeldung zu erlauben') : t('App-PIN eingeben, um diese Anmeldung zu erlauben'));
  pin = h('input', { type: 'password', class: 'pin', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder: label });
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
  const statusText = h('span', {}, t('Entsperre …'));
  const status = h('div', { class: 'busy', role: 'status', hidden: true }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), statusText);
  // Windows Hello: only after a real click in this frame and with the same visibility check as Enter (#373).
  // #537 risk 3 (Lucas: "überall automatisch"): Hello starts by itself once, as soon as this frame has been really visible
  // long enough (its own guard on the Hello button – the field is hidden until Hello did not go through).
  const askHello = async () => {
    if (busy) return;
    if (!helloGuard?.clear()) {
      showPinProblem(problem, refused());
      showField();
      return;
    }
    busy = true;
    hello.disabled = true;
    pin.disabled = true;
    problem.hidden = true;
    statusText.textContent = t('Warte auf Windows Hello …'); // Lena 3
    status.hidden = false;
    try {
      await call('webauthn:pinApprove', { requestId, containerId, itemId, credentialId, pin: { hello: true } });
    } catch (err) {
      showPinProblem(problem, unlockError(err));
      showField();
    } finally {
      busy = false;
      status.hidden = true;
      statusText.textContent = t('Entsperre …');
      hello.disabled = false;
      pin.disabled = false;
      if (!pin.hidden) pin.focus(); // Lena 2: after a cancel the field takes the keys at once
    }
  };
  const helloLabel = h('span', {}, t('Mit Windows Hello erlauben')); // #537 live test: the same words as in the app's dialogs
  const hello = d.pin?.hello ? h('button', { type: 'button', class: 'hello', onclick: (e) => { if (e.isTrusted) askHello(); } }, helloLabel) : null;
  const helloGuard = hello ? globalThis.kvpwsafeVisibleGuard?.(hello) || null : null;
  const or = hello ? h('p', { class: 'hello-or', hidden: true }, t('Oder mit Masterpasswort oder PIN:')) : null;
  const fieldLabel = h('label', { hidden: !!hello }, prompt0());
  const showField = (again = true) => {
    or && (or.hidden = false);
    fieldLabel.hidden = false;
    pin.hidden = false;
    if (again) helloLabel.textContent = t('Erneut mit Windows Hello');
  };
  if (hello) pin.hidden = true;
  // #537 live test (Lucas): Hello first, the recommended way; the field for the master password or the PIN the alternative.
  setChildren(main, [hello, or, fieldLabel, pin, status, problem]);
  // Lena 3: the tag sizes this frame to what it shows (Hello, the field, an error, English) – told through the worker.
  let sent = 0;
  const report = () => {
    const height = Math.ceil(main.getBoundingClientRect().height);
    if (height && Math.abs(height - sent) > 1) {
      sent = height;
      call('webauthn:pinFrameSize', { requestId, height }).catch(() => {});
    }
  };
  new ResizeObserver(report).observe(main);
  report();
  if (hello) {
    // The one automatic start: as soon as the guard says the frame has been visible long enough (at most 6 s of waiting).
    // Konrad (low): at most one automatic start within 60 s for one site – a page that asks again after a cancel waits
    // for a click.
    const key = `helloAuto:${d.rpId || ''}`;
    const last = (await chrome.storage.session.get(key).catch(() => ({})))[key] || 0;
    if (Date.now() - last < 60_000) showField(false);
    else {
      const until = Date.now() + 6000;
      const tick = () => {
        if (!hello.isConnected || busy) return;
        if (helloGuard?.clear()) {
          chrome.storage.session.set({ [key]: Date.now() }).catch(() => {});
          askHello();
          return;
        }
        if (Date.now() < until) setTimeout(tick, 200);
        else showField(false);
      };
      setTimeout(tick, 200);
    }
  }
  if (document.hasFocus()) pin.focus();
})();
