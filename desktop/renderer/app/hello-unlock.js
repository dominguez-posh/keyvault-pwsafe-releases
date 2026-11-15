// #537 stage 3: Windows Hello as a way to unlock with the master password – the step after the master password at first
// start (Lucas: "Windows Hello aktivieren?" recommended, the app PIN as the alternative not recommended), the button on
// the lock screen and the switch in the settings. The main process asks Windows Hello and decides; the window only asks.

import { h, icon, modal, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { autoHelloOnce, field } from './helpers.js';
import { focusField } from './focus.js';

// #537 risk 3: the lock screen asks Windows Hello by itself once per lock – not again after a cancel (then the field).
let lockAutoUsed = false;

/** After a successful unlock: the next lock screen may start Hello by itself again. */
export function resetLockAutoHello() {
  lockAutoUsed = false;
}

/**
 * The lock screen with Hello on: the field (fieldEl) hidden and Hello started by itself, once per lock, while the screen
 * is visible and focused. With an error (Hello cancelled or failed, a wrong secret) the field shows and nothing starts.
 */
export function lockScreenAutoHello(button, { fieldEl, error }) {
  if (!button || error || lockAutoUsed) return;
  const scheduled = autoHelloOnce(() => button.isConnected && !lockAutoUsed)(() => {
    lockAutoUsed = true;
    button.click();
  });
  if (scheduled && fieldEl) fieldEl.hidden = true;
}

/** Lock screen: "Mit Windows Hello entsperren" when the Hello wrapper is there; done() continues like after the MP. */
export function helloKeyLockButton({ done, failed }) {
  if (!st.unlock?.hello) return null;
  const button = h('button', { type: 'button', class: 'btn block hello-key-unlock', onclick: async () => {
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner' }), t('Windows Hello …'));
    try {
      await call('unlockWithHelloKey');
      await done();
    } catch (e) {
      failed(e.message);
    }
  } }, icon('shield'), t('Mit Windows Hello entsperren'));
  return button;
}

/** The master password once more – switching Hello on or off needs it (Konrad). Resolves after `action` succeeded. */
function withMasterPassword(title, text, action) {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', class: 'hello-key-mp', 'aria-label': t('Masterpasswort') });
  const { dialog } = modal(title, h('div', {}, h('p', {}, text), field(t('Masterpasswort'), pw)), [
    { label: t('Abbrechen') },
    { label: t('Weiter'), primary: true, onClick: async () => {
      try {
        setSt(await action(pw.value));
        return true;
      } catch (e) {
        toast(e.message, 'error');
        pw.select();
        return false;
      }
    } },
  ]);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn.primary')?.click(); });
  focusField(pw);
}

/** Settings → Sicherheit → Masterpasswort: Windows Hello on (with the MP) or off (with the MP). */
export function helloKeySettingsPart() {
  if (st.platform !== 'win32' && !st.smoke) return null;
  const on = !!st.unlock?.hello;
  const box = h('input', { type: 'checkbox', class: 'hello-key-setting', checked: on, disabled: !st.opened });
  const status = h('p', { class: 'muted small hello-key-status' }, t('Gesicht, Fingerabdruck oder Windows-Hello-PIN entsperren Keevault auf diesem Gerät. Das Masterpasswort bleibt immer als zweiter Weg.'));
  if (st.opened) {
    call('helloKeyInfo').then((i) => {
      if (!i.allowed) status.textContent = t('Eure Organisation hat das Entsperren mit Windows Hello abgeschaltet');
      else if (i.remote && !i.on) status.textContent = t('Windows Hello steht in einer Remotesitzung nicht zur Verfügung – bitte das Masterpasswort eingeben');
      else if (!i.available && !i.on) status.textContent = t('Windows Hello ist auf diesem Gerät nicht eingerichtet');
      else return;
      box.disabled = !i.on;
    }).catch(() => {});
  }
  box.addEventListener('change', () => {
    const wanted = box.checked;
    box.checked = !wanted;
    if (wanted) {
      withMasterPassword(t('Windows Hello einschalten'), t('Bestätige mit deinem Masterpasswort. Danach fragt Windows Hello einmal nach Gesicht, Fingerabdruck oder PIN.'),
        async (password) => { const s = await call('enableHelloUnlock', { password }); toast(t('Windows Hello eingeschaltet')); return s; });
    } else {
      withMasterPassword(t('Windows Hello ausschalten'), t('Bestätige mit deinem Masterpasswort. Danach entsperrt nur noch das Masterpasswort (oder deine PIN).'),
        async (password) => { const s = await call('disableHelloUnlock', { password }); toast(t('Windows Hello ausgeschaltet')); return s; });
    }
  });
  return h('div', {}, h('label', { class: 'inline' }, box, t('Mit Windows Hello entsperren')), status);
}

/**
 * First start, after the master password (Lucas 13.11.2026): "Windows Hello aktivieren?" (recommended); the app PIN as
 * the alternative, not recommended; or only the master password. Without Hello (not set up, forbidden, remote) the PIN
 * is offered directly. password: the master password just set (switching Hello on needs it). Resolves when done.
 */
/**
 * password: the master password (text), or a function giving it (the question after an upgrade asks it in its own field).
 * pinAllowed: false when a PIN kept from before is the chosen alternative already (then only Hello, or nothing). lead:
 * shown above every part (that field). Marks the question as asked on this device.
 */
export function helloFirstStartStep({ password, body, buttons, btn, done, pinAllowed = true, lead = null }) {
  const secret = () => (typeof password === 'function' ? password() : password);
  call('helloOfferShown').catch(() => {});
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'first-pin' });
  const repeat = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'first-pin2' });
  const show = (parts) => body([lead, ...parts]);
  const savePin = async () => {
    if (pin.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
    setSt(await call('setPin', { current: secret(), next: pin.value }));
    toast(t('PIN festgelegt'));
    done();
  };
  const skip = btn(t('Überspringen – nur Masterpasswort'), () => done(), { cls: 'first-unlock-skip' });
  const pinPart = (lead) => [
    lead,
    h('div', { class: 'grid2' }, field(t('PIN'), pin), field(t('Wiederholen'), repeat)),
    h('p', { class: 'muted small' }, t('Mindestens 6 Zeichen. Die PIN gilt nur auf diesem Gerät; wer dein Windows-Konto hat, kann sie schneller erraten als das Masterpasswort.')),
    buttons(skip, btn(t('PIN festlegen'), savePin, { primary: true, cls: 'first-pin-save' })),
  ];
  const showPin = (text) => { show(pinPart(text)); setTimeout(() => focusField(pin), 0); };
  show([h('p', { class: 'muted' }, h('span', { class: 'spinner' }), t('Windows Hello wird geprüft …'))]);
  call('helloKeyInfo').then((i) => {
    if (!i.allowed || !i.available) {
      if (!pinAllowed) return done(); // nothing left to offer: Hello not possible, the PIN is there already
      showPin(h('p', {}, !i.allowed ? t('Eure Organisation hat das Entsperren mit Windows Hello abgeschaltet.') : t('Windows Hello ist auf diesem Gerät nicht eingerichtet.'),
        ' ', t('Du kannst eine App-PIN festlegen, um Keevault auf diesem Gerät schneller zu entsperren – oder nur das Masterpasswort verwenden.')));
      return undefined;
    }
    show([
      h('h3', {}, t('Windows Hello aktivieren?')),
      h('p', {}, t('Empfohlen: Gesicht, Fingerabdruck oder Windows-Hello-PIN entsperren Keevault auf diesem Gerät. Der Schlüssel liegt im TPM-Chip; das Masterpasswort bleibt immer als zweiter Weg.')),
      buttons(
        pinAllowed ? btn(t('Stattdessen App-PIN (nicht empfohlen)'), () => showPin(h('p', {}, t('Eine App-PIN entsperrt Keevault auf diesem Gerät. Windows Hello ist sicherer.'))), { cls: 'first-choose-pin' }) : null,
        skip,
        btn(t('Windows Hello aktivieren'), async () => {
          setSt(await call('enableHelloUnlock', { password: secret() }));
          toast(t('Windows Hello eingeschaltet'));
          done();
        }, { primary: true, cls: 'first-hello-on' })),
    ]);
    return undefined;
  }).catch(() => (pinAllowed ? showPin(null) : done()));
}

let upgradeAsked = false;

/**
 * #537 live test: an installation from before (app PIN) gets the master password through the move dialog, not through the
 * first start – so "Windows Hello aktivieren?" is asked here once, after the first unlock with the master password set
 * up: Hello recommended, the app PIN the alternative (none when a PIN was kept), "Überspringen". password: the master
 * password just typed, else the dialog asks it. → true when the dialog opened.
 */
export function offerHelloAfterUpgrade({ password = null } = {}) {
  if (window.kvSmokeHelloOfferReset) { upgradeAsked = false; window.kvSmokeHelloOfferReset = false; } // smoke: a fresh session
  const due = st?.unlock?.helloOffer;
  if (upgradeAsked || !due || !st?.opened || st.demo || (st.smoke && !window.kvSmokeHelloOffer) || document.querySelector('dialog[open]')) return false;
  upgradeAsked = true;
  const mp = password ? null : h('input', { type: 'password', autocomplete: 'current-password', class: 'hello-offer-mp' });
  const box = h('div', { class: 'hello-offer' });
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b.filter(Boolean));
  let close = () => {};
  const btn = (label, onClick, { primary = false, cls = '' } = {}) => h('button', { type: 'button', class: `${primary ? 'btn primary' : 'btn'} ${cls}`.trim(), onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  const dialog = modal(t('Schneller entsperren'), box, []);
  dialog.dialog.classList.add('hello-offer-modal');
  close = dialog.close;
  helloFirstStartStep({
    password: () => password || mp.value,
    pinAllowed: due !== 'hello',
    lead: mp ? field(t('Masterpasswort'), mp) : null,
    buttons, btn,
    done: () => close(),
    body: (parts) => box.replaceChildren(...parts.filter(Boolean)),
  });
  if (mp) setTimeout(() => focusField(mp), 0);
  return true;
}
