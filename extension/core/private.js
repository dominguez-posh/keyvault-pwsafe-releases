// "Nur für mich" (#476): an entry of a shared vault that only its owner sees. Hiding only, no encryption – whoever can
// read the vault reads it with other tools. The owner is the Entra object ID of the person who set it (item
// `privateOwner`, tag `po`; the name in `privateOwnerName`, tag `pn`). Private entries live only in the vault's root
// folder. Every list of entries goes through visibleTo: the app, the extension, autofill, MCP and the browser bridge;
// only a "Verwalter" in admin mode with "Auch private Einträge anderer Benutzer anzeigen" on sees other people's.

import { t } from './i18n.js';
import { normalizeFolder } from './model.js';

export const isPrivate = (entry) => !!entry?.privateOwner;

/**
 * Whether `viewer` (object ID, '' when unknown) sees this entry or summary. `others`: true, or a function
 * (containerId → true) for the vaults where other people's private entries may be shown.
 */
export function visibleTo(entry, viewer, others = null) {
  if (!isPrivate(entry)) return true;
  if (viewer && entry.privateOwner === viewer) return true;
  return typeof others === 'function' ? !!others(entry.containerId) : others === true;
}

export const visibleSummaries = (list, viewer, others = null) => list.filter((s) => visibleTo(s, viewer, others));

/** An entry the viewer may not see looks like one that does not exist (no hint that it is there). */
export class HiddenEntryError extends Error {
  constructor() {
    super(t('Eintrag nicht gefunden'));
    this.name = 'HiddenEntryError';
    this.status = 404;
  }
}

export function requireVisible(entry, viewer, others = null) {
  if (!visibleTo(entry, viewer, others)) throw new HiddenEntryError();
  return entry;
}

export const ROOT_ONLY = () => t('Nur im Root-Ordner möglich – bitte verschieben, wenn die Funktion gewünscht ist.');

/** Private entries stay in the root folder: saving or moving one into a folder is refused (drag, Ctrl+X/V, dialog). */
export function requirePrivateRoot(item) {
  if (isPrivate(item) && normalizeFolder(item.folder)) {
    throw new Error(t('„{title}“ ist „Nur für mich“ und bleibt im Root-Ordner des Tresors. In Ordner lässt es sich nicht verschieben.', { title: item.title || '' }));
  }
}

/**
 * The privacy an entry is saved with. Saving never changes it on its own: without `privacy` the entry keeps what the
 * stored one has (`known`, its summary); only setPrivacy-like callers pass `privacy` ({ owner, name } or null).
 */
export function withPrivacy(item, known, privacy) {
  const p = privacy !== undefined ? privacy : known?.privateOwner ? { owner: known.privateOwner, name: known.privateOwnerName } : null;
  return { ...item, privateOwner: p?.owner || '', privateOwnerName: p?.owner ? p.name || '' : '' };
}

export const OWN_ONLY = () => t('Nur für eigene Einträge möglich');

/**
 * Who may set an entry to "Nur für mich" (#476 review): the person who created it (`createdBy`, the sign-in name that
 * the vault session writes and keeps on every later save) or a Verwalter of the vault. Otherwise any member with write
 * access could take a public entry away from everyone.
 */
export function mayMakePrivate(item, username, manager = false) {
  if (manager) return true;
  const me = String(username || '').trim().toLowerCase();
  return !!me && String(item?.createdBy || '').trim().toLowerCase() === me;
}

/** Lists show private entries first (the viewer's own, then other people's), the rest in the given order. */
export const privateFirst = (list) => [...list.filter(isPrivate), ...list.filter((s) => !isPrivate(s))];
