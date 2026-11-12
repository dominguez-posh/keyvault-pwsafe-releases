// First start (#515): the Microsoft sign-in first, then the App PIN (skippable), before the other wizards (personal
// vault, team vault, settings from another device). The sign-in uses the Windows account when the broker (WAM) is
// there: auth.unlock with no account and no prompt signs in with the default Windows account, without a dialog if
// Windows allows it (desktop/auth.js); otherwise the browser opens.

import { h, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field, notice } from './helpers.js';
import { fetchState } from './shell.js';
import { focusField } from './focus.js';

// Smoke runs show this step only when the first-start check asks for it, and may treat the demo as signed out to
// exercise the sign-in itself (desktop/smoke-first-start.js). Without st.smoke these flags do nothing.
const smokeFlag = (name) => !!st.smoke && window[name] === true;

/** Whether the first start begins with these steps: not in the demo (unchanged), not when both are done already. */
export function accountStepsDue() {
  if (st.smoke) return smokeFlag('kvSmokeAccountStep');
  return !st.demo && (!st.signedIn || !st.pinSet);
}

const signedIn = () => st.signedIn && !smokeFlag('kvSmokeSignedOut');

/** The two steps in one wizard. Resolves when it is closed; closing it skips what is left, the next wizards follow. */
export function accountWizard() {
  const s = { step: signedIn() && !smokeFlag('kvSmokeAccountStep') ? 1 : 0 };
  const body = h('div', { class: 'wizard first-start-wizard' });
  const { dialog, close } = modal(t('Willkommen bei Keevault'), body, []);
  dialog.classList.add('wizard-modal');
  const closed = new Promise((resolve) => dialog.addEventListener('close', () => resolve()));
  const steps = [t('Anmelden'), t('App-PIN')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b.filter(Boolean));
  const btn = (label, onClick, { primary = false, cls = '' } = {}) => h('button', { type: 'button', class: `${primary ? 'btn primary' : 'btn'} ${cls}`.trim(), onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  // After the sign-in: done when a PIN is set already (and the smoke check didn't ask for the PIN step).
  const afterSignIn = () => (st.pinSet && !smokeFlag('kvSmokeAccountStep') ? close() : go(1));
  const go = (step) => { s.step = step; draw(); };

  const draw = () => {
    let content;
    if (s.step === 0) {
      content = [
        h('p', {}, st.signInMode === 'windows'
          ? t('Melde dich zuerst bei Microsoft an. Keevault nimmt dafür dein Windows-Konto (Single Sign-on) – nur falls nötig erscheint der Microsoft-Anmeldedialog.')
          : t('Melde dich zuerst mit deinem Arbeitskonto bei Microsoft an. Die Anmeldung öffnet sich im Standardbrowser.')),
        h('p', { class: 'muted small' }, t('Damit findet Keevault die Tresore in Azure, auf die du Zugriff hast. Ohne Microsoft-Konto kannst du auch nur mit Datei-Tresoren und dem persönlichen Tresor arbeiten.')),
        signedIn() ? notice(t('Angemeldet als {user}', { user: st.account?.username || '' }), 'info') : null,
        buttons(
          signedIn() ? null : btn(t('Ohne Microsoft-Konto weiter'), () => afterSignIn(), { cls: 'first-skip-signin' }),
          signedIn()
            ? btn(t('Weiter'), () => afterSignIn(), { primary: true })
            : btn(t('Mit Microsoft anmelden'), async () => {
              const r = await call('signIn');
              if (r?.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
              setSt(await fetchState());
              if (smokeFlag('kvSmokeSignedOut')) window.kvSmokeSignedOut = false;
              afterSignIn();
            }, { primary: true, cls: 'first-signin' })),
      ];
    } else {
      const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'first-pin' });
      const repeat = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'first-pin2' });
      const save = btn(t('PIN festlegen'), async () => {
        if (pin.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
        await call('setPin', { current: null, next: pin.value }); // at least 6 characters, checked there (#475)
        setSt(await fetchState());
        toast(t('PIN gespeichert'));
        close();
      }, { primary: true, cls: 'first-pin-save' });
      repeat.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
      content = [
        h('p', {}, t('Mit einer App-PIN entsperrst du Keevault im Alltag, ohne dich jedes Mal neu bei Microsoft anzumelden. Sie schützt die App an deinem gerade nicht gesperrten PC. Mindestens 6 Zeichen.')),
        h('div', { class: 'grid2' }, field(t('Neue PIN'), pin), field(t('Wiederholen'), repeat)),
        buttons(
          st.requirePin ? null : btn(t('Später'), () => close(), { cls: 'first-pin-later' }),
          save),
      ];
      setTimeout(() => focusField(pin), 0);
    }
    body.replaceChildren(header(), ...content.filter(Boolean));
  };
  draw();
  return closed;
}
