// Admin tools: connecting to assets, admin centers, moving passkeys between logins.

import { h, icon, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { pickFilterBar, pickKindMatches } from '../../../extension/core/ui-item.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { items, st, ui } from './state.js';
import { containerName, writable } from './helpers.js';
import { splitKey } from './detail.js';
import { draggedPasskey } from './dragdrop.js';
import { isMicrosoftSummary, smallAvatar } from './icons.js';
import { reloadAll } from './shell.js';

export async function connectServer(containerId, id, method) {
  try {
    const r = await call('connectServer', { containerId, id, method });
    if (method === 'rdp') {
      toast(r.credentialGuard ? t('Remotedesktop gestartet – Keevault trägt das Passwort im Windows-Dialog ein (Credential Guard erlaubt keine gespeicherten Anmeldedaten).')
        : r.prompt ? t('Remotedesktop gestartet – bitte dort anmelden') : t('Remotedesktop gestartet'));
    }
    else if (method === 'ssh') toast(r.copied ? t('SSH gestartet – das Passwort liegt in der Zwischenablage (im Terminal mit Rechtsklick einfügen)') : t('SSH gestartet'));
    else if (method === 'mgmt') toast(t('Verwaltungsseite im Browser geöffnet'));
    else if (method === 'teamviewer') toast(r.copied ? t('TeamViewer geöffnet – das Passwort liegt in der Zwischenablage') : t('TeamViewer gestartet'));
    else toast(r.signIn ? t('Bastion geöffnet – die Browser-Erweiterung meldet dich an') : t('Bastion geöffnet – ohne Browser-Erweiterung bitte selbst anmelden'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// PIM "My roles" (activate eligible Entra roles) – the page aka.ms/pim leads to, opened directly so the sign-in can be
// handed to the browser extension (only admin center hosts are allowed, see main.js). SharePoint goes through the M365
// admin center, which knows the tenant.
// Shown as a panel in the entry: PIM on top, the rest grouped; each with its own symbol (dom.js "ac-…") in a colour
// close to the product's, so the centers are told apart at a glance.
export const ADMIN_LINKS = [
  { id: 'pim', name: 'PIM', url: 'https://portal.azure.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles', icon: 'ac-elevate', color: '#8661c5', title: t('Rolle mit Privileged Identity Management aktivieren') },
  { id: 'entra', name: 'Entra ID', url: 'https://entra.microsoft.com', icon: 'ac-id', color: '#0078d4', group: 'identity', host: 'entra.microsoft.com' },
  { id: 'defender', name: 'Defender', url: 'https://security.microsoft.com', icon: 'ac-shield', color: '#2d5bb9', group: 'identity', host: 'security.microsoft.com' },
  { id: 'purview', name: 'Purview', url: 'https://purview.microsoft.com', icon: 'ac-compliance', color: '#6b4fbb', group: 'identity', host: 'purview.microsoft.com' },
  { id: 'm365', name: 'Microsoft 365', url: 'https://admin.microsoft.com', icon: 'ac-apps', color: '#d83b01', group: 'm365', host: 'admin.microsoft.com' },
  { id: 'exchange', name: 'Exchange', url: 'https://admin.exchange.microsoft.com', icon: 'mail', color: '#0364b8', group: 'm365', host: 'admin.exchange.microsoft.com' },
  { id: 'teams', name: 'Teams', url: 'https://admin.teams.microsoft.com', icon: 'ac-people', color: '#5b5fc7', group: 'm365', host: 'admin.teams.microsoft.com' },
  { id: 'sharepoint', name: 'SharePoint', url: 'https://admin.microsoft.com/sharepoint', icon: 'ac-share', color: '#038387', group: 'm365', host: 'SharePoint Admin Center' },
  { id: 'intune', name: 'Intune', url: 'https://intune.microsoft.com', icon: 'ac-devices', color: '#0f7b6c', group: 'm365', host: 'intune.microsoft.com' },
  { id: 'azure', name: 'Azure Portal', url: 'https://portal.azure.com', icon: 'ac-cloud', color: '#0089d6', group: 'azure', host: 'portal.azure.com' },
];

/**
 * Passkey saved in the wrong entry: pick another login (writable vault) – entries of the same site and with the same
 * user name first, the best one preselected.
 */
export function movePasskeyDialog(item, passkey) {
  const user = String(passkey.userName || '').trim().toLowerCase();
  const hostOf = (rpId) => (h) => h === rpId || h.endsWith(`.${rpId}`) || rpId.endsWith(`.${h}`);
  const score = (i) => (i.hosts.some(hostOf(passkey.rpId)) ? 2 : 0) + (user && String(i.username || '').trim().toLowerCase() === user ? 1 : 0);
  const targets = items
    .filter((i) => i.type === 'login' && !(i.containerId === item.containerId && i.id === item.id) && writable(st.containers.find((c) => c.id === i.containerId) || {}))
    .sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));
  if (!targets.length) {
    toast(t('Kein anderer Login-Eintrag mit Schreibrechten vorhanden'), 'error');
    return;
  }
  // Search window like the asset links: best matches first (same site, same user name), typing filters, a click moves.
  // "Current vault" (the passkey's) by default, "All" and kinds above the list (#312).
  let chosen = targets[0].key;
  const search = h('input', { type: 'search', class: 'link-pick-search', placeholder: t('Eintrag suchen (Titel, Benutzer, Tresor) …'), 'aria-label': t('Eintrag suchen') });
  const list = h('div', { class: 'link-pick-list', role: 'listbox' });
  const filters = pickFilterBar({ onChange: () => draw() });
  const LIMIT = 200;
  const draw = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = targets.filter((i) => (filters.state.all || i.containerId === item.containerId)
      && pickKindMatches({ microsoft: isMicrosoftSummary(i), passkey: !!i.rpIds?.length, msAdmin: !!i.msAdmin }, filters.state.kind)
      && words.every((w) => [i.title, i.username, containerName(i.containerId)].join(' ').toLowerCase().includes(w)));
    if (!hits.some((i) => i.key === chosen)) chosen = hits[0]?.key || '';
    list.replaceChildren(...[
      ...hits.slice(0, LIMIT).map((i) => h('button', { type: 'button', role: 'option', class: `link-pick-row ${i.key === chosen ? 'on' : ''}`, 'aria-selected': String(i.key === chosen),
        onclick: () => { chosen = i.key; draw(); } },
      smallAvatar(i), h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, i.title),
        h('span', { class: 'link-pick-sub' }, [i.username, containerName(i.containerId)].filter(Boolean).join(' · '))),
      i.key === chosen ? icon('check', 14) : null)),
      hits.length ? null : h('p', { class: 'muted small link-pick-empty' }, t('Kein Eintrag gefunden.')),
      hits.length > LIMIT ? h('p', { class: 'muted small link-pick-empty' }, t('{count} weitere – Suche verfeinern', { count: hits.length - LIMIT })) : null,
    ].filter(Boolean));
  };
  search.addEventListener('input', draw);
  draw();
  modal(t('Passkey verschieben'), h('div', { class: 'link-pick-dialog' },
    h('p', {}, t('Passkey für {user} ({rpId}) in einen anderen Eintrag verschieben.', { user: passkey.userName || passkey.userDisplayName || t('(ohne Benutzername)'), rpId: passkey.rpId })),
    search, filters.el, list,
    h('p', { class: 'muted small' }, t('Der Passkey selbst bleibt gleich – die Anmeldung bei der Website funktioniert danach mit dem Ziel-Eintrag. Schneller: den Passkey auf einen Login in der Liste ziehen.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      if (!chosen) return false;
      return movePasskeyTo({ from: `${item.containerId}/${item.id}`, credentialId: passkey.credentialId }, chosen);
    } },
  ]);
  setTimeout(() => search.focus(), 0);
}

/** Whether entry i may take the dragged passkey: another writable login. */
export function passkeyFits(i, data = draggedPasskey) {
  return !!data && i.type === 'login' && i.key !== data.from && writable(st.containers.find((c) => c.id === i.containerId) || {});
}

/** A passkey dropped on a login in the list: one confirmation, then it moves. */
export async function dropPasskey(data, target) {
  if (!(await confirmDialog(t('Passkey verschieben'), t('Passkey nach „{title}“ verschieben?', { title: target.title }), { confirmLabel: t('Verschieben') }))) return;
  await movePasskeyTo(data, target.key);
}

async function movePasskeyTo(data, targetKey) {
  const [fromContainer, fromId] = splitKey(data.from);
  const [containerId, id] = splitKey(targetKey);
  try {
    await call('movePasskey', { from: { containerId: fromContainer, id: fromId }, to: { containerId, id }, credentialId: data.credentialId });
    toast(t('Passkey verschoben'));
    ui.selected = targetKey;
    await reloadAll();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/** Opens PIM or an admin center in the browser; the extension signs in with the entry's account. */
export async function openAdminLink(link, key) {
  try {
    const r = await call('openAdminCenter', { url: link.url, key });
    toast(r.signIn ? t('{center} geöffnet – die Browser-Erweiterung meldet dich an', { center: link.name }) : t('{center} geöffnet – ohne Browser-Erweiterung bitte selbst anmelden', { center: link.name }));
  } catch (e) {
    toast(e.message, 'error');
  }
}
