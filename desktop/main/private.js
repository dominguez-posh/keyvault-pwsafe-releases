// "Nur für mich" (#476) in the app: who is signed in (the owner of new private entries) and for which vaults the window
// shows other people's private entries. Filtering itself happens in the vault session (extension/core/private.js) for
// every caller – window, extension, browser bridge, MCP, Windows passkeys; only the window's API passes othersView().

import { t } from '../../extension/core/i18n.js';
import { mayMakePrivate, OWN_ONLY } from '../../extension/core/private.js';
import { auth, config, vault } from './state.js';

/** Entra object ID of the signed-in person ('' when nobody is signed in). */
export const viewerId = () => auth?.account?.localAccountId || '';
export const viewerName = () => auth?.account?.name || auth?.account?.username || '';

/** Key Vault vault where the person has "Verwalten" (role assignments: Data Access Administrator). */
export const isManager = (c) => c?.kind === 'keyvault' && !!c.access?.manage;

/** Only shared Key Vault vaults know the owner as an Entra identity; file vaults don't offer it. */
export const privacyOffered = (c) => c?.kind === 'keyvault' && !c.personal;

/**
 * Admin mode on and "Auch private Einträge anderer Benutzer anzeigen" switched on (#476): the vaults where the person
 * is Verwalter → function containerId → true (core/private.js `others`); otherwise null.
 */
export async function othersView() {
  const s = config.get();
  if (!s.adminTools || !s.showOthersPrivate) return null;
  const ids = new Set((await vault.containers()).filter(isManager).map((c) => c.id));
  return (containerId) => ids.has(containerId);
}

/**
 * Sets an entry to "Nur für mich" or back to "Öffentlich für alle" – only in admin mode. Setting: entries in the root
 * folder of a shared Key Vault vault that the person created (any entry for a Verwalter). Back: the owner, or a Verwalter with other people's private entries shown.
 */
export async function setPrivacy(containerId, id, on) {
  if (!config.get().adminTools) throw new Error(t('„Nur für mich“ lässt sich nur im Admin-Modus ändern.'));
  const c = await vault.container(containerId);
  if (!privacyOffered(c)) throw new Error(t('Diese Funktion gibt es für diesen Tresor nicht.'));
  const others = await othersView();
  const item = await vault.getItem(containerId, id, { fresh: true, others });
  if (on) {
    if (!viewerId()) throw new Error(t('Dafür musst du mit Microsoft angemeldet sein.'));
    if (item.privateOwner && item.privateOwner !== viewerId()) throw new Error(t('Der Eintrag gehört schon einem anderen Mitglied.'));
    if (item.folder) throw new Error(t('Nur im Root-Ordner möglich – bitte verschieben, wenn die Funktion gewünscht ist.'));
    // #476 review: only the creator of the entry, or a Verwalter – not every member with write access.
    if (!mayMakePrivate(item, auth?.account?.username, isManager(c))) throw new Error(OWN_ONLY());
    return vault.saveItem(containerId, item, { expectedVersion: item.version, privacy: { owner: viewerId(), name: viewerName() } });
  }
  if (item.privateOwner && item.privateOwner !== viewerId() && !(others && others(containerId))) {
    throw new Error(t('Nur Verwalter mit „Auch private Einträge anderer Benutzer anzeigen“ stellen fremde Einträge zurück.'));
  }
  return vault.saveItem(containerId, item, { expectedVersion: item.version, privacy: null });
}
