// The list in the middle: its head, search, rows, the "New" menu.

import { h, icon, setChildren, toast, confirmDialog } from '../../../extension/core/dom.js';
import { unlockPanel } from '../../../extension/core/ui-protect.js';
import { t } from '../../../extension/core/i18n.js';
import { MAX_FOLDER_DEPTH, entryTemplate } from '../../../extension/core/model.js';
import { expiryState } from '../../../extension/core/health.js';
import { call } from './ipc.js';
import { panes, topActions, topSearch } from './layout.js';
import { explicitFolders, folderIconMap, items, logos, st, ui } from './state.js';
import { containerName, notice, writable } from './helpers.js';
import { dropPasskey, passkeyFits } from './admin-tools.js';
import { newItem, renderDetail } from './detail.js';
import { DRAG_PASSKEY, draggedPasskey, endDrag, setDraggedPasskey, startDrag } from './dragdrop.js';
import { secureUnlockPanel } from './file-vaults.js';
import { folderActions, folderRows, newFolderDialog } from './folders.js';
import { itemAvatar } from './icons.js';
import { itemActions } from './item-actions.js';
import { contextMenu } from './menus.js';
import { TYPE_TESTS, adminMode, deviceMode, folderList, typePills } from './modes.js';
import { clearSelection, selectRow } from './multi.js';
import { personalPinPrompt } from './personal.js';
import { protectCtx } from './protection.js';
import { reloadAll } from './shell.js';
import { syncNewEntryTarget, syncNotice } from './sidebar.js';
import { trashDialog } from './trash.js';
import { licenseBadge } from './vault-dialogs.js';
import { accessBadge, containerActions, featureAllowed, refreshContainer, roleMark } from './vault-menu.js';

export function visibleItems({ ignoreType = false } = {}) {
  if (ui.devices && !adminMode()) ui.devices = false;
  // Devices only with the switch on "Devices" (admin mode); otherwise the list holds the entries people sign in with.
  let list = deviceMode() ? items.filter((i) => i.type === 'server') : items.filter((i) => i.type !== 'server');
  if (!deviceMode() && !ignoreType && ui.type && TYPE_TESTS[ui.type]) list = list.filter(TYPE_TESTS[ui.type]);
  const q = ui.query.trim().toLowerCase();
  // Search scope: the current vault (default) or, switched to "All", every vault.
  const global = !!q && ui.searchAll;
  if (global) { /* all vaults */ } else if (ui.containerId) list = list.filter((i) => i.containerId === ui.containerId);
  else if (ui.view === 'favorites') list = list.filter((i) => i.favorite);
  else if (ui.view === 'passkeys') list = list.filter((i) => i.rpIds.length);
  if (q) {
    list = list.filter((i) => [i.title, i.username, i.folder, ...i.hosts, ...i.rpIds, containerName(i.containerId)]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  return [...list].sort((a, b) => a.title.localeCompare(b.title));
}

export function renderList() {
  const container = ui.containerId ? st.containers.find((c) => c.id === ui.containerId) : null;
  const title = container ? container.name : { all: deviceMode() ? t('Alle Assets') : t('Alle Einträge'), favorites: t('Favoriten'), passkeys: t('Passkeys') }[ui.view];
  const rowsEl = h('ul', { class: 'list' });
  let searchTimer = null;
  const search = h('input', { type: 'search', id: 'search', placeholder: t('Suchen (Titel, Benutzer, Website, Ordner)'), value: ui.query, oninput: (e) => {
    ui.query = e.target.value;
    // Debounced: typing into a list of thousands re-renders once, not per keystroke.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderRows, 80);
  } });
  let chunkObserver = null;
  const CHUNK = 120;
  // Large lists are built in slices as the user scrolls: elements or thunks (() => element) that are created on
  // demand, so 2,000 entries cost as much as 120 until they come into view.
  function renderChunked(nodes) {
    chunkObserver?.disconnect();
    const make = (n) => (typeof n === 'function' ? n() : n);
    let shown = Math.min(CHUNK, nodes.length);
    rowsEl.replaceChildren(...nodes.slice(0, shown).map(make));
    if (shown >= nodes.length) return;
    const sentinel = h('li', { class: 'row-more', 'aria-hidden': 'true' }, h('span', { class: 'spinner' }));
    rowsEl.append(sentinel);
    chunkObserver = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      const next = nodes.slice(shown, shown + CHUNK).map(make);
      shown += next.length;
      sentinel.before(...next);
      if (shown >= nodes.length) {
        sentinel.remove();
        chunkObserver.disconnect();
      }
    }, { rootMargin: '600px' });
    chunkObserver.observe(sentinel);
  }

  function row(i) {
    const draggable = !!container && writable(container);
    return h('li', {
      class: `row-item ${ui.selected === i.key ? 'active' : ''} ${ui.multi.has(i.key) ? 'multi' : ''}`,
      dataset: { key: i.key },
      oncontextmenu: (e) => contextMenu(e, itemActions(i)),
      draggable: draggable ? 'true' : false,
      ondragstart: draggable ? (e) => {
        // Dragging a selected row takes the whole selection along – selected folders included.
        startDrag(e, container, ui.multi.has(i.key) ? [...ui.multi] : [i.key], ui.multi.has(i.key) ? [...ui.multiFolders] : []);
      } : undefined,
      ondragend: draggable ? endDrag : undefined,
      // A passkey dragged out of an entry lands on this login (another writable login, not its own entry).
      ondragover: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_PASSKEY) || !passkeyFits(i)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('drop');
      },
      ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop'); },
      ondrop: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_PASSKEY)) return;
        e.preventDefault();
        e.currentTarget.classList.remove('drop');
        let data = null;
        try { data = JSON.parse(e.dataTransfer.getData(DRAG_PASSKEY)); } catch { /* not ours */ }
        setDraggedPasskey(null);
        if (data && passkeyFits(i, data)) dropPasskey(data, i);
      },
      onclick: (e) => {
      // Shift: range from the last clicked row (entries and folders); Ctrl: toggle; plain click: single selection.
      if (selectRow(e, `key:${i.key}`)) {
        if (e.ctrlKey || e.metaKey) ui.selected = i.key;
        ui.editing = null;
        renderRows();
        renderDetail();
        return;
      }
      clearSelection();
      ui.anchor = `key:${i.key}`;
      ui.selected = i.key;
      ui.editing = null;
      renderRows();
      renderDetail();
    } },
    itemAvatar(i),
    h('div', { class: 'row-text' },
      // Expired entries struck through, as KeePass shows them (#327).
      h('div', { class: 'row-title' }, expiryState(i.expires) === 'expired' ? h('span', { class: 'expired-title' }, i.title) : i.title,
        i.favorite ? icon('star', 12) : null,
        i.rpIds.length ? h('span', { class: 'badge passkey', title: t('Passkey') }, icon('key', 11)) : null,
        i.type === 'note' ? h('span', { class: 'badge' }, t('Notiz')) : null,
        i.type === 'card' ? h('span', { class: 'badge', title: t('Kreditkarte') }, icon('card', 11)) : null,
        i.type === 'certificate' ? h('span', { class: 'badge', title: t('Zertifikat') }, icon('certificate', 11)) : null,
        i.unprotected ? h('span', { class: 'badge warn', title: t('Dieser Eintrag ist nicht verschlüsselt') }, t('unverschlüsselt')) : null,
        expiryState(i.expires) === 'expired' ? h('span', { class: 'badge danger', title: t('Abgelaufen') }, icon('clock', 11), t('abgelaufen'))
          : expiryState(i.expires) === 'soon' ? h('span', { class: 'badge warn', title: t('Läuft bald ab') }, icon('clock', 11), t('läuft ab')) : null),
      h('div', { class: 'row-sub' }, [i.username || i.hosts[0], container ? null : containerName(i.containerId)].filter(Boolean).join(' · '))));
  }

  function renderRows() {
    const list = visibleItems();
    if (!list.length && !(container && folderList(container.id).length)) {
      rowsEl.replaceChildren(h('li', { class: 'empty' }, icon('search', 32), ui.query ? t('Keine Treffer') : deviceMode() ? t('Keine Assets') : t('Keine Einträge')));
      return;
    }
    if (container && !ui.query.trim()) {
      renderChunked(folderRows(container, list, row, renderRows));
      return;
    }
    if (container && ui.searchAll) {
      // Search across all vaults: hits grouped by vault, the current one first.
      const groups = new Map([[container.id, []]]);
      for (const i of list) groups.set(i.containerId, [...(groups.get(i.containerId) || []), i]);
      renderChunked([...groups].filter(([, entries]) => entries.length)
        .flatMap(([id, entries]) => [h('li', { class: 'folder-title' }, containerName(id)), ...entries.map((i) => () => row(i))]));
      return;
    }
    if (container && list.some((i) => i.folder)) {
      const groups = new Map();
      for (const i of list) groups.set(i.folder || '', [...(groups.get(i.folder || '') || []), i]);
      renderChunked([...groups].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .flatMap(([folder, entries]) => [h('li', { class: 'folder-title' }, folder || t('Ohne Ordner')), ...entries.map((i) => () => row(i))]));
      return;
    }
    renderChunked(list.map((i) => () => row(i)));
  }

  if (ui.folderOf !== ui.containerId) {
    ui.folder = '';
    ui.folderOf = ui.containerId;
  }
  if (container?.locked && !container.error) {
    topSearch.replaceChildren();
    topActions.replaceChildren();
    setChildren(panes.list,
      h('div', { class: 'list-head' }, listTitle(title, container)),
      h('div', { class: 'list-scroll' }, h('span', { class: 'spinner' })));
    call('protectionInfo', container.id).then((info) => {
      panes.list.querySelector('.list-scroll').replaceChildren(info.secure
        ? secureUnlockPanel(container, info)
        : unlockPanel(container, info, protectCtx, async () => { await reloadAll(); if (container.personal && !(await call('personalBound', container.id).catch(() => true))) personalPinPrompt(); }));
    }, (e) => panes.list.querySelector('.list-scroll').replaceChildren(notice(e.message)));
    return;
  }

  // "New" at the top right of the list: a click creates a login, the arrow offers the other kinds and a folder.
  const newButton = h('span', { class: 'new-split' },
    h('button', { type: 'button', class: 'new-main', title: t('Neuer Eintrag (Strg+N)'), onclick: () => (deviceMode() ? newItem('server', { type: 'server', server: { kind: 'windows' } }) : newItem('login')) },
      h('span', { class: 'new-plus' }, icon('plus', 15)), h('span', { class: 'new-label' }, t('Neu'))),
    h('button', { type: 'button', class: 'new-more', title: t('Was anlegen?'), 'aria-label': t('Was anlegen?'), onclick: (e) => {
      const r = e.currentTarget.closest('.new-split').getBoundingClientRect();
      contextMenu({ preventDefault() {}, clientX: r.left, clientY: r.bottom + 6 }, newMenuItems(container));
    } }, icon('chevronDown', 13)));
  topActions.replaceChildren();
  setChildren(panes.list,
    h('div', { class: 'list-head' }, container && logos.get(container.id) ? h('img', { class: 'container-logo large', src: logos.get(container.id), alt: '' }) : null,
      listTitle(title, container), deviceMode() ? h('span', { class: 'mode-badge', title: t('Es werden Assets angezeigt – unten links auf „Passwörter“ umschalten') }, icon('external', 13), t('Assets')) : null, newButton),
    syncNotice(container),
    container?.error ? notice(container.error.status !== 403 ? container.error.message
      : container.rbac === false
        ? t('{message}. Dieser Key Vault nutzt Zugriffsrichtlinien statt Azure RBAC: Stelle ihn unter „Zugriffskonfiguration“ auf „Azure RBAC“ um oder lege eine Zugriffsrichtlinie für dein Konto an.', { message: container.error.message })
        : t('{message}. Für Lesezugriff braucht dein Konto die Rolle „Key Vault Secrets User“, zum Bearbeiten „Key Vault Secrets Officer“. Besitzer oder Mitwirkender auf Subscription oder Ressourcengruppe reichen nicht – das sind keine Datenrollen.', { message: container.error.message })) : null,
    container?.error?.status === 403 && container.access?.manage !== false && container.rbac !== false ? h('button', { class: 'btn primary', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner' }), t('Rolle wird vergeben …'));
      try {
        await call('grantMyself', container.id, 'write');
        toast(t('Rolle „Key Vault Secrets Officer“ vergeben'));
        await reloadAll();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.replaceChildren(icon('user'), t('Mir selbst Zugriff geben (Bearbeiten)'));
      }
    } }, icon('user'), t('Mir selbst Zugriff geben (Bearbeiten)')) : null,
    container?.error && container.kind === 'keyvault' && [401, 403].includes(container.error.status) ? tenantMismatchNotice(container) : null,
    container?.error && container.kind === 'keyvault' ? h('details', { class: 'diagnosis' }, h('summary', {}, t('Technische Details')),
      h('dl', {},
        h('dt', {}, t('Antwort des Key Vaults')), h('dd', {}, container.error.detail || container.error.message),
        h('dt', {}, t('Tenant des Tokens')), h('dd', {}, container.tenantId || st.account?.tenantId || t('Standardverzeichnis')),
        h('dt', {}, t('Angemeldet als')), h('dd', {}, st.account?.username || '–'),
        h('dt', {}, t('Identität am Vault')), vaultIdentityCell(container),
        h('dt', {}, t('Rechte laut Azure (ARM)')), h('dd', {}, container.access
          ? Object.entries(container.access).filter(([, v]) => v === true).map(([k]) => k).join(', ') || t('keine')
          : container.accessError || t('nicht ermittelbar (Rolle „Leser“ fehlt oder Vault nur über Lighthouse sichtbar)')))) : null,
    container?.error?.code === 'TenantSignInRequired' ? h('button', { class: 'btn primary', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await call('signInTenant', container.error.tenantId);
        await reloadAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    } }, icon('unlock'), t('Im Tenant des Key Vaults anmelden')) : null,
    typePills(visibleItems({ ignoreType: true })),
    h('div', { class: 'list-scroll', oncontextmenu: (e) => {
      // Right-click on the empty area (not on an entry or folder, those have their own menus).
      if (e.target.closest('li.row-item')) return;
      contextMenu(e, listAreaActions(container));
    } }, rowsEl),
  );
  // In a vault: a switch between this vault (default) and all vaults; elsewhere the search already covers everything.
  const scope = container ? h('div', { class: 'search-scope', role: 'radiogroup', 'aria-label': t('Suchbereich') },
    ...[[false, t('Tresor'), t('Nur in „{vault}“ suchen', { vault: container.name })], [true, t('Alle'), t('In allen Tresoren suchen')]].map(([all, label, hint]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(ui.searchAll === all), class: ui.searchAll === all ? 'on' : '', title: hint,
      onclick: () => {
        if (ui.searchAll === all) return;
        ui.searchAll = all;
        renderList();
        const field = document.getElementById('search');
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
      },
    }, label))) : null;
  search.placeholder = deviceMode() ? t('Assets suchen (Name, Adresse, Ordner)')
    : container ? (ui.searchAll ? t('Alle Tresore durchsuchen') : t('In „{vault}“ suchen', { vault: container.name })) : t('Suchen (Titel, Benutzer, Website, Ordner)');
  topSearch.replaceChildren(h('div', { class: `search ${scope ? 'with-scope' : ''}` }, icon('search'), search, scope || h('kbd', { 'aria-hidden': 'true' }, t('Strg F'))));
  renderRows();
  if (container && !container.error) {
    call('folders', container.id).then((f) => {
      explicitFolders.set(container.id, f);
      renderRows();
    }, () => {});
    call('folderIcons', container.id).then((icons) => {
      if (JSON.stringify(icons) === JSON.stringify(folderIconMap.get(container.id) || {})) return;
      folderIconMap.set(container.id, icons);
      renderRows();
    }, () => {});
  }
}

/** Explains and offers to fix a vault whose trusted tenant differs from its subscription's tenant. */
function tenantMismatchNotice(container) {
  const box = h('div');
  call('vaultTenantCheck', container.id).then((x) => {
    if (!x.mismatch) return;
    const fix = h('button', { class: 'btn primary', onclick: async () => {
      if (!(await confirmDialog(t('Tenant des Key Vaults korrigieren'),
        t('Der Key Vault vertraut danach dem Tenant {to} (dem seiner Subscription) statt {from}. Zugriffe mit Konten aus {from} funktionieren danach nicht mehr; die Rollen auf dem Vault greifen ab dann. Die Änderung erfolgt mit deinen Azure-Rechten.', { from: x.vaultTenant, to: x.subscriptionTenant }),
        { confirmLabel: t('Korrigieren') }))) return;
      fix.disabled = true;
      fix.replaceChildren(h('span', { class: 'spinner' }), t('Wird korrigiert …'));
      try {
        await call('fixVaultTenant', container.id);
        toast(t('Tenant korrigiert – der Zugriff kann ein paar Minuten brauchen'));
        await reloadAll();
      } catch (e) {
        toast(e.message, 'error');
        fix.disabled = false;
        fix.replaceChildren(icon('wand'), t('Tenant des Key Vaults korrigieren'));
      }
    } }, icon('wand'), t('Tenant des Key Vaults korrigieren'));
    box.replaceChildren(notice(t('Ursache gefunden: Der Key Vault ist auf den Tenant {vault} eingestellt, seine Subscription gehört aber zum Tenant {sub}. Rollen auf dem Vault können so nie greifen – typisch, wenn er über Azure Lighthouse angelegt wurde.', { vault: x.vaultTenant, sub: x.subscriptionTenant }), 'warn'), fix);
  }, () => {});
  return box;
}

/** Which account Key Vault actually sees (guest or member), filled in asynchronously. */
function vaultIdentityCell(container) {
  const dd = h('dd', {}, h('span', { class: 'spinner' }));
  call('vaultIdentity', container.id).then((x) => dd.replaceChildren(
    `${x.guest ? t('Gast') : t('Mitglied')} · ${x.name || '–'} · ${t('Objekt-ID')} ${x.objectId} · ${t('Tenant')} ${x.tenantId}`,
  ), (e) => dd.replaceChildren(e.message));
  return dd;
}

/** What can be created here: entry types, plus a (sub)folder in a vault. */
function newMenuItems(container) {
  // The switch decides: "Devices" creates devices only, "Passwords" everything else (devices never mixed in).
  const kinds = deviceMode() ? [
    { action: 'new-server', icon: 'external', label: t('Neue VM / neuer Server'), onClick: () => newItem('server', { type: 'server', server: { kind: 'windows' } }) },
  ] : [
    { action: 'new-login', icon: 'key', label: t('Neues Passwort / Login'), onClick: () => newItem('login') },
    { action: 'new-note', icon: 'note', label: t('Neue sichere Notiz'), onClick: () => newItem('note') },
    { action: 'new-card', icon: 'card', label: t('Neue Kreditkarte'), onClick: () => newItem('card') },
    { action: 'new-certificate', icon: 'certificate', label: t('Neues Zertifikat'), onClick: () => newItem('certificate') },
    // Admin templates only in admin mode – for everyone else the menu stays as simple as possible.
    ...(adminMode() ? [
      '-',
      { action: 'new-microsoft', icon: 'globe', label: t('Neuer Microsoft-Login'), onClick: () => newItem('login', entryTemplate('microsoft', { msAdmin: true })) },
      { action: 'new-ad', icon: 'user', label: t('Neuer Active-Directory-Logon'), onClick: () => newItem('login', entryTemplate('ad')) },
      { action: 'new-sophos', icon: 'shield', label: t('Neuer Sophos-Login'), onClick: () => newItem('login', entryTemplate('sophos')) },
    ] : []),
  ];
  return [
    ...kinds,
    container ? '-' : null,
    container && featureAllowed(container, 'folders') && (ui.folder || '').split('/').filter(Boolean).length < MAX_FOLDER_DEPTH
      ? { action: 'new-folder', icon: 'folder-plus', label: ui.folder ? t('Neuer Unterordner') : t('Neuer Ordner'), disabled: !writable(container), onClick: () => newFolderDialog(container) } : null,
  ];
}

/** Right-click on the empty list area: create something here, the current folder's functions, select all, refresh. */
function listAreaActions(container) {
  const folder = container ? ui.folder || '' : '';
  const open = (f) => { ui.folder = f; renderList(); syncNewEntryTarget(); };
  const inFolder = folder
    ? folderActions(container, folder, items.filter((i) => i.containerId === container.id && (i.folder === folder || (i.folder || '').startsWith(`${folder}/`))).length, open)
      .filter((a) => a && a !== '-' && !['open-folder', 'subfolder'].includes(a.action))
      .map((a) => ({ ...a, label: `${a.label} – ${folder.split('/').pop()}` }))
    : [];
  const visible = [...document.querySelectorAll('.list-pane li.row-item[data-key]')].map((el) => el.dataset.key);
  return [
    ...newMenuItems(container),
    inFolder.length ? '-' : null,
    ...inFolder,
    folder ? { action: 'folder-up', icon: 'back', label: t('Übergeordneter Ordner'), onClick: () => open(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') } : null,
    '-',
    visible.length > 1 ? { action: 'select-all', icon: 'check', label: t('Alle auswählen'), onClick: () => {
      visible.forEach((k) => ui.multi.add(k));
      renderList();
      renderDetail();
    } } : null,
    container ? { action: 'refresh', icon: 'refresh', label: t('Aktualisieren'), disabled: container.locked && !container.error,
      onClick: () => refreshContainer(container, document.querySelector(`.nav-refresh[data-container="${CSS.escape(container.id)}"]`)) } : null,
    container ? { action: 'trash', icon: 'trash', label: t('Papierkorb'), onClick: () => trashDialog(container) } : null,
    container ? { action: 'vault-functions', icon: 'more', label: t('Tresor-Funktionen …'), onClick: () => {
      const row = document.querySelector(`.nav-refresh[data-container="${CSS.escape(container.id)}"]`)?.closest('.nav-row');
      const r = row?.getBoundingClientRect();
      contextMenu({ preventDefault() {}, clientX: r ? r.right - 8 : 300, clientY: r ? r.top : 200 }, containerActions(container));
    } } : null,
  ];
}

/** State badges next to the container name (functions: right-click in the sidebar). */
/** List heading: the full name (wraps instead of being cut off) with the vault badges on a line below it. */
function listTitle(title, container) {
  return h('div', { class: 'list-title' }, h('div', { class: 'title-row' },
    container ? roleMark(container) : null, h('h2', { title }, title), container ? containerBadges(container) : null));
}

function containerBadges(c) {
  return h('span', { class: 'head-badges' },
    accessBadge(c),
    licenseBadge(c),
    c.protected && c.kind !== 'file' ? h('span', { class: 'badge passkey', title: t('Zusätzlich verschlüsselt') }, icon('shield', 11)) : null);
}
