// The sidebar: views, the vault list with search and order, sync and location badges.

import { h, icon, iconButton, setChildren, toast, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { sharedNames, shownVaultHost } from '../../../extension/core/session-meta.js';
import { call } from './ipc.js';
import { panes } from './layout.js';
import { busyContainers, items, logos, st, ui } from './state.js';
import { notice } from './helpers.js';
import { renderDetail } from './detail.js';
import { DRAG_VAULT, draggedVault, orderedVaults, setDraggedVault, vaultDropTarget } from './dragdrop.js';
import { helpDialog } from './help.js';
import { renderList, visibleItems } from './list.js';
import { adminFootButton, applyViewClass, mainMenuButton, pimHeadButton } from './main-menu.js';
import { contextMenu } from './menus.js';
import { adminMode, deviceMode, modeSwitch } from './modes.js';
import { askPendingRecovery, pendingRecoveryVault } from './personal.js';
import { reloadAll } from './shell.js';
import { containerActions, containerMenu, refreshContainer } from './vault-menu.js';

// Vaults that fit in the sidebar without scrolling; with more, the list scrolls and a search appears above it.
const VAULTS_FIT = 5;

export function select(next) {
  // A new view starts without a type filter (the pills belong to the list they were chosen in).
  if (next.view !== undefined && (next.view !== ui.view || next.containerId !== ui.containerId)) ui.type = '';
  // Searching starts in the vault one is in again after switching ("All" is a deliberate choice per search).
  if (next.containerId !== undefined && next.containerId !== ui.containerId) ui.searchAll = false;
  // A new entry being written stays open while the user picks another vault or folder; the form takes it over.
  const keepNew = ui.editing === 'new' && !('selected' in next);
  Object.assign(ui, next, { editing: keepNew ? 'new' : null });
  if (ui.selected && !visibleItems().some((i) => i.key === ui.selected)) ui.selected = null;
  for (const k of ui.multi) if (!items.some((i) => i.key === k)) ui.multi.delete(k);
  renderSidebar();
  renderList();
  if (keepNew) syncNewEntryTarget();
  else renderDetail();
}

/**
 * New entry open while the user navigates: vault (sidebar) and folder (list) go straight into the form – the rest of
 * what was typed stays.
 */
export function syncNewEntryTarget() {
  if (ui.editing !== 'new') return;
  const pane = panes.detail;
  const vault = pane.querySelector('select[name=container]');
  if (vault && ui.containerId && [...vault.options].some((o) => o.value === ui.containerId) && vault.value !== ui.containerId) {
    vault.value = ui.containerId;
    vault.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const folder = pane.querySelector('[name=folder]');
  if (folder && ui.containerId) {
    const value = ui.folder || '';
    if (folder.tagName === 'SELECT' && ![...folder.options].some((o) => o.value === value)) folder.append(h('option', { value }, value));
    if (folder.value !== value) {
      folder.value = value;
      folder.dispatchEvent(new Event('input', { bubbles: true }));
      folder.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

// Where a personal vault may live: a synchronised cloud folder or a network drive (never only on this device).
export const REMOTE_KINDS = 'cloud network'.split(' ');
let sourceSeq = 0;
/**
 * Where a vault lives, as a small coloured mark before its icon: a blue "A" in the style of Azure for Key Vault, a drive for a
 * local file vault (View → "Speicherort" switches it off).
 */
function sourceBadge(c) {
  if (st.settings.sourceBadges === false) return null;
  const id = `src${++sourceSeq}`;
  const azure = c.kind !== 'file';
  const loc = c.location;
  if (!azure && REMOTE_KINDS.includes(loc?.kind)) return locationBadge(c, loc, id);
  const el = h('span', { class: `source-badge ${azure ? 'azure' : 'local'}`, title: azure ? t('In Azure Key Vault') : t('Lokale Datei'), 'aria-label': azure ? t('In Azure Key Vault') : t('Lokale Datei'), role: 'img' });
  el.innerHTML = azure
    ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><defs><linearGradient id="${id}a" x1="0" y1="1" x2="0.6" y2="0"><stop offset="0" stop-color="#0a4fa8"/><stop offset="1" stop-color="#2b8be6"/></linearGradient><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ea2ff"/><stop offset="1" stop-color="#1677e0"/></linearGradient></defs><path d="M3.4 19.5 9.9 4.3a.9.9 0 0 1 .83-.55h3.1L7.3 19.5z" fill="url(#${id}a)"/><path d="M12.9 9.4l7.7 10.1H8.7l4.1-4.6-1.6-2.6z" fill="url(#${id}b)"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa3b2"/><stop offset="1" stop-color="#5d6779"/></linearGradient></defs><rect x="3" y="6.5" width="18" height="11" rx="3" fill="url(#${id})"/><path d="M6.5 14.2h7" stroke="#fff" stroke-opacity=".5" stroke-width="1.3" stroke-linecap="round"/><circle cx="17.2" cy="14.2" r="1.3" fill="#3ddc84"/></svg>`;
  return el;
}

/** Small mark of the sync provider (own drawings in the providers' colours): OneDrive, iCloud, Dropbox, Google Drive, other clouds. */
function providerMark(provider, id) {
  const svg = (inner) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${inner}</svg>`;
  if (/onedrive/i.test(provider)) {
    return svg('<path d="M9.6 9.1a5.3 5.3 0 0 1 9.4 2.3 3.6 3.6 0 0 1 .5 7.1H9.2z" fill="#0364b8"/><path d="M5.6 18.5a3.9 3.9 0 0 1-.3-7.8 5 5 0 0 1 9.4-1.2 4.4 4.4 0 0 1 3.7 4.3 3.5 3.5 0 0 1-.4 4.7z" fill="#28a8ea"/>');
  }
  if (/icloud/i.test(provider)) {
    return svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ab2ff"/><stop offset="1" stop-color="#1e6fe0"/></linearGradient></defs><path d="M7 18.5h10.6a3.9 3.9 0 0 0 .6-7.75 5.8 5.8 0 0 0-11-1.7A4.75 4.75 0 0 0 7 18.5z" fill="#fff" stroke="url(#${id})" stroke-width="1.8"/>`);
  }
  if (/dropbox/i.test(provider)) {
    return svg('<path d="M7.5 3.5 3 6.4l4.5 2.9L12 6.4zm9 0L12 6.4l4.5 2.9L21 6.4zM3 12.2l4.5 2.9 4.5-2.9-4.5-2.9zm13.5-2.9L12 12.2l4.5 2.9 4.5-2.9zM7.6 16l4.4 2.9 4.4-2.9-4.4-2.8z" fill="#0061fe"/>');
  }
  if (/google/i.test(provider)) {
    return svg('<path d="M8.4 4h7.2l6 10.4h-7.2z" fill="#ffba00"/><path d="M8.4 4 2.4 14.4 6 20.6l6-10.4z" fill="#0f9d58"/><path d="M6 20.6h12l3.6-6.2H9.6z" fill="#4285f4"/>');
  }
  return svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9aa9bd"/><stop offset="1" stop-color="#5f7088"/></linearGradient></defs><path d="M6.8 19h11a4.2 4.2 0 0 0 .5-8.37A6 6 0 0 0 6.9 9.3 4.85 4.85 0 0 0 6.8 19z" fill="url(#${id})"/>`);
}

/**
 * Sync state of a cloud folder: problem (sync client not running, provider error), pending (offline – syncs later –,
 * file not yet in sync, syncing) or ok. → { level: 'problem' | 'pending' | 'ok' | '', text } (#15)
 */
export function syncState(loc) {
  if (loc?.kind !== 'cloud') return { level: '', text: '' };
  const provider = loc.provider || t('Cloud-Ordner');
  if (loc.clientRunning === false) return { level: 'problem', text: t('{provider} läuft nicht – nicht synchronisiert', { provider }) };
  if (loc.providerStatus === 'error' || loc.providerStatus === 'terminated') return { level: 'problem', text: t('Synchronisierung gestört') };
  if (loc.online === false || loc.providerStatus === 'offline') return { level: 'pending', text: t('offline – wird später synchronisiert') };
  if (loc.inSync === false || loc.providerStatus === 'syncing') return { level: 'pending', text: t('wird synchronisiert …') };
  return { level: 'ok', text: loc.inSync ? t('synchronisiert') : '' };
}

/** Above the list of a file vault in a cloud folder that does not sync: what is wrong and what to do (#15). */
export function syncNotice(container) {
  if (container?.kind !== 'file') return null;
  const loc = container.location;
  const s = syncState(loc);
  if (s.level === 'problem') {
    return notice(loc.clientRunning === false
      ? t('{provider} läuft nicht: Änderungen an diesem Tresor bleiben nur auf diesem Gerät und erreichen deine anderen Geräte nicht. Starte {provider} (Startmenü), dann gleicht er sich von selbst ab.', { provider: loc.provider || 'OneDrive' })
      : t('Die Synchronisierung dieses Ordners ist gestört – prüfe den Sync-Client ({provider}).', { provider: loc.provider || t('Cloud-Ordner') }), 'warn');
  }
  if (loc?.online === false) return notice(t('Kein Netzwerk – Änderungen an diesem Tresor werden synchronisiert, sobald du wieder online bist.'), 'info');
  return null;
}

/** Cloud folder (OneDrive, iCloud, Dropbox …) or network drive, with a dot when the file is not in sync. */
function locationBadge(c, loc, id) {
  const cloud = loc.kind === 'cloud';
  const s = syncState(loc);
  const problem = s.level === 'problem';
  const pending = s.level === 'pending';
  const state = s.text;
  const title = [cloud ? loc.provider || t('Cloud-Ordner') : t('Netzlaufwerk'), state].filter(Boolean).join(' · ');
  const el = h('span', { class: `source-badge ${cloud ? 'cloud' : 'network'} ${problem ? 'problem' : pending ? 'pending' : ''}`, title, 'aria-label': title, role: 'img' });
  el.innerHTML = cloud ? providerMark(loc.provider || '', id)
    : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa3c0"/><stop offset="1" stop-color="#4f6584"/></linearGradient></defs><rect x="3" y="4" width="18" height="9" rx="2.5" fill="url(#${id})"/><path d="M12 13v4M6 19h12" stroke="#4f6584" stroke-width="1.8" stroke-linecap="round"/><circle cx="17" cy="8.5" r="1.2" fill="#3ddc84"/></svg>`;
  return el;
}

export function containerIcon(c) {
  if (c.personal) return icon('user');
  if (logos.get(c.id)) return h('img', { class: 'container-logo', src: logos.get(c.id), alt: '' });
  if (c.kind === 'file') return icon('note');
  return icon(c.protected ? 'shield' : 'vault');
}

export function renderSidebar() {
  applyViewClass(); // admin colour and the brand change together
  const nav = (view, label, iconName, count) => h('button', {
    class: `nav ${ui.view === view && !ui.containerId ? 'active' : ''}`,
    dataset: { view },
    onclick: () => select({ view, containerId: null }),
  }, icon(iconName), h('span', { class: 'nav-label' }, label), h('span', { class: 'count' }, count));
  // The personal vault has its own place right below the views; the vault list shows the others.
  const sameName = sharedNames(st.containers);
  const vaultRow = (c) => {
    const refresh = iconButton('refresh', t('Aktualisieren'), (e) => {
      e.stopPropagation();
      refreshContainer(c, refresh);
    }, { disabled: c.locked && !c.error });
    refresh.classList.add('nav-refresh');
    refresh.dataset.container = c.id;
    refresh.classList.toggle('spinning', busyContainers.has(c.id));
    return h('div', { class: `nav-row ${ui.containerId === c.id ? 'active' : ''}`, oncontextmenu: (e) => contextMenu(e, containerActions(c)), ...vaultDropTarget(c),
      draggable: c.personal ? false : 'true', dataset: { vault: c.id },
      ondragstart: c.personal ? undefined : (e) => {
        if (e.target !== e.currentTarget) return;
        e.dataTransfer.setData(DRAG_VAULT, c.id);
        e.dataTransfer.effectAllowed = 'move';
        setDraggedVault(c.id);
      },
      ondragend: () => { setDraggedVault(null); } },
      h('button', {
        class: `nav ${ui.containerId === c.id ? 'active' : ''}`,
        title: [c.vaultUrl || c.path, c.error?.message, t('Rechtsklick: alle Funktionen')].filter(Boolean).join('\n'),
        onclick: () => select({ view: 'container', containerId: c.id }),
      // Personal vault: the person first, then where it lives (OneDrive, iCloud, Dropbox …); other vaults the other way round.
      }, ...(c.personal ? [containerIcon(c), sourceBadge(c)] : [sourceBadge(c), containerIcon(c)]), h('span', { class: 'nav-label' }, c.name,
        // Name from the vault itself, or two vaults with the same name (#479): the host tells them apart.
        shownVaultHost(c, sameName) ? h('span', { class: 'nav-host' }, shownVaultHost(c, sameName)) : null),
      c.error ? h('span', { class: 'badge danger' }, '!') : c.locked ? icon('lock', 13) : h('span', { class: 'count' }, c.count ?? '')),
      refresh);
  };
  const personal = st.containers.filter((c) => c.personal);
  const containers = orderedVaults(st.containers.filter((c) => !c.personal)).map(vaultRow);
  setChildren(panes.sidebar,
    h('div', { class: 'brand' }, h('img', { src: adminMode() ? '../assets/icon-admin.png' : '../assets/icon.png', alt: '' }),
      h('span', { class: `brand-name ${adminMode() ? 'admin' : ''}` }, h('span', {}, 'Keevault'), adminMode() ? h('span', { class: 'brand-admin' }, 'for Admins') : null),
      st.offline ? h('span', { class: 'badge warn', title: t('Letzter Stand: {date}', { date: formatDateTime(st.offlineAt) }) }, t('Offline')) : null,
      h('span', { class: 'spacer' }),
      // Admin mode: optional direct way to PIM (Settings → View), between the brand and the lock.
      adminMode() && st.settings.adminPim ? pimHeadButton() : null,
      iconButton('lock', t('Sperren'), () => call('lock')),
      mainMenuButton()),
    nav('all', deviceMode() ? t('Alle Assets') : t('Alle Einträge'), 'shield', items.filter((i) => (i.type === 'server') === deviceMode()).length),
    nav('favorites', t('Favoriten'), 'star', items.filter((i) => i.favorite && (i.type === 'server') === deviceMode()).length),
    deviceMode() ? null : nav('passkeys', t('Passkeys'), 'key', items.filter((i) => i.rpIds.length).length),
    personal.length ? h('div', { class: 'personal-slot' }, ...personal.map(vaultRow), recoveryDue()) : null,
    h('div', { class: 'nav-section' }, h('span', {}, t('Tresore')), h('span', { class: 'spacer' }), containers.length > 1 ? vaultFinder() : null,
      iconButton('plus', t('Tresor hinzufügen oder erstellen'), containerMenu)),
    containers.length ? vaultList(containers) : h('p', { class: 'muted small pad' }, t('Noch keine Tresore. Mit + hinzufügen oder erstellen.')),
    // Pinned to the bottom edge (sticky): stays reachable however many vaults the list above holds.
    h('div', { class: 'sidebar-foot' }, adminMode() ? modeSwitch() : null, h('button', { type: 'button', class: 'help-btn', title: t('Hilfe und Tipps (F1)'), onclick: helpDialog },
      h('span', { class: 'help-mark', 'aria-hidden': 'true' }, '?'), t('Hilfe')),
      // Admin mode next to Help (#23) – only once offered under Settings → View (and while it is on, to end it).
      // Demo: always there, so visitors find and try it (#309).
      st.settings.adminOffered || adminMode() || (st.demo && !st.smoke) ? adminFootButton() : null),
    !st.signedIn ? h('button', { class: 'btn small', style: { margin: '8px 10px' }, onclick: async () => {
      try {
        await call('signIn');
        await reloadAll();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }, icon('unlock', 14), t('Key-Vault-Tresore anmelden')) : null,
  );
}

/** The recovery key of the personal vault is not confirmed yet: stays until it is (#399). */
function recoveryDue() {
  const c = pendingRecoveryVault();
  return c ? h('button', { type: 'button', class: 'notice warn recovery-due', onclick: () => askPendingRecovery(c) }, icon('key', 14), t('Wiederherstellungsschlüssel bestätigen')) : null;
}

/**
 * The vaults in the sidebar: with more than VAULTS_FIT the list scrolls in its own area (thin scrollbar). The search
 * (magnifier in the section header, vaultFinder) filters the rows in place, so its field keeps the focus while typing.
 */
let filterVaults = () => {};
function vaultList(rows) {
  const many = rows.length > VAULTS_FIT;
  const list = h('div', { class: `sidebar-vaults ${many ? 'many' : ''}` }, ...rows);
  const empty = h('p', { class: 'muted small pad', hidden: true }, t('Kein Tresor gefunden'));
  const apply = () => {
    const q = ui.vaultQuery.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const name = row.querySelector('.nav-label')?.textContent.toLowerCase() || '';
      row.hidden = !!q && !name.includes(q);
      if (!row.hidden) shown++;
    }
    empty.hidden = shown > 0;
  };
  apply();
  filterVaults = apply;
  return h('div', { class: 'vault-block' }, list, empty);
}

/** Vault search: a quiet magnifier in the "Vaults" header; the field slides open on hover or click, Esc clears it. */
function vaultFinder() {
  const box = h('span', { class: `vault-find ${ui.vaultQuery ? 'open' : ''}` });
  const input = h('input', { type: 'search', placeholder: t('Tresore suchen'), 'aria-label': t('Tresore suchen'), value: ui.vaultQuery,
    oninput: (e) => {
      ui.vaultQuery = e.target.value;
      box.classList.toggle('open', !!ui.vaultQuery);
      filterVaults();
    },
    onkeydown: (e) => {
      if (e.key !== 'Escape') return;
      input.value = '';
      ui.vaultQuery = '';
      filterVaults();
      box.classList.remove('open');
      input.blur();
    } });
  input.addEventListener('blur', () => { if (!input.value) box.classList.remove('open'); });
  const button = iconButton('search', t('Tresore suchen'), () => { box.classList.add('open'); input.focus(); });
  box.append(input, button);
  return box;
}
