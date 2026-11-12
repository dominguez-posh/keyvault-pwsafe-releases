// #512: Windows Hello for the window lock – the button on the lock screen and the switch in the settings. The main
// process asks Windows Hello and decides; the window only asks for it.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field } from './helpers.js';
import { focusField } from './focus.js';

/** Lock screen of #507: "Mit Windows Hello entsperren" when switched on; the PIN stays below as the fallback. */
export function helloUnlockButton({ done, failed }) {
  if (!st.helloUnlock) return null;
  const button = h('button', { type: 'button', class: 'btn block window-hello', onclick: async () => {
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner' }), t('Windows Hello …'));
    try {
      await call('unlockWithHello');
      await done();
    } catch (e) {
      failed(e.message);
    }
  } }, icon('shield'), t('Mit Windows Hello entsperren'));
  return button;
}

/** Settings → Sicherheit: switched on only with the app PIN, off at once. */
export function helloSettingsPart() {
  if (st.platform !== 'win32' && !st.smoke) return null;
  const forbidden = !!st.settings?.enforced?.includes('windowHello'); // the organization switched it off
  const box = h('input', { type: 'checkbox', class: 'window-hello-setting', checked: !!st.windowHello, disabled: !st.opened || !st.pinSet || forbidden });
  const status = h('p', { class: 'muted small window-hello-status' }, forbidden ? t('Eure Organisation hat das Entsperren mit Windows Hello abgeschaltet') : st.pinSet
    ? t('Ist nur die Browser-Erweiterung entsperrt, öffnest du das Fenster mit Gesicht, Fingerabdruck oder der Windows-Hello-PIN. Die App-PIN bleibt immer als zweiter Weg.')
    : t('Dafür zuerst eine App-PIN festlegen – sie bleibt der zweite Weg.'));
  if (st.opened && st.pinSet && !forbidden) {
    call('helloStatus').then((s) => {
      if (!s.available && !s.on) {
        box.disabled = true;
        status.textContent = t('Windows Hello ist auf diesem Gerät nicht eingerichtet');
      }
    }).catch(() => {});
  }
  box.addEventListener('change', () => {
    if (!box.checked) {
      call('setWindowHello', { on: false }).then((s) => { setSt(s); toast(t('Windows Hello ausgeschaltet')); })
        .catch((e) => { box.checked = true; toast(e.message, 'error'); });
      return;
    }
    box.checked = false;
    const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'hello-pin', 'aria-label': t('App-PIN') });
    const { dialog } = modal(t('Windows Hello einschalten'), h('div', {},
      h('p', {}, t('Bestätige mit deiner App-PIN. Danach öffnet Windows Hello das gesperrte Fenster; die PIN bleibt immer als zweiter Weg.')),
      field(t('App-PIN'), pin)), [
      { label: t('Abbrechen') },
      { label: t('Einschalten'), primary: true, onClick: async () => {
        try {
          setSt(await call('setWindowHello', { on: true, pin: pin.value }));
          box.checked = true;
          toast(t('Windows Hello eingeschaltet'));
          return true;
        } catch (e) {
          toast(e.message, 'error');
          pin.select();
          return false;
        }
      } },
    ]);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn.primary')?.click(); });
    focusField(pin);
  });
  return h('div', {}, h('label', { class: 'inline' }, box, t('Fenster auch mit Windows Hello entsperren')), status);
}
