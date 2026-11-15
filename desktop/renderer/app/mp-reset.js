// #537 stage 6: "Masterpasswort vergessen?" on the lock screen – the recovery stick of the personal vault resets the
// master password (a real key change in the main process, desktop/main/mp-reset.js); the new recovery key is shown once
// and has to be confirmed. And the button in the protection dialog of the personal vault that adds such a stick.

import { h, modal, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { showRecoveryKey } from '../../../extension/core/ui-protect.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { field } from './helpers.js';
import { focusField } from './focus.js';
import { compromisedOption } from './member-key.js';

/**
 * Lock screen link, shown only when a recovery stick is there. done(): opens the app as after a correct master password;
 * confirmed: whether the new recovery key was confirmed (then the vault's mark goes once the app is open).
 */
export function stickResetLink({ done }) {
  const link = h('button', { type: 'button', class: 'linklike mp-reset-link', hidden: true, onclick: () => resetDialog(done) }, t('Masterpasswort vergessen?'));
  call('stickResetAvailable').then((on) => { link.hidden = !on; }).catch(() => {});
  return link;
}

function resetDialog(done) {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', class: 'mp-reset-new' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', class: 'mp-reset-new2' });
  const { dialog, close } = modal(t('Masterpasswort zurücksetzen'), h('div', {},
    h('p', {}, t('Mit deinem Wiederherstellungs-Schlüssel (FIDO-Stick) setzt du ein neues Masterpasswort. Dabei bekommt dein persönlicher Tresor einen neuen Schlüssel und einen neuen Wiederherstellungsschlüssel.')),
    h('p', { class: 'muted small' }, t('Passkeys des persönlichen Tresors müssen danach neu hinzugefügt werden, Windows Hello und die App-PIN neu eingerichtet. Auf deinen anderen Geräten gibst du einmal das neue Masterpasswort ein.')),
    h('div', { class: 'grid2' }, field(t('Neues Masterpasswort'), pw), field(t('Wiederholen'), pw2))), [
    { label: t('Abbrechen') },
    { label: t('Sicherheitsschlüssel verwenden'), primary: true, onClick: async () => {
      if (pw.value !== pw2.value) {
        toast(t('Die Passwörter stimmen nicht überein'), 'error');
        return false;
      }
      try {
        const r = await call('resetMasterPasswordWithStick', { password: pw.value });
        close();
        toast(t('Masterpasswort zurückgesetzt'));
        const confirmed = r.recoveryKey ? await showRecoveryKey(r.recoveryKey) : false;
        await done();
        if (confirmed && st.opened !== false) await call('confirmPersonalRecovery', r.id).catch(() => {});
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    } },
  ]);
  dialog.classList.add('mp-reset-dialog');
  focusField(pw);
}

/**
 * Konrad M1: removing a recovery stick is a real key change – the master password once more, then the new recovery key
 * is shown to confirm. Resolves when done or cancelled.
 */
export function removeRecoveryStickDialog(containerId, stick) {
  return new Promise((resolve) => {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', class: 'stick-remove-mp' });
    // #539 M3 (Konrad): a lost stick is as good as the master password – preselected: a new master password and new
    // memberships in shared vaults.
    const option = compromisedOption({ preselect: true });
    const pw1 = h('input', { type: 'password', autocomplete: 'new-password', class: 'stick-remove-new' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', class: 'stick-remove-new2' });
    const fresh = h('div', {}, field(t('Neues Masterpasswort'), pw1), field(t('Wiederholen'), pw2));
    option.element.addEventListener('change', () => { fresh.hidden = !option.checked(); });
    const { dialog, close } = modal(t('Wiederherstellungs-Schlüssel entfernen'), h('div', {},
      h('p', {}, t('„{label}“ kann das Masterpasswort danach nicht mehr zurücksetzen.', { label: stick?.label || t('Wiederherstellung') })),
      h('p', { class: 'muted small' }, t('Dafür bekommt dein persönlicher Tresor einen neuen Schlüssel. Der aktuelle und jeder spätere Stand des Tresors ist für den Stick dann verschlossen; ältere Kopien (z. B. im OneDrive-Versionsverlauf) öffnet er weiter mit ihrem alten Inhalt. Du bekommst einen neuen Wiederherstellungsschlüssel; Passkeys, Windows Hello und die App-PIN richtest du danach neu ein.')),
      h('p', { class: 'muted small' }, t('Ist der Stick verloren, kann ihn jemand wie dein Masterpasswort benutzen: Lass dann die Auswahl unten an – du legst ein neues Masterpasswort fest und bekommst neue Mitgliedschaften in geteilten Tresoren. Ohne sie bleibt das Masterpasswort.')),
      field(t('Masterpasswort'), pw), option.element, fresh), [
      { label: t('Abbrechen') },
      { label: t('Entfernen'), primary: true, onClick: async () => {
        try {
          if (option.checked() && pw1.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
          if (option.checked() && pw1.value === pw.value) throw new Error(t('Das neue Masterpasswort muss sich vom bisherigen unterscheiden'));
          const r = await call('removeRecoveryStick', containerId, stick?.id, pw.value, option.checked() ? pw1.value : null);
          close();
          if (option.checked()) await option.after();
          toast(t('Wiederherstellungs-Schlüssel entfernt'));
          if (r.recoveryKey && await showRecoveryKey(r.recoveryKey)) await call('confirmPersonalRecovery', r.id).catch(() => {});
          resolve(true);
          return true;
        } catch (e) {
          toast(e.message, 'error');
          pw.select();
          return false;
        }
      } },
    ]);
    dialog.classList.add('stick-remove-dialog');
    dialog.addEventListener('close', () => resolve(false));
    focusField(pw);
  });
}

/** Protection dialog of the personal vault: add a recovery stick (the main process asks the fresh master password). */
export async function addRecoveryStick(containerId) {
  await call('addRecoveryStick', containerId);
  toast(t('Wiederherstellungs-Schlüssel hinzugefügt'));
}

// ---------------------------------------------------------------- the reset log: once on every device
let noticeOpen = false;

/** A reset of the master password this device has not shown yet: one dialog naming date and device. → true when shown. */
export async function showMpResetNotices() {
  if (noticeOpen || !st.opened || document.querySelector('dialog[open]')) return false;
  noticeOpen = true;
  try {
    const list = await call('mpResetNotices').catch(() => []);
    if (!list.length) return false;
    await new Promise((resolve) => {
      const { dialog } = modal(t('Masterpasswort zurückgesetzt'), h('div', {},
        ...list.map((r) => h('p', { class: 'mp-reset-notice' }, t('Dein Masterpasswort wurde am {date} auf {device} mit einem Sicherheitsschlüssel zurückgesetzt.', { date: new Date(r.at).toLocaleString(), device: r.device || t('unbekanntes Gerät') }))),
        h('p', { class: 'muted small' }, t('Warst du das nicht, setze sofort ein neues Masterpasswort und prüfe die Wiederherstellungs-Schlüssel deines persönlichen Tresors.'))), [
        { label: t('Verstanden'), primary: true },
      ]);
      dialog.classList.add('mp-reset-notice-modal');
      dialog.addEventListener('close', () => resolve());
    });
    await call('mpResetsShown', list.map((r) => r.at)).catch(() => {});
    return true;
  } finally {
    noticeOpen = false;
  }
}
