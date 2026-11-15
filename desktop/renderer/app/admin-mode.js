// Admin mode: switching it on and off, PIN dialogs.

import { h, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { focusField } from './focus.js';
import { setSt, st } from './state.js';
import { field, helloProofButton } from './helpers.js';
import { renderDetail } from './detail.js';
import { renderList } from './list.js';
import { applyViewClass } from './main-menu.js';
import { fetchState, setSettingsRev, settingsRev } from './shell.js';
import { renderSidebar } from './sidebar.js';
import { mpSetUp } from './master-password.js';

/** Set, change or remove the app PIN; forced: the organization requires one and none is set yet. */
/** Admin mode on or off; the list, the New menu and the open entry follow at once. */
export async function setAdminMode(on, pin) {
  setSettingsRev(settingsRev + 1);
  // #535: answer first, then assign. `st.settings = await …` fixed `st` before the wait; a reload that replaced st
  // meanwhile (setSt) kept the old settings, and the window showed admin mode off while it was on (or the reverse).
  const settings = on ? await call('activateAdminMode', pin) : await call('deactivateAdminMode');
  st.settings = settings;
  // Again after the answer: a state the main process sent while the PIN was still being checked is older (#23 race).
  setSettingsRev(settingsRev + 1);
  applyViewClass();
  renderSidebar();
  renderList();
  renderDetail();
  toast(on ? t('Admin-Modus aktiv') : t('Admin-Modus beendet'));
}

/** "Activate admin mode": confirmed with the app PIN – without a PIN it cannot be switched on. */
export function adminModeDialog() {
  // Demo (#309): switched on at once, no PIN asked (the smoke test keeps asking).
  if (st.demo && !st.smoke) {
    setAdminMode(true, '').catch((e) => toast(e.message, 'error'));
    return;
  }
  if (!st.pinSet) {
    modal(t('Admin-Modus aktivieren'), h('div', {},
      h('p', {}, t('Der Admin-Modus wird mit deiner App-PIN bestätigt. Lege zuerst eine PIN fest.'))), [
      { label: t('Abbrechen') },
      { label: t('PIN festlegen …'), primary: true, onClick: () => { setTimeout(() => pinDialog(), 0); } },
    ]);
    return;
  }
  // #537: the master password or the PIN of this device.
  const label = mpSetUp() ? t('Masterpasswort oder PIN') : t('App-PIN');
  const pin = h('input', { type: 'password', ...(mpSetUp() ? {} : { inputmode: 'numeric' }), autocomplete: 'off', class: 'admin-pin', 'aria-label': label });
  const { dialog } = modal(t('Admin-Modus aktivieren'), h('div', {},
    h('p', {}, mpSetUp()
      ? t('Im Admin-Modus siehst du Assets (Server, VMs), Admin Center und Verbindungen. Bestätige mit deinem Masterpasswort oder deiner PIN.')
      : t('Im Admin-Modus siehst du Assets (Server, VMs), Admin Center und Verbindungen. Bestätige mit deiner App-PIN.')),
    field(label, pin)), [
    { label: t('Abbrechen') },
    { label: t('Aktivieren'), primary: !st.unlock?.hello, onClick: async () => { // Lena: one primary button – Hello's
      try {
        await setAdminMode(true, pin.value);
        return true;
      } catch (e) {
        toast(e.message, 'error');
        pin.select();
        return false;
      }
    } },
  ]);
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn:last-child')?.click(); }); // "Aktivieren", primary or not
  // #537 stage 4: Windows Hello for this one switch, asked by the main process.
  const hello = helloProofButton(async (proof) => {
    try {
      await setAdminMode(true, proof);
      dialog.close();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }, { field: pin.closest('.field') });
  if (hello) pin.closest('.field')?.before(hello);
  focusField(pin);
}

export function pinDialog({ forced = false, passkeys = false, onSaved = null } = {}) {
  if (mpSetUp()) return devicePinDialog({ onSaved });
  const current = st.pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' }) : null;
  const next = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  const repeat = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  const { close } = modal(st.pinSet ? t('PIN ändern') : t('PIN festlegen'), h('div', {},
    h('p', { class: 'muted' }, passkeys
      ? t('Keevault fragt vor jeder Passkey-Nutzung nach deiner PIN – ohne PIN wird kein Passkey verwendet. Lege jetzt eine fest (mindestens 6 Zeichen).')
      : forced
      ? t('Eure Organisation verlangt eine PIN zum Entsperren von Keevault.')
      : t('Die PIN wird beim Entsperren abgefragt – so öffnet niemand die App an deinem gerade nicht gesperrten PC. Mindestens 6 Zeichen.')),
    current ? field(t('Aktuelle PIN'), current) : null,
    h('div', { class: 'grid2' }, field(t('Neue PIN'), next), field(t('Wiederholen'), repeat))), [
    forced ? null : { label: t('Abbrechen') },
    !forced && st.pinSet && !st.requirePin ? { label: t('PIN entfernen'), danger: true, onClick: async () => {
      await call('setPin', { current: current.value, next: null });
      toast(t('PIN entfernt'));
      setSt(await fetchState());
    } } : null,
    { label: t('Speichern'), primary: true, onClick: async () => {
      if (next.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
      await call('setPin', { current: current?.value, next: next.value });
      toast(t('PIN gespeichert'));
      setSt(await fetchState());
      onSaved?.();
    } },
  ].filter(Boolean));
  void close;
  setTimeout(() => (current || next).focus(), 0);
}

/**
 * #537: with the master password set up, the PIN is only a shortcut on this device (it wraps the device key). Set,
 * changed or removed with the master password – never with the PIN alone.
 */
function devicePinDialog({ onSaved = null } = {}) {
  const has = !!st.unlock?.pin;
  const current = h('input', { type: 'password', autocomplete: 'current-password', class: 'pin-mp' });
  const next = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'pin-next' });
  const repeat = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'pin-next2' });
  modal(has ? t('PIN ändern') : t('PIN festlegen'), h('div', {},
    h('p', { class: 'muted' }, t('Die PIN entsperrt Keevault nur auf diesem Gerät, zusätzlich zum Masterpasswort. Mindestens 6 Zeichen; nach 10 falschen PINs gilt nur noch das Masterpasswort.')),
    field(t('Masterpasswort'), current),
    h('div', { class: 'grid2' }, field(t('Neue PIN'), next), field(t('Wiederholen'), repeat))), [
    { label: t('Abbrechen') },
    has ? { label: t('PIN entfernen'), danger: true, onClick: async () => {
      await call('setPin', { current: current.value, next: null });
      setSt(await fetchState());
      toast(t('PIN entfernt'));
    } } : null,
    { label: t('Speichern'), primary: true, onClick: async () => {
      if (next.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
      await call('setPin', { current: current.value, next: next.value });
      setSt(await fetchState());
      toast(t('PIN gespeichert'));
      onSaved?.();
    } },
  ].filter(Boolean));
  setTimeout(() => focusField(current), 0);
}
