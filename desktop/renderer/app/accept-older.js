// #435: an older state of a secured file taken on purpose – only in admin mode. The dialog shows which state, what comes
// back and what goes; the main process checks everything again (token, wait, app PIN, passkey, name, unchanged file).

import { h, icon, toast, modal, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { ROLE_NAMES } from '../../../extension/core/members.js';
import { call } from './ipc.js';
import { ui } from './state.js';
import { field, notice } from './helpers.js';
import { reloadAll } from './shell.js';
import { adminMode } from './modes.js';

const list = (items) => h('ul', { class: 'accept-older-list' }, ...items.map((x) => h('li', {}, x)));

/** Button next to the refusal, admin mode only. */
export function acceptOlderButton(c) {
  if (!c?.olderState || !adminMode()) return null;
  return h('button', { class: 'btn', id: 'file-accept-older-btn', onclick: () => acceptOlderDialog(c) }, icon('history', 14), t('Älteren Stand annehmen …'));
}

export async function acceptOlderDialog(c) {
  let info;
  try {
    info = await call('acceptOlderPrepare', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
  const until = Date.now() + info.delayMs;
  const wait = h('p', { class: 'muted small', id: 'accept-older-wait' });
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    wait.textContent = left > 0 ? t('Annehmen ist in {seconds} Sekunden möglich.', { seconds: left }) : '';
    if (left > 0 && wait.isConnected !== false) setTimeout(tick, 500);
  };
  tick();
  const pin = h('input', { type: 'password', id: 'accept-older-pin', autocomplete: 'off', inputmode: 'numeric' });
  const name = h('input', { type: 'text', id: 'accept-older-name', autocomplete: 'off', spellcheck: 'false' });
  const result = h('div', { id: 'accept-older-result' });
  let checked = null;
  const body = h('div', { class: 'accept-older' },
    notice(t('Dieser Stand ist älter als der, den dieses Gerät schon gesehen hat. Nimm ihn nur an, wenn du ihn selbst zurückgespielt hast (Backup) oder ein Update verloren ging. Wurde die Datei ohne dein Wissen ersetzt, sag deiner IT Bescheid.'), 'warn'),
    h('table', { class: 'swap-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, t('Stand in der Datei')), h('td', {}, info.updated ? formatDateTime(info.updated) : t('unbekannt'), ' · ', t('Schlüssel-Version {version}', { version: info.fileKeyVersion }))),
      h('tr', {}, h('th', {}, t('Hier bekannt')), h('td', {}, t('Schlüssel-Version {version}', { version: info.knownKeyVersion }))),
      h('tr', {}, h('th', {}, t('Danach')), h('td', {}, t('Neuer Schlüssel (Version {version}) für alle aktiven Mitglieder', { version: info.knownKeyVersion + 1 }))))),
    h('h4', {}, t('Aktive Mitglieder danach')),
    list(info.members.map((m) => `${m.email} – ${t(ROLE_NAMES[m.role] || m.role)}`)),
    info.restored.length ? h('div', {}, h('h4', {}, t('Mitgliederänderungen von hier, die zurückkommen')), list(info.restored)) : null,
    info.noPasskey.length ? notice(t('Ohne Passkey in diesem Stand (müssen danach neu Zugriff anfragen): {list}', { list: info.noPasskey.join(', ') }), 'warn') : null,
    h('h4', {}, t('Was verloren geht')),
    info.lost === null
      ? h('p', { id: 'accept-older-lost' }, t('Auf diesem Gerät nicht feststellbar: der neuere Stand ist hier nicht entsperrt.'))
      : h('div', { id: 'accept-older-lost' }, h('p', {}, t('{count} Einträge sind neu oder geändert seit diesem Stand und gehen verloren:', { count: info.lost.length })), list(info.lost)),
    h('p', { class: 'muted small' }, t('Auf anderen Geräten nicht feststellbar: dort nicht gespeicherte Änderungen gehen verloren, und was dieses Gerät nie gesehen hat, kann es nicht zurückholen.')),
    field(t('App-PIN'), pin),
    result,
    field(t('Zum Bestätigen den Namen des Tresors eintippen: {name}', { name: info.name }), name),
    wait);
  return modal(t('Älteren Stand annehmen'), body, [
    { label: t('Abbrechen') },
    { label: t('Mit App-PIN und Passkey prüfen'), onClick: async () => {
      checked = await call('acceptOlderUnlock', info.token, pin.value);
      pin.value = '';
      result.replaceChildren(notice(t('Geprüft. {count} Versionen von entfernten oder abgelehnten Mitgliedern werden verworfen.', { count: checked.dropped }), checked.dropped ? 'warn' : 'info'));
      return false;
    } },
    { label: t('Älteren Stand annehmen'), danger: true, onClick: async () => {
      if (!checked) {
        toast(t('Bitte erst mit App-PIN und Passkey bestätigen.'), 'error');
        return false;
      }
      ui.containerId = await call('acceptOlderCommit', info.token, name.value);
      toast(t('Älterer Stand angenommen – neuer Schlüssel für alle aktiven Mitglieder'));
      await reloadAll();
      return true;
    } },
  ]);
}
