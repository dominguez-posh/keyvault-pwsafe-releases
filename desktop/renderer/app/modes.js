// Passwords or assets: the admin mode's switch, the folder namespaces of both sides and the type filter.

import { h, icon } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { explicitFolders, items, st, ui } from './state.js';
import { renderDetail } from './detail.js';
import { renderList } from './list.js';
import { clearSelection } from './multi.js';
import { renderSidebar } from './sidebar.js';

export const adminMode = () => st?.settings?.adminTools === true;
// Admin mode: the switch at the bottom of the sidebar shows either the passwords (logins, notes, cards, …) or the
// devices – cleanly apart, the list head says which.
export const deviceMode = () => adminMode() && ui.devices;
// Assets and secrets keep their own folders: empty asset folders are stored with this prefix (never shown), entry
// folders belong to the side of their entry. Folder actions only touch the side that is shown.
export const ASSET_FOLDERS = 'assets:';
export const folderScope = () => (deviceMode() ? 'assets' : 'secrets');
export const nsFolder = (p) => (deviceMode() && p ? ASSET_FOLDERS + p : p);
export const folderList = (id) => (explicitFolders.get(id) || [])
  .filter((f) => f.startsWith(ASSET_FOLDERS) === deviceMode()).map((f) => (deviceMode() ? f.slice(ASSET_FOLDERS.length) : f));
export const modeItems = (id) => items.filter((i) => i.containerId === id && (i.type === 'server') === deviceMode());

/** Sidebar bottom (admin mode): "Passwords | Devices" in the segment style of the menu. */
export function modeSwitch() {
  const choose = (devices) => {
    if (ui.devices === devices) return;
    ui.devices = devices;
    ui.type = '';
    if (devices && ui.view === 'passkeys') ui.view = 'all';
    ui.selected = null;
    ui.editing = null;
    clearSelection();
    renderSidebar();
    renderList();
    renderDetail();
  };
  const b = (devices, iconName, label) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(ui.devices === devices), class: ui.devices === devices ? 'on' : '',
    dataset: { mode: devices ? 'devices' : 'items' }, onclick: () => choose(devices) }, icon(iconName, 14), label);
  return h('div', { class: 'seg mode-switch', role: 'radiogroup', 'aria-label': t('Anzeigen') }, b(false, 'key', t('Passwörter')), b(true, 'external', t('Assets')));
}

/** Type pills above the list (only the kinds that occur, and only when there is more than one; not for devices). */
export function typePills(base) {
  if (deviceMode()) return null;
  const kinds = [
    ['login', t('Logins'), (i) => i.type === 'login'],
    ['passkey', t('Passkeys'), (i) => i.rpIds.length > 0],
    ['note', t('Notizen'), (i) => i.type === 'note'],
    ['card', t('Karten'), (i) => i.type === 'card'],
    ['certificate', t('Zertifikate'), (i) => i.type === 'certificate'],
  ].filter(([key, , test]) => !(key === 'passkey' && ui.view === 'passkeys' && !ui.containerId) && base.some(test));
  if (kinds.length < 2) return null;
  const pill = (key, label) => h('button', { type: 'button', role: 'tab', class: `pill ${ui.type === key ? 'on' : ''}`, 'aria-selected': String(ui.type === key), dataset: { type: key },
    onclick: () => { ui.type = key; renderList(); } }, label);
  return h('div', { class: 'pills', role: 'tablist', 'aria-label': t('Filter') }, pill('', t('Alle')), ...kinds.map(([key, label]) => pill(key, label)));
}

export const TYPE_TESTS = { login: (i) => i.type === 'login', passkey: (i) => i.rpIds.length > 0, note: (i) => i.type === 'note', card: (i) => i.type === 'card', certificate: (i) => i.type === 'certificate' };
