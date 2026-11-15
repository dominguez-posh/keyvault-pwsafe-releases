// First start (#515): the Microsoft sign-in first, then the master password (#537, required), then "Windows Hello
// aktivieren?" (recommended; the app PIN as the alternative) – earlier the App PIN (skippable) –, before the other wizards (personal
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
import { helloFirstStartStep } from './hello-unlock.js';
import { askSettingsImport } from './settings-file.js';

// Smoke runs show this step only when the first-start check asks for it, and may treat the demo as signed out to
// exercise the sign-in itself (desktop/smoke-first-start.js). Without st.smoke these flags do nothing.
const smokeFlag = (name) => !!st.smoke && window[name] === true;

/** Whether the first start begins with these steps: not in the demo (unchanged), not when both are done already. */
export function accountStepsDue() {
  if (st.smoke) return smokeFlag('kvSmokeAccountStep');
  return !st.demo && (!st.signedIn || !st.unlock?.migrated);
}

const signedIn = () => st.signedIn && !smokeFlag('kvSmokeSignedOut');

/** The two steps in one wizard. Resolves when it is closed; closing it skips what is left, the next wizards follow. */
export function accountWizard() {
  const s = { step: signedIn() && !smokeFlag('kvSmokeAccountStep') ? 1 : 0 };
  const body = h('div', { class: 'wizard first-start-wizard' });
  const { dialog, close } = modal(t('Willkommen bei Keevault'), body, []);
  dialog.classList.add('wizard-modal');
  const closed = new Promise((resolve) => dialog.addEventListener('close', () => resolve()));
  const steps = [t('Anmelden'), t('Masterpasswort'), t('Entsperren')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b.filter(Boolean));
  const btn = (label, onClick, { primary = false, cls = '' } = {}) => h('button', { type: 'button', class: `${primary ? 'btn primary' : 'btn'} ${cls}`.trim(), onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  // After the sign-in: done when the master password is set up already (and the smoke check didn't ask for that step).
  const afterSignIn = () => (st.unlock?.migrated && !smokeFlag('kvSmokeAccountStep') ? close() : go(1));
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
    } else if (s.step === 1) {
      // #537 E5: a new device with the configuration and the personal vault in OneDrive takes them with the master password.
      if (s.oneDrive === undefined) {
        s.oneDrive = null;
        // The usual step meanwhile; only a configuration found replaces it (nothing typed is lost in the usual case).
        call('oneDriveSetupStatus').then((r) => r || { found: false }, () => ({ found: false })).then((r) => { s.oneDrive = r; if (s.step === 1 && r.found) draw(); });
      }
      content = s.oneDrive?.found && !s.fresh ? adoptStep(s.oneDrive) : masterPasswordStep();
    } else {
      // #537 stage 3 (Lucas): Windows Hello recommended, the app PIN the alternative; the password only in this closure.
      const password = s.password;
      s.password = null;
      helloFirstStartStep({ password, buttons, btn, done: () => close(), body: (parts) => body.replaceChildren(header(), ...parts.filter(Boolean)) });
      return;
    }
    body.replaceChildren(header(), ...content.filter(Boolean));
  };

  /**
   * #537 E5: "Keevault-Konfiguration in OneDrive gefunden – übernehmen?" The master password opens the personal vault in
   * OneDrive, becomes the app's and opens the configuration; its vaults are offered as for an import (ticks). Then the
   * question for Windows Hello. "Neu einrichten" goes to the usual step.
   */
  const adoptStep = (found) => {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', class: 'first-od-mp' });
    const take = btn(t('Übernehmen'), async () => {
      const r = await call('adoptOneDriveSetup', { password: pw.value });
      setSt(r.state || await fetchState());
      if (r.error) toast(r.error, 'error');
      if (r.preview && await askSettingsImport(r.preview, t('Konfiguration übernehmen'))) setSt(await fetchState());
      await call('settingsCopyDecided').catch(() => {});
      toast(t('Persönlicher Tresor und Masterpasswort eingerichtet'));
      s.password = pw.value;
      go(2);
    }, { primary: true, cls: 'first-od-take' });
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') take.click(); });
    setTimeout(() => focusField(pw), 0);
    const date = found.exportedAt ? new Date(found.exportedAt).toLocaleString() : t('unbekannt');
    return [
      h('p', { class: 'first-od-found' }, t('Keevault-Konfiguration in OneDrive gefunden (von {device}, {date}) – übernehmen?', { device: found.device || t('unbekanntes Gerät'), date })),
      h('p', { class: 'muted small' }, t('Mit deinem Masterpasswort richtet Keevault deinen persönlichen Tresor, die Konfiguration und die Tresorliste auf diesem Gerät ein.')),
      field(t('Masterpasswort'), pw),
      buttons(btn(t('Neu einrichten'), () => { s.fresh = true; draw(); }, { cls: 'first-od-fresh' }), take),
    ];
  };

  /** #537 (E2): the master password is required for a new installation; how to unlock faster comes in the next step. */
  const masterPasswordStep = () => {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', class: 'first-mp' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', class: 'first-mp2' });
    const save = btn(t('Masterpasswort festlegen'), async () => {
      if (pw.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
      await call('setupMasterPassword', { password: pw.value }); // length checked there
      setSt(await fetchState());
      toast(t('Masterpasswort eingerichtet'));
      s.password = pw.value;
      go(2);
    }, { primary: true, cls: 'first-mp-save' });
    pw2.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    setTimeout(() => focusField(pw), 0);
    return [
      h('p', {}, t('Das Masterpasswort schützt Keevault: die App, deinen persönlichen Tresor, die Offline-Kopie und wichtige Einstellungen. Du brauchst es auf neuen Geräten. Mindestens {n} Zeichen.', { n: st.unlock?.minLength || 12 })),
      h('div', { class: 'grid2' }, field(t('Masterpasswort'), pw), field(t('Wiederholen'), pw2)),
      buttons(save),
    ];
  };

  draw();
  return closed;
}
