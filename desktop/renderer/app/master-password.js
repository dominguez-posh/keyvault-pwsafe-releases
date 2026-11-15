// #537: one master password for the whole app. The dialog that sets it up (moving from the app PIN, or for the first
// time), the question for a fresh master password before changes to the personal vault's keys, and what the lock
// screen needs to ask for the master password or the PIN of this device.

import { h, modal, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field } from './helpers.js';
import { fetchState } from './shell.js';
import { focusField } from './focus.js';
import { offerHelloAfterUpgrade } from './hello-unlock.js';

export const mpSetUp = () => !!st?.unlock?.migrated;
const hasPersonal = () => (st?.containers || []).some((c) => c.personal);
const minLength = () => st?.unlock?.minLength || 12;

let askedThisSession = false;

/** E2: installations from before the update are asked after unlocking (skippable until the gates move over, stage 4). */
export function offerMasterPassword() {
  if (askedThisSession || mpSetUp() || !st?.opened || st.demo || st.smoke || document.querySelector('dialog[open]')) return false;
  askedThisSession = true;
  // #537 live test: right after the move, "Windows Hello aktivieren?" with the master password just typed.
  masterPasswordDialog({ onSet: (password) => setTimeout(() => offerHelloAfterUpgrade({ password }), 400) });
  return true;
}

/**
 * Set up the master password. With a personal vault it is that vault's master password (checked); without one it is
 * chosen here (twice). An old PIN stays as a convenience for this device when wanted. Resolves true when set up.
 */
export function masterPasswordDialog({ later = true, onSet = null } = {}) {
  const personal = hasPersonal();
  const pw = h('input', { type: 'password', autocomplete: personal ? 'current-password' : 'new-password', class: 'mp-new' });
  const pw2 = personal ? null : h('input', { type: 'password', autocomplete: 'new-password', class: 'mp-new2' });
  const oldPin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'mp-old-pin' });
  const pinBox = h('div', { class: 'mp-old-pin-box', hidden: true }, field(t('Bisherige PIN'), oldPin));
  const keepPin = st.pinSet ? h('input', { type: 'checkbox', checked: true, class: 'mp-keep-pin' }) : null;
  return new Promise((resolve) => {
    let done = false;
    const { dialog } = modal(t('Masterpasswort statt PIN'), h('div', {},
      h('p', {}, t('Keevault hat jetzt ein Masterpasswort für alles: App, persönlicher Tresor, Offline-Kopie und Bestätigungen. Du brauchst es auf neuen Geräten und zum Ändern wichtiger Einstellungen.')),
      personal
        ? h('p', { class: 'muted small' }, t('Gib das Masterpasswort deines persönlichen Tresors ein – es wird das Masterpasswort von Keevault.'))
        : h('p', { class: 'muted small' }, t('Wähle es lang und einzigartig (mindestens {n} Zeichen).', { n: minLength() })),
      personal ? field(t('Masterpasswort'), pw) : h('div', { class: 'grid2' }, field(t('Masterpasswort'), pw), field(t('Wiederholen'), pw2)),
      pinBox,
      keepPin ? h('label', { class: 'inline' }, keepPin, t('Meine PIN auf diesem Gerät weiter verwenden')) : null), [
      later ? { label: t('Später'), onClick: () => { resolve(false); } } : null,
      { label: t('Masterpasswort festlegen'), primary: true, onClick: async () => {
        if (pw2 && pw.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
        try {
          await call('setupMasterPassword', { password: pw.value, pin: oldPin.value || null, keepPin: keepPin ? keepPin.checked : false });
          done = true;
          setSt(await fetchState());
          toast(t('Masterpasswort eingerichtet'));
          onSet?.(pw.value);
          resolve(true);
          return true;
        } catch (e) {
          if (e.name !== 'PinRequired') throw e;
          pinBox.hidden = false; // the PIN of the unlock a moment ago is no longer known: ask it once more
          focusField(oldPin);
          toast(e.message, 'error');
          return false;
        }
      } },
    ].filter(Boolean));
    dialog.classList.add('master-password-dialog');
    dialog.addEventListener('close', () => { if (!done) resolve(false); });
    setTimeout(() => focusField(pw), 0);
  });
}

/** Asks for the master password (or the recovery key) for one change; resolves true when the main process confirmed it. */
export function freshPasswordDialog(purpose = 'personal-keyring') {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', class: 'mp-fresh' });
  const code = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, class: 'mp-fresh-code', placeholder: 'RK-…' });
  const codeBox = h('div', { hidden: true }, field(t('Wiederherstellungsschlüssel'), code));
  return new Promise((resolve) => {
    let ok = false;
    const { dialog } = modal(t('Masterpasswort bestätigen'), h('div', {},
      h('p', {}, purpose === 'personal-adopt'
        ? t('Dieser Tresor hat ein anderes Masterpasswort. Es wird das Masterpasswort von Keevault – bestätige das mit deinem bisherigen.')
        : t('Diese Änderung am persönlichen Tresor braucht dein Masterpasswort – die entsperrte App allein reicht dafür nicht.')),
      field(t('Masterpasswort'), pw),
      purpose === 'personal-keyring' ? h('button', { type: 'button', class: 'linklike', onclick: () => { codeBox.hidden = false; focusField(code); } }, t('Stattdessen den Wiederherstellungsschlüssel eingeben')) : null,
      codeBox), [
      { label: t('Abbrechen') },
      { label: t('Bestätigen'), primary: true, onClick: async () => {
        await call('confirmMasterPassword', code.value.trim() ? { code: code.value.trim() } : { password: pw.value }, purpose);
        ok = true;
        return true;
      } },
    ]);
    dialog.classList.add('fresh-password-dialog');
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn.primary')?.click(); });
    dialog.addEventListener('close', () => resolve(ok));
    setTimeout(() => focusField(pw), 0);
  });
}

/** Runs fn; when the main process wants a fresh master password first, asks for it once and runs fn again. */
export async function withFreshPassword(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.name !== 'FreshProofRequired') throw e;
    if (!(await freshPasswordDialog(e.purpose || 'personal-keyring'))) throw new Error(t('Abgebrochen'));
    return fn();
  }
}

/**
 * The secret field of the lock screen: the master password, or – when this device has a PIN – the PIN, with a link to
 * switch. → { el, input, kind() } – kind() tells the main process what was typed.
 */
export function unlockSecretField({ onEnter }) {
  const s = { kind: st?.unlock?.pin ? 'pin' : 'password' };
  const input = h('input', { type: 'password', autocomplete: 'off', class: 'pin-input', onkeydown: (e) => { if (e.key === 'Enter') onEnter(); } });
  const label = h('span', {});
  const toggle = h('button', { type: 'button', class: 'linklike unlock-kind', onclick: () => { s.kind = s.kind === 'pin' ? 'password' : 'pin'; draw(); focusField(input); } });
  const draw = () => {
    const pin = s.kind === 'pin';
    label.textContent = pin ? t('PIN') : t('Masterpasswort');
    input.placeholder = pin ? t('PIN') : t('Masterpasswort');
    if (pin) input.setAttribute('inputmode', 'numeric'); else input.removeAttribute('inputmode');
    toggle.textContent = pin ? t('Mit Masterpasswort entsperren') : t('Mit PIN entsperren');
    toggle.hidden = !st?.unlock?.pin;
  };
  draw();
  input.id = 'unlock-secret';
  const el = h('div', { class: 'unlock-secret' }, h('div', { class: 'field' }, h('label', { for: input.id }, label), input), toggle);
  return { el, input, kind: () => s.kind };
}
