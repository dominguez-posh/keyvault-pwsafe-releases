// "Nur für mich" (#476) in the window: the entry menu in admin mode, the notice before it applies, the marker in the
// list and the switch "Auch private Einträge anderer Benutzer anzeigen" for Verwalter. What a person may see and do is
// decided in the main process (desktop/main/private.js, extension/core/private.js); this only offers it.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { isPrivate, mayMakePrivate, OWN_ONLY, ROOT_ONLY } from '../../../extension/core/private.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { adminMode } from './modes.js';
import { reloadAll } from './shell.js';

export const NOTICE = () => t('Der Eintrag wird nur dir angezeigt und für die anderen Mitglieder ausgeblendet. Er ist nicht zusätzlich verschlüsselt: Wer Zugriff auf den Tresor hat, kann ihn mit anderen Werkzeugen weiterhin lesen. Admins sehen ihn im Admin-Modus.');

const mine = (i) => !!st.account?.id && i.privateOwner === st.account.id;
/** Only shared Key Vault vaults know the owner as an Entra identity (file vaults: no menu item). */
const offered = (c) => c?.kind === 'keyvault' && !c.personal;
/** "Verwalter": role assignments on the vault (Key Vault Data Access Administrator). */
export const isManager = (c) => c?.kind === 'keyvault' && !!c.access?.manage;
export const managesAny = () => (st.containers || []).some(isManager);

export const PUBLIC_NOTICE = () => t('Der Eintrag wird wieder allen Mitgliedern des Tresors angezeigt. Auch frühere Versionen des Eintrags werden für alle sichtbar.');

/** Creator of entries loaded in this window (summaries don't carry it; Key Vault has no tag left for it). */
const creators = new Map();
export const noteCreator = (item) => { if (item?.key) creators.set(item.key, item.createdBy || ''); };
/** false only when the entry is known to be someone else's and the person is no Verwalter (the main process checks again). */
const mayOffer = (i, c) => !creators.has(i.key) || mayMakePrivate({ createdBy: creators.get(i.key) }, st.account?.username, isManager(c));

/** Entry menu, admin mode only: "Nur für mich" (greyed out in a subfolder or for other people's entries) or "Öffentlich für alle". */
export function privacyActions(i, c, canWrite) {
  if (!adminMode() || !offered(c) || i.type === 'server') return [];
  if (!isPrivate(i)) {
    const why = i.folder ? ROOT_ONLY() : !mayOffer(i, c) ? OWN_ONLY() : '';
    return [{ action: 'private-on', icon: 'lock', label: t('Nur für mich'), disabled: !canWrite || !!why, title: why,
      onClick: () => makePrivate(i, c) }];
  }
  // Own entries, or a Verwalter with other people's private entries shown (the main process checks again).
  if (!mine(i) && !(isManager(c) && st.settings.showOthersPrivate)) return [];
  return [{ action: 'private-off', icon: 'unlock', label: t('Öffentlich für alle'), disabled: !canWrite, onClick: () => makePublic(i) }];
}

/** The notice first; only "Nur für mich" in it applies the flag. An entry not loaded yet is checked here first. */
export async function makePrivate(i, c) {
  if (!creators.has(i.key)) {
    const [containerId, ...rest] = i.key.split('/');
    noteCreator(await call('item', containerId, rest.join('/')).catch(() => null));
  }
  if (!mayOffer(i, c)) return toast(OWN_ONLY(), 'error');
  modal(t('Nur für mich'), h('div', { class: 'private-notice' }, h('p', {}, NOTICE())), [
    { label: t('Abbrechen') },
    { label: t('Nur für mich'), primary: true, onClick: () => setPrivate(i, true) },
  ]);
  return undefined;
}

/** "Öffentlich für alle" also opens a notice first: the older versions become visible to everyone too. */
export function makePublic(i) {
  modal(t('Öffentlich für alle'), h('div', { class: 'private-notice' }, h('p', {}, PUBLIC_NOTICE())), [
    { label: t('Abbrechen') },
    { label: t('Öffentlich für alle'), primary: true, onClick: () => setPrivate(i, false) },
  ]);
}

async function setPrivate(i, on) {
  const [containerId, ...rest] = i.key.split('/');
  try {
    await call('setPrivate', containerId, rest.join('/'), on);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  toast(on ? t('„{title}“ ist jetzt nur für dich sichtbar', { title: i.title }) : t('„{title}“ ist wieder für alle sichtbar', { title: i.title }));
  await reloadAll();
}

/** List marker: lock plus "Nur für mich" for own entries, the owner's name for other people's. */
export function privateBadge(i) {
  if (!isPrivate(i)) return null;
  const own = mine(i);
  const text = own ? t('Nur für mich') : t('Privat: {name}', { name: i.privateOwnerName || t('anderes Mitglied') });
  return h('span', { class: `badge private ${own ? '' : 'others'}`, title: own ? NOTICE() : t('Privater Eintrag eines anderen Mitglieds'), dataset: { owner: own ? 'me' : 'other' } }, icon('lock', 11), text);
}
