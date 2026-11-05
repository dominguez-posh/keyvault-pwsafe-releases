// Admin mode: switching it on and off, PIN dialogs.

import { h, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field } from './helpers.js';
import { renderDetail } from './detail.js';
import { renderList } from './list.js';
import { applyViewClass } from './main-menu.js';
import { fetchState, setSettingsRev, settingsRev } from './shell.js';
import { renderSidebar } from './sidebar.js';

/** Set, change or remove the app PIN; forced: the organization requires one and none is set yet. */
/** Admin mode on or off; the list, the New menu and the open entry follow at once. */
export async function setAdminMode(on, pin) {
  setSettingsRev(settingsRev + 1);
  st.settings = on ? await call('activateAdminMode', pin) : await call('deactivateAdminMode');
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
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'admin-pin', 'aria-label': t('App-PIN') });
  const { dialog } = modal(t('Admin-Modus aktivieren'), h('div', {},
    h('p', {}, t('Im Admin-Modus siehst du Assets (Server, VMs), Admin Center und Verbindungen. Bestätige mit deiner App-PIN.')),
    field(t('App-PIN'), pin)), [
    { label: t('Abbrechen') },
    { label: t('Aktivieren'), primary: true, onClick: async () => {
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
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn.primary')?.click(); });
  setTimeout(() => pin.focus(), 0);
}

export function pinDialog({ forced = false } = {}) {
  const current = st.pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' }) : null;
  const next = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  const repeat = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  const { close } = modal(st.pinSet ? t('PIN ändern') : t('PIN festlegen'), h('div', {},
    h('p', { class: 'muted' }, forced
      ? t('Eure Organisation verlangt eine PIN zum Entsperren von Keevault.')
      : t('Die PIN wird beim Entsperren abgefragt – so öffnet niemand die App an deinem gerade nicht gesperrten PC. Mindestens 4 Zeichen.')),
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
    } },
  ].filter(Boolean));
  void close;
  setTimeout(() => (current || next).focus(), 0);
}
