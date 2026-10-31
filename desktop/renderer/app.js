import { h, icon, iconButton, setChildren, toast, avatar, modal, confirmDialog, formatDateTime } from '../../extension/core/dom.js';
import { itemDetail, itemForm, generatorPanel } from '../../extension/core/ui-item.js';
import { DEFAULT_OPTIONS } from '../../extension/core/generator.js';
import { unlockPanel, manageDialog, enableDialog } from '../../extension/core/ui-protect.js';
import { importDialog } from '../../extension/core/ui-import.js';
import { ACCESS_LEVELS } from '../../extension/core/azure.js';
import { setLanguage, t, LANGUAGES, getLanguage, locale } from '../../extension/core/i18n.js';
import { pickImage, LOGO_MAX_CHARS } from '../../extension/core/image.js';
import { ROLE_NAMES, FILE_ROLES } from '../../extension/core/members.js';
import { MAX_FOLDER_DEPTH } from '../../extension/core/model.js';
import { expiryState, expiringEntries, daysUntil } from '../../extension/core/health.js';
import { healthDialog, accessReportDialog } from './reports.js';
import { notesForLanguage } from '../../extension/core/release-notes.js';
import * as progress from './progress.js';

// Calls that can take a moment show the progress card bottom right (progress.js); the main process reports
// done/total under the same id where it knows them. Dialogs with their own inline progress are not listed.
const SLOW_CALLS = { unlock: 'Entsperren …', refresh: 'Aktualisieren …', healthReport: 'Passwort-Check …', accessReport: 'Zugriffsbericht …', vaultInfo: 'Tresor-Infos werden geladen …', checkForUpdates: 'Suche nach Updates …' };

async function call(method, ...args) {
  const end = SLOW_CALLS[method] ? progress.begin(method, t(SLOW_CALLS[method])) : null;
  try {
    const r = await window.pwsafe.invoke(method, args);
    if (!r.ok) {
      const e = new Error(r.error.message);
      e.name = r.error.name;
      e.status = r.error.status;
      throw e;
    }
    return r.result;
  } finally {
    end?.();
  }
}

const root = document.getElementById('app');
const panes = { sidebar: h('aside', { class: 'sidebar' }), list: h('section', { class: 'list-pane' }), detail: h('section', { class: 'detail-pane' }) };
const ui = { view: 'all', containerId: null, selected: null, editing: null, editingItem: null, query: '', folder: '', folderOf: null, multi: new Set() };
const explicitFolders = new Map(); // containerId → created folders (also empty ones)
const logos = new Map(); // containerId → data URL | null (loaded once per session, refreshed on change)
const busyContainers = new Set(); // containerIds being loaded or reconciled right now (sidebar spinner)
const icons = new Map(); // item key → data URL (Key Vault lists only tags; icons are fetched on demand)
const iconQueue = [];
let iconWorkers = 0;

/** Loads entry icons of Key Vault entries in the background (4 at a time). */
function loadIcon(i, el) {
  iconQueue.push({ i, el });
  const next = async () => {
    const job = iconQueue.shift();
    if (!job) {
      iconWorkers--;
      return;
    }
    try {
      if (!icons.has(job.i.key)) {
        const [containerId, id] = splitKey(job.i.key);
        icons.set(job.i.key, (await call('item', containerId, id)).icon || '');
      }
      if (icons.get(job.i.key)) job.el.replaceWith(avatar(job.i.title, 'avatar', icons.get(job.i.key)));
    } catch {
      icons.set(job.i.key, '');
    }
    next();
  };
  while (iconWorkers < 4 && iconQueue.length) {
    iconWorkers++;
    next();
  }
}

function itemAvatar(i) {
  const known = i.icon || icons.get(i.key);
  const el = avatar(i.title, 'avatar', known || '');
  if (!known && i.hasIcon && !icons.has(i.key)) loadIcon(i, el);
  return el;
}

/** Logos of the visible containers; re-renders the sidebar once new ones arrived. */
async function loadLogos() {
  const missing = st.containers.filter((c) => !c.locked && !c.error && !logos.has(c.id));
  if (!missing.length) return;
  await Promise.all(missing.map(async (c) => {
    logos.set(c.id, await call('containerLogo', c.id).catch(() => null));
  }));
  if (missing.some((c) => logos.get(c.id))) {
    renderSidebar();
    if (ui.containerId && missing.some((c) => c.id === ui.containerId)) renderList();
  }
}
const progressListeners = new Set();
const LEVEL_LABEL = { read: 'Lesen', write: 'Bearbeiten', manage: 'Verwalten', none: 'Ohne Datenzugriff' };
let st = null;
let items = [];
let reloadTimer = null;

const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
const copy = (text, label = t('Wert')) => call('copy', text).then(() => toast(t('{label} kopiert', { label })));
const openUrl = (url) => call('openExternal', url);
const formatDate = (iso) => new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
const notice = (text, kind = 'error') => h('div', { class: `notice ${kind}` }, text);
const writable = (c) => c.access?.write !== false && !c.error && !c.locked;
const writableContainers = () => st.containers.filter(writable).map((c) => ({ id: c.id, name: c.name }));

const protectCtx = {
  info: (id) => call('protectionInfo', id),
  unlock: (id, params) => call('unlockContainer', id, params),
  unlockPasskey: (id) => call('unlockContainerPasskey', id),
  enable: (id, m) => call('enableProtection', id, m),
  update: (id, op) => call('updateProtection', id, op),
  addPasskey: (id, label) => call('addContainerPasskey', id, label),
  disable: (id) => call('disableProtection', id),
  lock: (id) => call('lockContainer', id),
  get passkeyAvailable() {
    return !!st?.passkeyAvailable;
  },
  get clientName() {
    return t('Windows');
  },
  get defaultLabel() {
    return `${st?.account?.name || t('Ich')} – ${t('Desktop-App')}`;
  },
};

window.pwsafe.onEvent((ev) => {
  if (ev.type === 'locked') {
    Object.assign(ui, { selected: null, editing: null, editingItem: null });
    ui.multi.clear();
    busyContainers.clear();
    items = [];
    render();
  } else if (ev.type === 'changed' && st?.opened) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadAll().catch(() => {}), 250);
  } else if (ev.type === 'link') {
    addContainerDialog(ev.url);
  } else if (ev.type === 'progress') {
    progress.onEvent(ev);
    for (const fn of progressListeners) fn(ev);
  } else if (ev.type === 'busy') {
    // A vault is being loaded or reconciled: its refresh icon spins (also set when the sidebar is re-rendered).
    if (ev.busy) busyContainers.add(ev.containerId);
    else busyContainers.delete(ev.containerId);
    for (const b of panes.sidebar.querySelectorAll('.nav-refresh')) b.classList.toggle('spinning', busyContainers.has(b.dataset.container));
  } else if (ev.type === 'windows-request') {
    checkWindowsRequests();
  } else if (ev.type === 'generator') {
    generatorDialog();
  } else if (ev.type === 'health') {
    if (st?.opened) healthDialog(reportCtx());
  } else if (ev.type === 'access') {
    if (st?.opened) accessReportDialog(reportCtx());
  } else if (ev.type === 'update') {
    progress.fromUpdate(ev.state);
    for (const fn of updateListeners) fn(ev.state);
  } else if (ev.type === 'checkUpdates') {
    updateDialog();
  } else if (ev.type === 'updateOffer') {
    updateDialog(ev.state);
  }
});

// ---------------------------------------------------------------- passkey requests from Windows

const windowsDialogs = new Map(); // request id → close()

async function checkWindowsRequests() {
  let requests;
  try {
    requests = await call('windowsRequests');
  } catch {
    return;
  }
  const ids = new Set(requests.map((r) => r.id));
  for (const [id, close] of windowsDialogs) {
    if (!ids.has(id)) {
      close();
      windowsDialogs.delete(id);
    }
  }
  const lockedNotice = document.getElementById('windows-waiting');
  if (lockedNotice) lockedNotice.hidden = !requests.length;
  for (const r of requests) {
    if (r.locked || windowsDialogs.has(r.id)) continue;
    windowsDialogs.set(r.id, windowsDialog(r));
  }
}

function windowsDialog(r) {
  const decide = async (decision) => {
    windowsDialogs.delete(r.id);
    await call('windowsDecision', r.id, decision);
    if (!decision.cancel) toast(r.kind === 'create' ? t('Passkey gespeichert') : t('Angemeldet'));
    reloadAll().catch(() => {});
  };
  const head = h('div', { class: 'unlock-head' }, icon('key', 28), h('div', {},
    h('h3', {}, r.rpName || r.rpId), h('div', { class: 'muted small' }, t('Anfrage von Windows · {rpId}', { rpId: r.rpId }))));
  const lockedHint = r.lockedContainers?.length
    ? notice(t('Gesperrt: {names} – entsperre den Tresor, wenn der Passkey dort liegt.', { names: r.lockedContainers.join(', ') }), 'info') : null;
  let body;
  let buttons;
  if (r.kind === 'get') {
    body = h('div', {}, head, lockedHint,
      r.candidates.length
        ? [h('p', {}, t('Mit welchem Passkey möchtest du dich anmelden?')), ...r.candidates.map((c) => h('button', { type: 'button', class: 'choice', onclick: () => {
          close();
          decide({ containerId: c.containerId, itemId: c.itemId, credentialId: c.credentialId }).catch((e) => toast(e.message, 'error'));
        } }, icon('user'), h('span', {}, c.userName || t('(ohne Benutzername)')), h('span', { class: 'muted small' }, `${c.title} · ${c.container}`)))]
        : h('p', {}, t('Im Tresor ist kein passender Passkey gespeichert.')));
    buttons = [{ label: t('Abbrechen'), onClick: () => decide({ cancel: true }) }];
  } else {
    const container = h('select', {}, ...r.containers.map((c) => h('option', { value: c.id, selected: c.id === st.settings.defaultContainer }, c.name)));
    const title = h('input', { value: r.rpName || r.rpId });
    const existing = h('select', {}, h('option', { value: '' }, t('Neuer Eintrag')),
      ...r.logins.map((l) => h('option', { value: `${l.containerId}|${l.id}` }, `${l.title}${l.username ? ` – ${l.username}` : ''} (${l.container})`)));
    body = h('div', {}, head, lockedHint,
      h('p', {}, t('Passkey für {user} in Keevault speichern?', { user: r.user?.name || r.user?.displayName || t('dieses Konto') })),
      r.excluded ? notice(t('Für dieses Konto ist bereits ein Passkey im Tresor gespeichert. Die Website lehnt einen zweiten vermutlich ab.'), 'warn') : null,
      r.containers.length ? [
        field(t('Speichern in'), existing),
        field(t('Tresor'), container),
        field(t('Titel'), title),
      ] : notice(t('Kein Tresor mit Schreibrechten verfügbar.')));
    existing.addEventListener('change', () => {
      container.disabled = !!existing.value;
      title.disabled = !!existing.value;
    });
    buttons = [
      { label: t('Abbrechen'), onClick: () => decide({ cancel: true }) },
      { label: t('Passkey speichern'), primary: true, onClick: async () => {
        if (!r.containers.length) return false;
        const [cid, itemId] = existing.value ? existing.value.split('|') : [container.value, ''];
        await decide({ containerId: cid, itemId, title: title.value });
        return true;
      } },
    ];
  }
  const { dialog, close } = modal(t('Passkey'), body, buttons);
  // Closing with Esc or × cancels the request.
  dialog.addEventListener('close', () => {
    if (windowsDialogs.has(r.id)) decide({ cancel: true }).catch(() => {});
  });
  return close;
}
window.addEventListener('kvpwsafe-refresh', () => reloadAll());

async function render() {
  st = await call('state');
  setLanguage(st.settings.language);
  document.title = 'Keevault';
  document.body.dataset.ready = '1';
  // Installed version, always visible at the bottom right.
  let versionTag = document.getElementById('app-version');
  if (!versionTag) document.body.append(versionTag = h('button', { id: 'app-version', type: 'button', onclick: () => updateDialog() }));
  versionTag.textContent = `Keevault ${st.version}`;
  versionTag.title = t('Nach Updates suchen …');
  const firstRun = !st.hasFiles && !st.settings.entraUsed && !st.settings.enforced.includes('tenantId') && !st.settings.policyContainers.length;
  if (!st.opened) return firstRun ? renderSetup() : renderLocked();
  await loadItems();
  const shell = h('div', { class: 'shell' }, panes.sidebar, panes.list, panes.detail);
  root.replaceChildren(shell);
  setupSplitters(shell);
  renderSidebar();
  renderList();
  checkWindowsRequests();
  loadLogos();
  if (st.requirePin && !st.pinSet && !document.querySelector('dialog[open]')) pinDialog({ forced: true });
  return renderDetail();
}

// ---------------------------------------------------------------- resizable panes

const PANE_DEFAULTS = { sidebar: 250, list: 380 };
const PANE_LIMITS = { sidebar: [180, 420], list: [260, 720] };
const DETAIL_MIN = 340;

function paneWidths() {
  try {
    return { ...PANE_DEFAULTS, ...JSON.parse(localStorage.getItem('paneWidths') || '{}') };
  } catch {
    return { ...PANE_DEFAULTS };
  }
}

/** Two drag handles between sidebar, list and detail; widths are remembered, double-click restores the default. */
function setupSplitters(shell) {
  const widths = paneWidths();
  const apply = () => {
    // Keep room for the detail pane when the window is narrow.
    const room = Math.max(0, shell.clientWidth - DETAIL_MIN);
    const sidebar = Math.min(Math.max(widths.sidebar, PANE_LIMITS.sidebar[0]), PANE_LIMITS.sidebar[1]);
    const list = Math.max(PANE_LIMITS.list[0], Math.min(widths.list, PANE_LIMITS.list[1], room > 0 ? room - sidebar : Infinity));
    shell.style.setProperty('--sidebar-w', `${sidebar}px`);
    shell.style.setProperty('--list-w', `${list}px`);
    handles.sidebar.style.left = `${sidebar}px`;
    handles.list.style.left = `${sidebar + list}px`;
  };
  const save = () => {
    try { localStorage.setItem('paneWidths', JSON.stringify(widths)); } catch {}
  };
  const handle = (pane) => {
    const el = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', title: t('Breite ziehen – Doppelklick setzt zurück') });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      shell.classList.add('resizing');
      const startX = e.clientX;
      const start = widths[pane];
      const move = (ev) => {
        widths[pane] = Math.round(start + ev.clientX - startX);
        apply();
      };
      const up = () => {
        el.classList.remove('dragging');
        shell.classList.remove('resizing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        // Store what is actually shown (after the limits).
        widths.sidebar = parseInt(shell.style.getPropertyValue('--sidebar-w'), 10);
        widths.list = parseInt(shell.style.getPropertyValue('--list-w'), 10);
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => {
      widths[pane] = PANE_DEFAULTS[pane];
      apply();
      save();
    });
    return el;
  };
  const handles = { sidebar: handle('sidebar'), list: handle('list') };
  shell.append(handles.sidebar, handles.list);
  apply();
  new ResizeObserver(apply).observe(shell);
}

async function loadItems() {
  items = await call('items');
}

async function reloadAll() {
  st = await call('state');
  if (!st.opened) {
    expiryReminded = false;
    return render();
  }
  await loadItems();
  expiryReminder();
  if (!root.querySelector('.shell')) return render();
  renderSidebar();
  renderList();
  loadLogos();
  return renderDetail();
}

// ---------------------------------------------------------------- setup / locked

function languageSelect() {
  return h('select', { class: 'lang-select', title: t('Sprache'), onchange: async (e) => {
    await call('updateSettings', { language: e.target.value });
    render();
  } }, ...Object.entries(LANGUAGES).map(([k, label]) => h('option', { value: k, selected: st.settings.language === k }, k === 'auto' ? t(label) : label)));
}

function splash(...children) {
  root.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'card' },
    h('div', { class: 'card-top' }, h('img', { src: '../assets/icon.png', class: 'splash-logo', alt: '' }), languageSelect()), ...children)));
}

function renderSetup(error) {
  const entraCard = h('button', { class: 'option-card', onclick: async () => {
    entraCard.disabled = true;
    entraCard.querySelector('.muted').replaceChildren(h('span', { class: 'spinner' }), st.signInMode === 'windows' ? t('Anmeldung mit deinem Windows-Konto …') : t('Anmeldung im Browser …'));
    try {
      const r = await call('unlock', { entra: true });
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      await render();
    } catch (e) {
      renderSetup(e.message);
    }
  } }, icon('vault', 22), h('div', {},
    h('b', {}, t('Azure Key Vault (Microsoft Entra ID)')),
    h('div', { class: 'muted small' }, t('Für Unternehmen: Anmeldung mit dem Arbeitskonto, Teilen über Azure-Rollen, Audit-Log. Deine Key Vaults werden automatisch gesucht.'))));
  splash(
    h('h1', {}, t('Keevault einrichten')),
    h('p', { class: 'muted' }, t('Wo sollen deine Passwörter und Passkeys liegen?')),
    error ? notice(error) : null,
    entraCard,
    h('button', { class: 'option-card', onclick: createFileDialog }, icon('note', 22), h('div', {},
      h('b', {}, t('Lokale Datei (wie KeePass)')),
      h('div', { class: 'muted small' }, t('Verschlüsselte Datei, abgesichert mit Passkey und/oder Masterpasswort – auch auf einem Netzlaufwerk für mehrere Benutzer.')))),
    h('button', { class: 'linklike', onclick: openFile }, t('Vorhandene Datei öffnen …')),
  );
}

async function openFile() {
  try {
    const id = await call('openFile');
    if (!id) return;
    if (!st.opened) await call('unlock', { entra: false });
    ui.containerId = id;
    ui.view = 'container';
    await render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderLocked(error) {
  const entra = h('button', { class: 'btn primary block', onclick: () => open(true, entra) }, icon('unlock'), t('Mit Microsoft Entra ID entsperren'));
  const local = h('button', { class: 'btn block', onclick: () => open(false, local) }, icon('note'), t('Nur Datei-Tresore öffnen'));
  const pin = st.pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN'), class: 'pin-input', onkeydown: (e) => {
    if (e.key === 'Enter') open(true, entra);
  } }) : null;
  async function open(withEntra, button) {
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner' }), withEntra ? (st.signInMode === 'windows' ? t('Anmeldung mit deinem Windows-Konto …') : t('Anmeldung im Browser …')) : t('Öffnen …'));
    try {
      if (pin) await call('verifyPin', pin.value);
      const r = await call('unlock', { entra: withEntra });
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      if (r.offline) toast(t('Kein Netzwerk – Offline-Stand vom {date}, nur lesen', { date: formatDateTime(r.offlineAt) }), 'warn');
      const firstLockedFile = r.containers.find((c) => c.kind === 'file' && c.locked);
      if (!withEntra && firstLockedFile) {
        ui.containerId = firstLockedFile.id;
        ui.view = 'container';
      }
      await render();
    } catch (e) {
      renderLocked(e.message);
    }
  }
  splash(
    h('h1', {}, t('Tresor gesperrt')),
    h('p', { class: 'muted' }, st.signInMode === 'windows'
      ? t('Anmeldung mit deinem Windows-Konto (Single Sign-on) – falls nötig erscheint der Microsoft-Anmeldedialog.')
      : t('Melde dich mit deinem Arbeitskonto an. Die Anmeldung öffnet sich im Standardbrowser.')),
    error ? notice(error) : null,
    h('div', { id: 'windows-waiting', class: 'notice info', hidden: true }, t('Windows wartet auf einen Passkey – entsperre Keevault, um fortzufahren.')),
    pin ? field(t('PIN'), pin) : null,
    st.pinSet ? null : h('p', { class: 'muted small' }, t('Tipp: Mit einer PIN (unter Einstellungen) entsperrst du ohne neues Microsoft-Fenster – deine Tresore erscheinen sofort.')),
    entra,
    st.hasFiles ? local : null,
    h('div', { class: 'card-links' },
      h('button', { class: 'linklike', onclick: settingsDialog }, t('Einstellungen')),
      h('button', { class: 'linklike', onclick: async () => {
        await call('signOut');
        toast(t('Abgemeldet – beim nächsten Entsperren Konto wählen'));
      } }, t('Anderes Konto'))),
  );
  setTimeout(() => (pin || entra).focus(), 0);
  checkWindowsRequests();
}

/** Set, change or remove the app PIN; forced: the organization requires one and none is set yet. */
function pinDialog({ forced = false } = {}) {
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
      st = await call('state');
    } } : null,
    { label: t('Speichern'), primary: true, onClick: async () => {
      if (next.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
      await call('setPin', { current: current?.value, next: next.value });
      toast(t('PIN gespeichert'));
      st = await call('state');
    } },
  ].filter(Boolean));
  void close;
  setTimeout(() => (current || next).focus(), 0);
}

// ---------------------------------------------------------------- sidebar

function select(next) {
  Object.assign(ui, next, { editing: null });
  if (ui.selected && !visibleItems().some((i) => i.key === ui.selected)) ui.selected = null;
  for (const k of ui.multi) if (!items.some((i) => i.key === k)) ui.multi.delete(k);
  renderSidebar();
  renderList();
  renderDetail();
}

function containerIcon(c) {
  if (logos.get(c.id)) return h('img', { class: 'container-logo', src: logos.get(c.id), alt: '' });
  if (c.kind === 'file') return icon('note');
  return icon(c.protected ? 'shield' : 'vault');
}

function renderSidebar() {
  const nav = (view, label, iconName, count) => h('button', {
    class: `nav ${ui.view === view && !ui.containerId ? 'active' : ''}`,
    onclick: () => select({ view, containerId: null }),
  }, icon(iconName), h('span', { class: 'nav-label' }, label), h('span', { class: 'count' }, count));
  const containers = st.containers.map((c) => {
    const refresh = iconButton('refresh', t('Aktualisieren'), (e) => {
      e.stopPropagation();
      refreshContainer(c, refresh);
    }, { disabled: c.locked && !c.error });
    refresh.classList.add('nav-refresh');
    refresh.dataset.container = c.id;
    refresh.classList.toggle('spinning', busyContainers.has(c.id));
    return h('div', { class: `nav-row ${ui.containerId === c.id ? 'active' : ''}`, oncontextmenu: (e) => contextMenu(e, containerActions(c)) },
      h('button', {
        class: `nav ${ui.containerId === c.id ? 'active' : ''}`,
        title: [c.vaultUrl || c.path, c.error?.message, t('Rechtsklick: alle Funktionen')].filter(Boolean).join('\n'),
        onclick: () => select({ view: 'container', containerId: c.id }),
      }, containerIcon(c), h('span', { class: 'nav-label' }, c.name),
      c.error ? h('span', { class: 'badge danger' }, '!') : c.locked ? icon('lock', 13) : h('span', { class: 'count' }, c.count ?? '')),
      refresh);
  });
  setChildren(panes.sidebar,
    h('div', { class: 'brand' }, h('img', { src: '../assets/icon.png', alt: '' }), 'Keevault',
      st.offline ? h('span', { class: 'badge warn', title: t('Letzter Stand: {date}', { date: formatDateTime(st.offlineAt) }) }, t('Offline – nur lesen')) : null),
    nav('all', t('Alle Einträge'), 'shield', items.length),
    nav('favorites', t('Favoriten'), 'star', items.filter((i) => i.favorite).length),
    nav('passkeys', t('Passkeys'), 'key', items.filter((i) => i.rpIds.length).length),
    h('div', { class: 'nav-section' }, h('span', {}, t('Tresore')), iconButton('plus', t('Tresor hinzufügen oder erstellen'), containerMenu)),
    containers.length ? containers : h('p', { class: 'muted small pad' }, t('Noch keine Tresore. Mit + hinzufügen oder erstellen.')),
    h('div', { class: 'nav-section' }, h('span', {}, t('Werkzeuge'))),
    h('button', { class: 'nav', onclick: generatorDialog }, icon('key'), h('span', { class: 'nav-label' }, t('Passwort-Generator'))),
    h('button', { class: 'nav', onclick: () => healthDialog(reportCtx()) }, icon('shield'), h('span', { class: 'nav-label' }, t('Passwort-Check')),
      expiringEntries(items).length ? h('span', { class: 'count warn', title: t('Einträge laufen ab') }, expiringEntries(items).length) : null),
    st.signedIn ? h('button', { class: 'nav', onclick: () => accessReportDialog(reportCtx()) }, icon('users'), h('span', { class: 'nav-label' }, t('Zugriffsbericht'))) : null,
    !st.signedIn ? h('button', { class: 'btn small', style: { margin: '8px 10px' }, onclick: async () => {
      try {
        await call('signIn');
        await reloadAll();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }, icon('unlock', 14), t('Key-Vault-Tresore anmelden')) : null,
    h('div', { class: 'spacer' }),
    h('div', { class: 'account' },
      h('div', { class: 'account-text' },
        h('div', { class: 'row-title' }, st.account?.name || st.account?.username || t('Lokal')),
        h('div', { class: 'row-sub' }, st.account?.username || t('Nur Datei-Tresore'))),
      iconButton('refresh', t('Neu laden'), refresh),
      iconButton('settings', t('Einstellungen'), settingsDialog),
      iconButton('lock', t('Sperren'), () => call('lock'))),
  );
}

async function refresh() {
  try {
    const r = await call('refresh');
    if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
    else toast(t('Aktualisiert'));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------- list

function visibleItems() {
  let list = items;
  if (ui.containerId) list = list.filter((i) => i.containerId === ui.containerId);
  else if (ui.view === 'favorites') list = list.filter((i) => i.favorite);
  else if (ui.view === 'passkeys') list = list.filter((i) => i.rpIds.length);
  const q = ui.query.trim().toLowerCase();
  if (q) {
    list = list.filter((i) => [i.title, i.username, i.folder, ...i.hosts, ...i.rpIds, containerName(i.containerId)]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  return [...list].sort((a, b) => a.title.localeCompare(b.title));
}

function renderList() {
  const container = ui.containerId ? st.containers.find((c) => c.id === ui.containerId) : null;
  const title = container ? container.name : { all: t('Alle Einträge'), favorites: t('Favoriten'), passkeys: t('Passkeys') }[ui.view];
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
        // Dragging a selected row takes the whole selection along.
        const keys = ui.multi.has(i.key) ? [...ui.multi] : [i.key];
        e.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
        e.dataTransfer.effectAllowed = 'move';
      } : undefined,
      onclick: (e) => {
      // Shift: range from the last clicked entry; Ctrl: toggle; plain click: single selection.
      if (e.shiftKey && ui.selected) {
        const order = [...rowsEl.querySelectorAll('li.row-item[data-key]')].map((el) => el.dataset.key);
        const a = order.indexOf(ui.selected);
        const b = order.indexOf(i.key);
        if (a >= 0 && b >= 0) {
          if (!ui.multi.size) ui.multi.add(ui.selected);
          for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) ui.multi.add(k);
          renderRows();
          renderDetail();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if (!ui.multi.size && ui.selected && ui.selected !== i.key) ui.multi.add(ui.selected);
        if (ui.multi.has(i.key)) ui.multi.delete(i.key);
        else ui.multi.add(i.key);
        ui.selected = i.key;
        ui.editing = null;
        renderRows();
        renderDetail();
        return;
      }
      ui.multi.clear();
      ui.selected = i.key;
      ui.editing = null;
      renderRows();
      renderDetail();
    } },
    itemAvatar(i),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, i.title,
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
    if (!list.length && !(container && explicitFolders.get(container.id)?.length)) {
      rowsEl.replaceChildren(h('li', { class: 'empty' }, icon('search', 32), ui.query ? t('Keine Treffer') : t('Keine Einträge')));
      return;
    }
    if (container && !ui.query.trim()) {
      renderChunked(folderRows(container, list, row, renderRows));
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
    setChildren(panes.list,
      h('div', { class: 'list-head' }, h('h2', {}, title), containerBadges(container)),
      h('div', { class: 'list-scroll' }, h('span', { class: 'spinner' })));
    call('protectionInfo', container.id).then((info) => {
      panes.list.querySelector('.list-scroll').replaceChildren(info.secure
        ? secureUnlockPanel(container, info)
        : unlockPanel(container, info, protectCtx, () => reloadAll()));
    }, (e) => panes.list.querySelector('.list-scroll').replaceChildren(notice(e.message)));
    return;
  }

  setChildren(panes.list,
    h('div', { class: 'list-head' }, container && logos.get(container.id) ? h('img', { class: 'container-logo large', src: logos.get(container.id), alt: '' }) : null,
      h('h2', {}, title), container ? containerBadges(container) : null, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', title: t('Neuer Eintrag (Strg+N)'), onclick: (e) => {
        // Choose what to create right at the button.
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu({ preventDefault() {}, clientX: r.left, clientY: r.bottom + 4 }, [
          { action: 'new-login', icon: 'key', label: t('Passwort / Login'), onClick: () => newItem('login') },
          { action: 'new-note', icon: 'note', label: t('Sichere Notiz'), onClick: () => newItem('note') },
          { action: 'new-card', icon: 'card', label: t('Kreditkarte'), onClick: () => newItem('card') },
          { action: 'new-certificate', icon: 'certificate', label: t('Zertifikat'), onClick: () => newItem('certificate') },
          container ? '-' : null,
          container && featureAllowed(container, 'folders') && (ui.folder || '').split('/').filter(Boolean).length < MAX_FOLDER_DEPTH
            ? { action: 'new-folder', icon: 'folder-plus', label: ui.folder ? t('Neuer Unterordner') : t('Neuer Ordner'), disabled: !writable(container), onClick: () => newFolderDialog(container) } : null,
        ]);
      } }, icon('plus'), t('Neu'))),
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
    h('div', { class: 'search' }, icon('search'), search),
    h('div', { class: 'list-scroll' }, rowsEl),
  );
  renderRows();
  if (container && !container.error) {
    call('folders', container.id).then((f) => {
      explicitFolders.set(container.id, f);
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

const DRAG_TYPE = 'application/x-kvpwsafe-item';

/** Drag & drop target that moves the dragged entry into folder (same container). */
function dropTarget(folder) {
  return {
    ondragover: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drop');
    },
    ondragleave: (e) => e.currentTarget.classList.remove('drop'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drop');
      const keys = e.dataTransfer.getData(DRAG_TYPE).split('\n').filter(Boolean);
      if (keys.length > 1) moveManyToFolder(keys, folder);
      else if (keys[0]) moveToFolder(keys[0], folder);
    },
  };
}

async function moveToFolder(key, folder) {
  const [containerId, id] = splitKey(key);
  try {
    const item = await call('item', containerId, id);
    if ((item.folder || '') === folder) return;
    let saved;
    try {
      saved = await call('save', containerId, { ...item, folder }, item.version);
    } catch (e) {
      if (e.name !== 'ConflictError') throw e;
      saved = await conflictDialog(containerId, item, { ...item, folder });
      if (!saved) return;
    }
    toast(t('„{title}“ verschoben nach {folder}', { title: item.title, folder: folder || t('Ohne Ordner') }));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Folder view of a container: breadcrumb, subfolders of the current folder, then its entries. */
function folderRows(container, list, row, rerender) {
  const all = new Set([...(explicitFolders.get(container.id) || []), ...list.map((i) => i.folder).filter(Boolean)]);
  for (const f of [...all]) {
    const parts = f.split('/');
    for (let k = 1; k < parts.length; k++) all.add(parts.slice(0, k).join('/'));
  }
  const cur = all.has(ui.folder) ? ui.folder : '';
  const prefix = cur ? `${cur}/` : '';
  const inside = (f) => list.filter((i) => i.folder === f || (i.folder || '').startsWith(`${f}/`)).length;
  const children = [...all].filter((f) => f.startsWith(prefix) && f !== cur && !f.slice(prefix.length).includes('/')).sort((a, b) => a.localeCompare(b));
  const open = (f) => {
    ui.folder = f;
    rerender();
  };
  const out = [];
  if (cur) {
    const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
    out.push(h('li', { class: 'folder-crumb', ...dropTarget(parent) },
      h('button', { class: 'icon-btn', title: t('Übergeordneter Ordner'), onclick: () => open(parent) }, icon('back', 16)),
      icon('folder', 16), h('b', {}, cur.split('/').join(' / '))));
  }
  for (const f of children) {
    const count = inside(f);
    const name = f.slice(prefix.length);
    out.push(h('li', { class: 'row-item folder-row', onclick: () => open(f), oncontextmenu: (e) => contextMenu(e, folderActions(container, f, count, open)), ...dropTarget(f) },
      h('span', { class: 'folder-icon' }, icon('folder', 18)),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, name), h('div', { class: 'row-sub' }, t('{count} Einträge', { count }))),
      !count && writable(container) ? h('button', { class: 'icon-btn', title: t('Leeren Ordner löschen'), onclick: async (e) => {
        e.stopPropagation();
        try {
          await call('removeFolder', container.id, f);
          explicitFolders.set(container.id, await call('folders', container.id));
          rerender();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, icon('trash', 14)) : null));
  }
  out.push(...list.filter((i) => (i.folder || '') === cur).map((i) => () => row(i)));
  if (out.length === (cur ? 1 : 0)) out.push(h('li', { class: 'empty' }, icon('folder', 32), t('Ordner ist leer')));
  return out;
}

async function licenseDialog(c) {
  let st0;
  try {
    st0 = await call('licenseState', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const key = h('textarea', { rows: 3, placeholder: 'KVPL-…', spellcheck: 'false' });
  const permanent = st0.licensed && !st0.expires;
  const status = permanent
    ? notice(t('Lizenziert{to} – unbegrenzt viele Einträge.', { to: st0.to ? ` (${st0.to})` : '' }), 'info')
    : st0.licensed
      ? notice(t('Befristete Lizenz{to} bis {date} – danach gilt wieder die Grenze von {limit} Einträgen.', { to: st0.to ? ` (${st0.to})` : '', date: formatDate(st0.expires), limit: st0.limit }), 'info')
      : notice(t('Ohne Lizenz: {count} von {limit} Einträgen genutzt.', { count: st0.count, limit: st0.limit }), st0.count >= st0.limit ? 'warn' : 'info');
  // Website with the request code filled in: order form and free trial (in the app's language).
  const site = getLanguage() === 'en' ? 'https://keevault.de/en/' : 'https://keevault.de/';
  const query = `?code=${encodeURIComponent(st0.code)}&vault=${encodeURIComponent(st0.vault.split('.')[0])}`;
  const links = h('div', { class: 'license-links' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => openUrl(`${site}${getLanguage() === 'en' ? 'license.html' : 'lizenz.html'}${query}`) }, icon('external', 14), t('Lizenz anfragen')),
    st0.licensed ? null : h('button', { type: 'button', class: 'btn', onclick: () => openUrl(`${site}${getLanguage() === 'en' ? 'trial.html' : 'testlizenz.html'}${query}`) }, icon('external', 14), t('3 Monate kostenlos testen')));
  modal(t('Lizenz für „{name}“', { name: c.name }), h('div', {},
    status,
    st0.reason ? notice(st0.reason) : null,
    permanent ? null : h('div', {},
      h('p', { class: 'muted' }, t('Frag auf der Website unverbindlich eine Lizenz an – der Anfragecode ist schon eingetragen. Wir melden uns persönlich; der Lizenzschlüssel gilt genau für diesen Tresor.')),
      links,
      h('div', { class: 'field-row' }, h('code', { class: 'license-code' }, st0.code), iconButton('copy', t('Kopieren'), () => copy(`${st0.code}  (${st0.vault})`, t('Lizenzanfrage')))),
      h('p', { class: 'muted small' }, t('Tresor: {vault}', { vault: st0.vault })),
      field(t('Lizenzschlüssel'), key))), permanent ? [{ label: t('Schließen') }] : [
    { label: t('Abbrechen') },
    { label: t('Aktivieren'), primary: true, onClick: async () => {
      await call('setLicense', c.id, key.value);
      licenses.delete(c.id);
      toast(t('Lizenz aktiviert'));
      renderList();
    } },
  ]);
}

function renameContainerDialog(c) {
  const name = h('input', { value: c.name });
  modal(t('Tresor umbenennen'), h('div', {},
    h('p', { class: 'muted' }, c.kind === 'file'
      ? t('Der Name wird in der Datei gespeichert und ist für alle sichtbar.')
      : t('Der Name wird als Tag am Key Vault gespeichert (dafür braucht es Schreibrechte auf die Ressource) und gilt sonst nur in deiner App.')),
    field(t('Name'), name)), [
    { label: t('Abbrechen') },
    { label: t('Umbenennen'), primary: true, onClick: async () => {
      const r = await call('renameContainer', c.id, name.value);
      if (r.warning) toast(r.warning, 'error');
      else toast(t('Umbenannt'));
      await reloadAll();
    } },
  ]);
  setTimeout(() => name.select(), 0);
}

function logoDialog(c) {
  let logo = logos.get(c.id) || null;
  const preview = h('div', { class: 'logo-preview' });
  const draw = () => preview.replaceChildren(logo ? h('img', { src: logo, alt: '' }) : h('span', { class: 'muted' }, t('Kein Logo')));
  draw();
  modal(t('Logo von „{name}“', { name: c.name }), h('div', {},
    h('p', { class: 'muted' }, t('Z. B. das Logo des Kunden. Es wird verkleinert und im Tresor gespeichert (Key Vault: als Secret, bei Schutz verschlüsselt; Datei: verschlüsselt). Alle mit Zugriff sehen es.')),
    preview,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        try {
          const url = await pickImage({ size: 128, maxChars: LOGO_MAX_CHARS });
          if (url) {
            logo = url;
            draw();
          }
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('image', 14), t('Bild wählen …')),
      h('button', { type: 'button', class: 'btn small', onclick: () => { logo = null; draw(); } }, t('Entfernen')))), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      await call('setContainerLogo', c.id, logo);
      logos.set(c.id, logo);
      toast(t('Gespeichert'));
      renderSidebar();
      renderList();
    } },
  ]);
}

/** Functions of a folder (right-click in the list). */
function folderActions(c, folder, count, open) {
  const canWrite = writable(c) && featureAllowed(c, 'folders');
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  const reloadFolders = async () => {
    explicitFolders.set(c.id, await call('folders', c.id));
    await reloadAll();
  };
  return [
    { action: 'open-folder', icon: 'folder', label: t('Öffnen'), onClick: () => open(folder) },
    folder.split('/').length < MAX_FOLDER_DEPTH
      ? { action: 'subfolder', icon: 'folder-plus', label: t('Neuer Unterordner'), disabled: !canWrite, onClick: () => newFolderDialog(c, `${folder}/`) } : null,
    { action: 'rename-folder', icon: 'edit', label: t('Umbenennen'), disabled: !canWrite, onClick: () => renameFolderDialog(c, folder) },
    mcpScopeAction(c.id, folder),
    '-',
    { action: 'delete-folder', icon: 'trash', label: t('Löschen'), danger: true, disabled: !canWrite, onClick: async () => {
      try {
        const inside = items.filter((i) => i.containerId === c.id && (i.folder === folder || (i.folder || '').startsWith(`${folder}/`)));
        if (inside.length) {
          // First the choice (keep the entries, or delete them too), then a second warning for the destructive one.
          const choice = await new Promise((resolve) => {
            modal(t('Ordner löschen'), h('div', {},
              h('p', {}, t('„{folder}“ enthält {count} Einträge (inklusive Unterordner). Was soll mit ihnen passieren?', { folder, count: inside.length })),
              h('p', { class: 'muted small' }, t('„Nur Ordner“ verschiebt die Einträge eine Ebene nach oben ({parent}). „Mit Inhalt“ verschiebt sie in den Papierkorb.', { parent: parent || t('Ohne Ordner') }))), [
              { label: t('Abbrechen'), onClick: () => resolve(null) },
              { label: t('Nur Ordner löschen'), onClick: () => resolve('keep') },
              { label: t('Mit Inhalt löschen'), danger: true, onClick: () => resolve('delete') },
            ]);
          });
          if (!choice) return;
          if (choice === 'delete') {
            if (!(await confirmDialog(t('Wirklich alle Einträge löschen?'), t('Achtung: {count} Einträge aus „{folder}“ und allen Unterordnern werden in den Papierkorb verschoben. Wiederherstellen ist nur bis zum Ablauf der Aufbewahrungsfrist des Key Vaults möglich – danach sind sie endgültig weg.', { folder, count: inside.length }), { confirmLabel: t('Ja, {count} Einträge löschen', { count: inside.length }), danger: true }))) return;
            const failed = await deleteMany(inside.map((i) => i.key));
            if (failed) toast(t('{n} Einträge konnten nicht gelöscht werden', { n: failed }), 'error');
          } else {
            const r = await call('renameFolder', c.id, folder, parent);
            for (const err of r.errors) toast(err, 'error');
          }
        }
        await call('removeFolder', c.id, folder).catch(() => {});
        // Subfolders that only existed as empty folders.
        for (const f of (explicitFolders.get(c.id) || []).filter((x) => x.startsWith(`${folder}/`))) await call('removeFolder', c.id, f).catch(() => {});
        if (ui.folder === folder || ui.folder.startsWith(`${folder}/`)) ui.folder = parent;
        toast(t('Ordner gelöscht'));
        await reloadFolders();
      } catch (e) {
        toast(e.message, 'error');
      }
    } },
  ];
}

function renameFolderDialog(c, folder) {
  const name = h('input', { value: folder });
  modal(t('Ordner umbenennen'), h('div', {},
    h('p', { class: 'muted' }, t('Unterordner und Einträge werden mit umbenannt. Mit „/“ verschiebst du den Ordner, z. B. Kunden/Alt.')),
    field(t('Ordner'), name)), [
    { label: t('Abbrechen') },
    { label: t('Umbenennen'), primary: true, onClick: async () => {
      const r = await call('renameFolder', c.id, folder, name.value);
      for (const err of r.errors) toast(err, 'error');
      const next = name.value.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      if (ui.folder === folder || ui.folder.startsWith(`${folder}/`)) ui.folder = next + ui.folder.slice(folder.length);
      explicitFolders.set(c.id, await call('folders', c.id));
      toast(t('Ordner umbenannt'));
      await reloadAll();
    } },
  ]);
  setTimeout(() => name.select(), 0);
}

function newFolderDialog(c, prefix) {
  const name = h('input', { placeholder: t('z. B. Kunden/Contoso') });
  if (prefix || ui.folder) name.value = prefix || `${ui.folder}/`;
  modal(t('Neuer Ordner'), h('div', {},
    h('p', { class: 'muted' }, t('Unterordner trennst du mit „/“, z. B. Kunden/Contoso. Einträge verschiebst du über „Bearbeiten“ → Ordner.')),
    field(t('Ordner'), name)), [
    { label: t('Abbrechen') },
    { label: t('Anlegen'), primary: true, onClick: async () => {
      await call('addFolder', c.id, name.value);
      explicitFolders.set(c.id, await call('folders', c.id));
      ui.folder = name.value.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      renderList();
    } },
  ]);
  setTimeout(() => name.focus(), 0);
}

function accessBadge(c) {
  if (c.error) return h('span', { class: 'badge danger' }, t('Kein Zugriff'));
  if (c.kind === 'file' && c.secure && c.role) return h('span', { class: 'badge accent', title: c.path }, t(ROLE_NAMES[c.role]));
  if (c.kind === 'file') return h('span', { class: 'badge accent', title: c.path }, t('Datei'));
  if (!c.access) return h('span', { class: 'badge' }, t('Zugriff unbekannt'));
  if (c.access.manage && c.access.write) return h('span', { class: 'badge accent' }, t('Verwalten'));
  if (c.access.write) return h('span', { class: 'badge accent' }, t('Bearbeiten'));
  if (c.access.read) return h('span', { class: 'badge' }, t('Lesen'));
  return h('span', { class: 'badge warn' }, t('Ohne Datenzugriff'));
}

/** Stand-alone password generator: copy, type into another window or start a new entry with it. */
function generatorDialog() {
  let options = { ...DEFAULT_OPTIONS };
  try {
    options = { ...options, ...JSON.parse(localStorage.getItem('generator') || '{}') };
  } catch {
    // Defaults.
  }
  let password = '';
  const panel = generatorPanel(options, (pw) => {
    password = pw;
    try {
      localStorage.setItem('generator', JSON.stringify(options));
    } catch {
      // Not persisted.
    }
  });
  panel.regenerate();
  const { close } = modal(t('Passwort-Generator'), h('div', {},
    panel,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: () => copy(password, t('Passwort')) }, icon('copy', 14), t('Kopieren')),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        close();
        try {
          await call('typeGenerated', password);
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('fill', 14), t('Abtippen (ins vorherige Fenster)')),
      st?.opened ? h('button', { type: 'button', class: 'btn small primary', onclick: () => {
        close();
        ui.newPassword = password;
        newItem();
      } }, icon('plus', 14), t('Neuer Eintrag damit')) : null)), [{ label: t('Schließen') }]);
}

/** Context menu at the mouse position; closes on click elsewhere, Escape, scrolling or resizing. */
function contextMenu(event, actions) {
  event.preventDefault();
  document.querySelector('.context-menu')?.remove();
  // Entries with "children" open a submenu (hover or click); it stays inside the menu's DOM.
  const item = (a) => {
    if (a === '-') return h('div', { class: 'context-sep' });
    if (a.children) {
      const sub = h('div', { class: 'context-menu context-sub', role: 'menu' }, ...a.children.filter(Boolean).map(item));
      const wrap = h('div', { class: 'context-group' });
      const place = () => sub.classList.toggle('left', wrap.getBoundingClientRect().right + 240 > window.innerWidth);
      wrap.append(h('button', {
        type: 'button', role: 'menuitem', 'aria-haspopup': 'true', class: 'has-sub', dataset: { action: a.action || '' },
        onclick: () => {
          if (wrap.classList.toggle('open')) place();
        },
        onmouseenter: () => {
          wrap.classList.add('open');
          place();
        },
      }, icon(a.icon, 15), h('span', {}, a.label), icon('caret', 13)), sub);
      wrap.addEventListener('mouseleave', () => wrap.classList.remove('open'));
      return wrap;
    }
    return h('button', {
      type: 'button', role: 'menuitem', class: a.danger ? 'danger' : '', disabled: a.disabled, dataset: { action: a.action || '' },
      onclick: () => {
        close();
        a.onClick();
      },
    }, icon(a.icon, 15), h('span', {}, a.label));
  };
  const menu = h('div', { class: 'context-menu', role: 'menu' }, ...actions.filter(Boolean).map(item));
  const close = () => {
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  };
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.body.append(menu);
  const { innerWidth: w, innerHeight: hgt } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, w - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, hgt - rect.height - 8)}px`;
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  menu.querySelector('button:not(:disabled)')?.focus();
}

async function refreshContainer(c, button) {
  if (button) button.disabled = true;
  try {
    await call('refreshContainer', c.id);
    explicitFolders.delete(c.id);
    logos.delete(c.id);
    licenses.delete(c.id);
    for (const key of [...icons.keys()]) if (key.startsWith(`${c.id}/`)) icons.delete(key);
    await reloadAll();
    toast(t('Aktualisiert'));
  } catch (e) {
    toast(e.message, 'error');
  }
  if (button) button.disabled = false;
}

/** Facts about a Key Vault: Azure details, admins, link to the portal. */
async function infoDialog(c) {
  const body = h('div', {}, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Informationen werden geladen …')));
  modal(t('Tresor-Infos: {name}', { name: c.name }), body, [{ label: t('Schließen') }]);
  let info;
  try {
    info = await call('vaultInfo', c.id);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'notice' }, e.message));
    return;
  }
  const row = (label, value, extra) => (value ? h('tr', {}, h('th', {}, label), h('td', {}, value, extra || null)) : null);
  const copyBtn = (text) => iconButton('copy', t('Kopieren'), () => copy(text, t('Kopiert')));
  const yesNo = (v) => (v ? t('ja') : t('nein'));
  setChildren(body,
    h('table', { class: 'info-table' },
      row(t('Adresse'), c.vaultUrl, copyBtn(c.vaultUrl)),
      row(t('Einträge'), String(c.count ?? items.filter((i) => i.containerId === c.id).length)),
      row(t('Erstellt'), info.createdAt ? `${formatDateTime(info.createdAt)}${info.createdBy ? ` · ${info.createdBy}` : ''}` : ''),
      row(t('Zuletzt geändert'), info.modifiedAt ? `${formatDateTime(info.modifiedAt)}${info.modifiedBy ? ` · ${info.modifiedBy}` : ''}` : ''),
      row(t('Administratoren'), info.admins.length ? info.admins.map((a) => a.detail ? `${a.displayName} (${a.detail})` : a.displayName).join(', ') : t('keine Datenrolle „Verwalten“ vergeben')),
      row(t('Tenant'), info.tenantId, copyBtn(info.tenantId)),
      row(t('Subscription'), info.subscriptionName ? `${info.subscriptionName} (${info.subscriptionId})` : info.subscriptionId),
      row(t('Ressourcengruppe'), info.resourceGroup),
      row(t('Region'), info.location),
      row(t('Berechtigungsmodell'), info.rbac ? t('Azure RBAC') : t('Zugriffsrichtlinien (nicht unterstützt)')),
      row(t('Papierkorb (Soft Delete)'), `${yesNo(info.softDelete)}${info.retentionDays ? t(', {days} Tage Aufbewahrung', { days: info.retentionDays }) : ''}`),
      row(t('Schutz vor endgültigem Löschen'), yesNo(info.purgeProtection)),
      row(t('SKU'), info.sku)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => call('openExternal', info.portalUrl) }, icon('link'), t('Im Azure-Portal öffnen')),
      h('button', { type: 'button', class: 'btn', onclick: () => copy(info.resourceId, t('Kopiert')) }, icon('copy'), t('Ressourcen-ID kopieren'))));
}

/** All functions of a container (right-click menu in the sidebar). */
/**
 * Vault settings: Key Vault admins may use every function; everyone else only what an admin enabled (restrictive
 * default). File vaults have their own roles and are not affected. The desktop main process enforces the same.
 */
const featureAllowed = (c, feature) => c.kind !== 'keyvault' || !!c.access?.admin || c.policy?.[feature] === true;

// The vault menu keeps every function but folds the rarely used ones into two submenus.
const VAULT_GROUPS = [
  { action: 'group-manage', icon: 'settings', label: 'Verwaltung', members: ['vault-settings', 'mcp-scope', 'license', 'info', 'logo', 'rename', 'migrate', 'changelog'] },
  { action: 'group-data', icon: 'download', label: 'Daten', members: ['import', 'export', 'backup', 'restore', 'trash'] },
];

function groupMenu(actions) {
  const out = [];
  for (const a of actions.filter(Boolean)) {
    const g = a !== '-' && VAULT_GROUPS.find((x) => x.members.includes(a.action));
    if (!g) {
      out.push(a);
      continue;
    }
    let node = out.find((x) => x !== '-' && x.action === g.action);
    if (!node) {
      node = { action: g.action, icon: g.icon, label: t(g.label), children: [] };
      out.push(node);
    }
    node.children.push(a);
  }
  // No separators at the ends or twice in a row.
  return out.filter((x, i, arr) => !(x === '-' && (i === 0 || i === arr.length - 1 || arr[i - 1] === '-')));
}

/** All functions of a container (right-click menu in the sidebar). */
function containerActions(c) {
  return groupMenu(containerActionsFlat(c));
}

function containerActionsFlat(c) {
  const isFile = c.kind === 'file';
  const ready = !c.error && !c.locked;
  const canWrite = ready && c.access?.write !== false;
  const may = (feature) => featureAllowed(c, feature);
  const protection = c.secure
    ? { action: 'members', icon: 'users', label: t('Benutzer und Freigabe'), disabled: !!c.error, onClick: () => (c.locked ? toast(t('Zuerst entsperren')) : membersDialog(c)) }
    : isFile || c.protected
      ? { action: 'protection', icon: 'shield', label: t('Schutz und Benutzer'), disabled: !!c.error, onClick: () => (c.locked ? toast(t('Zuerst entsperren')) : manageDialog(c, protectCtx, () => reloadAll())) }
      : may('protection') ? { action: 'protection', icon: 'shield', label: t('Zusätzlich schützen (Masterpasswort/Passkey)'), disabled: !canWrite, onClick: () => enableDialog(c, protectCtx, () => reloadAll()) } : null;
  const settings = !isFile && (c.access?.admin || c.access?.manage)
    ? { action: 'vault-settings', icon: 'settings', label: t('Tresor-Einstellungen (Admin)'), disabled: !!c.error, onClick: () => vaultSettingsDialog(c) } : null;
  return [
    { action: 'refresh', icon: 'refresh', label: t('Aktualisieren'), disabled: c.locked && !c.error, onClick: () => refreshContainer(c) },
    '-',
    isFile ? null : { action: 'share', icon: 'users', label: t('Freigeben'), onClick: () => shareDialog(c) },
    protection,
    isFile && !c.secure && ready ? { action: 'migrate', icon: 'key', label: t('In abgesichertes Format umwandeln (nur Passkey)'), onClick: () => migrateDialog(c) } : null,
    c.secure ? { action: 'changelog', icon: 'clock', label: t('Änderungsprotokoll'), disabled: !ready, onClick: () => changelogDialog(c) } : null,
    settings,
    mcpScopeAction(c.id, ''),
    c.kind === 'keyvault' ? { action: 'info', icon: 'info', label: t('Infos'), disabled: !!c.error, onClick: () => infoDialog(c) } : null,
    c.kind === 'keyvault' || c.kind === 'file' ? { action: 'health', icon: 'shield', label: t('Passwort-Check'), disabled: !ready, onClick: () => healthDialog(reportCtx(c.id)) } : null,
    '-',
    may('folders') ? { action: 'folder', icon: 'folder-plus', label: t('Neuer Ordner'), disabled: !canWrite, onClick: () => newFolderDialog(c) } : null,
    may('logo') ? { action: 'logo', icon: 'image', label: t('Logo des Tresors'), disabled: !canWrite, onClick: () => logoDialog(c) } : null,
    may('rename') ? { action: 'rename', icon: 'edit', label: t('Umbenennen'), disabled: !!c.error || (isFile && !ready), onClick: () => renameContainerDialog(c) } : null,
    may('import') ? { action: 'import', icon: 'upload', label: t('Importieren'), disabled: !canWrite, onClick: () => openImport(c) } : null,
    !isFile && may('export') ? { action: 'export', icon: 'download', label: t('Einträge exportieren (CSV)'), disabled: !ready, onClick: () => exportDialog(c) } : null,
    { action: 'trash', icon: 'trash', label: t('Papierkorb'), disabled: !ready, onClick: () => trashDialog(c) },
    { action: 'license', icon: 'key', label: t('Lizenz'), disabled: !ready, onClick: () => licenseDialog(c) },
    isFile ? null : { action: 'backup', icon: 'download', label: t('Backup erstellen (Owner)'), disabled: !!c.error, onClick: () => backupDialog(c) },
    isFile ? null : { action: 'restore', icon: 'history', label: t('Backup wiederherstellen (Owner)'), disabled: !!c.error, onClick: () => restoreDialog(c) },
    '-',
    isFile
      ? { action: 'explorer', icon: 'folder', label: t('Im Explorer zeigen'), onClick: () => call('showFile', c.id) }
      : { action: 'invite', icon: 'link', label: t('Einladungslink kopieren'), onClick: async () => copy(await call('invite', c.id), t('Einladungslink')) },
    ready && (c.protected || isFile) ? { action: 'lock', icon: 'lock', label: t('Tresor sperren'), onClick: async () => {
      await call('lockContainer', c.id);
      await reloadAll();
    } } : null,
    c.sources?.includes('policy') ? null : { action: 'remove', icon: 'x', label: t('Aus der Liste entfernen'), danger: true, onClick: async () => {
      if (!(await confirmDialog(t('Tresor entfernen'), isFile
        ? t('„{name}“ aus der Liste entfernen? Die Datei bleibt erhalten.', { name: c.name })
        : t('„{name}“ aus der Liste entfernen? Der Key Vault und seine Daten bleiben unverändert.', { name: c.name }), { confirmLabel: t('Entfernen') }))) return;
      await call('removeContainer', c.id);
      ui.containerId = null;
      await reloadAll();
    } },
  ];
}

// ---------------------------------------------------------------- vault settings (Key Vault administrators)

const POLICY_ORDER = ['folders', 'rename', 'logo', 'import', 'export', 'protection', 'purge'];
const POLICY_TEXT = {
  folders: 'Ordner anlegen, umbenennen und löschen',
  rename: 'Tresor umbenennen',
  logo: 'Logo des Tresors ändern',
  import: 'Einträge importieren',
  export: 'Einträge exportieren (unverschlüsselt, CSV)',
  protection: 'Zusätzlichen Schutz ein- oder ausschalten',
  purge: 'Einträge endgültig aus dem Papierkorb löschen',
};

async function vaultSettingsDialog(c) {
  let state;
  try {
    state = await call('policyState', c.id);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!state.admin) {
    // Manage (may assign roles) but not admin: offer to take the Key Vault Administrator role.
    return modal(t('Tresor-Einstellungen'), h('div', {},
      h('p', {}, t('Die Tresor-Einstellungen ändern nur Personen mit der Azure-Rolle „Key Vault-Administrator“ auf diesem Key Vault.')),
      state.canBecomeAdmin ? notice(t('Du darfst Rollen vergeben und kannst dir die Rolle selbst geben. Sie gilt nach ein paar Minuten.'), 'info') : null), [
      { label: t('Abbrechen') },
      state.canBecomeAdmin ? { label: t('Mir die Admin-Rolle geben'), primary: true, onClick: async () => {
        await call('makeMeAdmin', c.id);
        toast(t('Rolle vergeben – nach dem Aktualisieren stehen die Einstellungen bereit'));
        await reloadAll();
        return true;
      } } : null,
    ].filter(Boolean));
  }
  const boxes = Object.fromEntries(POLICY_ORDER.map((f) => [f, h('input', { type: 'checkbox', checked: !!state.features?.[f] })]));
  modal(t('Tresor-Einstellungen – {name}', { name: c.name }), h('div', {},
    h('p', {}, t('Lege fest, welche Funktionen alle anderen in diesem Tresor nutzen dürfen. Admins (Key Vault-Administrator) dürfen immer alles. Standard: alles aus.')),
    h('div', { class: 'policy-list' }, ...POLICY_ORDER.map((f) => h('label', { class: 'inline policy-row' }, boxes[f], t(POLICY_TEXT[f])))),
    notice(t('Unabhängig davon gelten die Azure-Rollen: Wer nur „Lesen“ hat, kann auch freigeschaltete Funktionen nicht nutzen, die Schreibrechte brauchen.'), 'info'),
    state.updatedBy ? h('p', { class: 'muted small' }, t('Zuletzt geändert {date} von {user}', { date: formatDateTime(state.updated), user: state.updatedBy })) : null), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      await call('setPolicy', c.id, Object.fromEntries(POLICY_ORDER.map((f) => [f, boxes[f].checked])));
      toast(t('Tresor-Einstellungen gespeichert'));
      await reloadAll();
      return true;
    } },
  ]);
}

async function exportDialog(c) {
  const progress = progressLine();
  const body = h('div', {},
    h('div', { class: 'danger-box' },
      h('h3', {}, t('⚠ Unverschlüsselter Export')),
      h('p', {}, t('Die CSV-Datei enthält alle Passwörter von „{name}“ im Klartext. Jeder, der die Datei bekommt, kann sie lesen.', { name: c.name })),
      h('ul', {},
        h('li', {}, t('Nur auf verschlüsselten Laufwerken speichern und nach Gebrauch löschen.')),
        h('li', {}, t('Nicht per E-Mail versenden und nicht in Cloud-Ordnern ablegen.')),
        h('li', {}, t('Zertifikatsdateien sind nicht enthalten, nur ihre Passwörter.')))));
  const { dialog } = modal(t('Einträge exportieren'), body, [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und exportieren'), danger: true, onClick: async () => {
      body.append(progress.el);
      const r = await call('exportItems', c.id);
      if (!r) return false;
      toast(t('{count} Einträge exportiert: {path}', { count: r.count, path: r.filePath }));
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
}

// ---------------------------------------------------------------- encrypted backup / restore (subscription owners)

function progressLine() {
  const el = h('div', { class: 'muted small' });
  const listener = (ev) => { el.textContent = t('{done} von {total}', { done: ev.done, total: ev.total }); };
  progressListeners.add(listener);
  return { el, stop: () => progressListeners.delete(listener) };
}

function ownerCheck(c, slot, onOk) {
  setChildren(slot, h('div', { class: 'muted small' }, t('Berechtigung wird geprüft …')));
  call('backupAllowed', c.id).then((r) => {
    if (r.allowed) {
      setChildren(slot, notice(t('Du bist Besitzer (Owner) der Subscription.'), 'info'));
      onOk();
    } else setChildren(slot, notice(r.reason));
  }, (e) => setChildren(slot, notice(e.message)));
}

function backupDialog(c) {
  const slot = h('div');
  let allowed = false;
  const body = h('div', {},
    h('p', {}, t('Erstellt eine verschlüsselte Sicherung aller Einträge von „{name}“ als Datei. Geschützt wird sie mit einem Passwort, das die App erzeugt und nur ein einziges Mal anzeigt.', { name: c.name })),
    notice(t('Wer Backup-Datei und Passwort hat, kann alle Passwörter dieses Tresors lesen. Für die sichere Aufbewahrung von Datei und Passwort bist du als Kunde selbst verantwortlich.'), 'warn'),
    slot);
  const progress = progressLine();
  const { dialog } = modal(t('Backup erstellen'), body, [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und Backup erstellen'), primary: true, onClick: async () => {
      if (!allowed) throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
      body.append(progress.el);
      const r = await call('createBackup', c.id);
      if (!r) return false;
      backupPasswordDialog(r);
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
  ownerCheck(c, slot, () => { allowed = true; });
}

function backupPasswordDialog(r) {
  const confirmed = h('input', { type: 'checkbox' });
  const { dialog } = modal(t('Backup-Passwort – nur jetzt sichtbar'), h('div', {},
    notice(t('Backup gespeichert: {file} ({count} Secrets).', { file: r.file, count: r.count }), 'info'),
    h('p', {}, t('Ohne dieses Passwort lässt sich das Backup nicht wiederherstellen. Es wird nur jetzt angezeigt und nirgends gespeichert – auch nicht beim Hersteller.')),
    h('div', { class: 'backup-password' }, r.password),
    h('div', { class: 'danger-box' },
      h('h3', {}, t('Jetzt ausdrucken und sicher ablegen')),
      h('ul', {},
        h('li', {}, t('Drucke das Passwortblatt aus und lege es in einen Tresor oder ein Bankschließfach.')),
        h('li', {}, t('Bewahre Blatt und Backup-Datei getrennt voneinander auf.')),
        h('li', {}, t('Speichere das Passwort nicht unverschlüsselt am PC und nicht im selben Tresor.')),
        h('li', {}, t('Für die sichere Aufbewahrung von Backup-Datei und Passwort ist der Kunde selbst verantwortlich.')))),
    h('label', { class: 'inline' }, confirmed, t('Ich habe das Passwort ausgedruckt bzw. notiert und sicher abgelegt.'))), [
    { label: t('Passwortblatt drucken'), onClick: async () => {
      await call('printBackupSheet');
      return false;
    } },
    { label: t('Fertig'), primary: true, onClick: async () => {
      if (!confirmed.checked) throw new Error(t('Bitte bestätigen, dass das Passwort sicher abgelegt ist'));
      return true;
    } },
  ]);
  dialog.addEventListener('close', () => call('forgetBackupPassword').catch(() => {}));
}

function restoreDialog(c) {
  const slot = h('div');
  const fileInfo = h('div');
  const password = h('input', { class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' });
  const confirmed = h('input', { type: 'checkbox' });
  let header = null;
  let allowed = false;
  const choose = h('button', { class: 'btn', type: 'button', disabled: true, onclick: async () => {
    try {
      header = await call('chooseBackupFile', c.id);
      if (!header) return;
      const other = header.vault !== c.id;
      setChildren(fileInfo, h('div', { class: 'notice info' },
        h('div', {}, h('b', {}, header.file)),
        h('div', { class: 'small' }, t('Tresor: {vault} · erstellt {date} von {by} · {count} Secrets', { vault: header.vault, date: formatDateTime(header.created), by: header.createdBy || '?', count: header.count }))),
      other ? notice(header.protected
        ? t('Dieses Backup stammt aus einem anderen, zusätzlich verschlüsselten Tresor und lässt sich nur dort zurückspielen.')
        : t('Das Backup stammt aus einem anderen Tresor ({vault}). Die Einträge werden in „{name}“ kopiert; Lizenz und Kennung von „{name}“ bleiben erhalten.', { vault: header.vault, name: c.name }), 'warn') : null);
      password.focus();
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('upload', 14), t('Backup-Datei wählen …'));
  const progress = progressLine();
  const body = h('div', {},
    h('p', {}, t('Spielt ein Backup in „{name}“ zurück: fehlende und gelöschte Einträge kommen wieder, geänderte erhalten den Stand des Backups (der aktuelle Stand bleibt im Verlauf). Einträge, die nicht im Backup sind, bleiben unverändert.', { name: c.name })),
    slot, choose, fileInfo,
    field(t('Backup-Passwort'), password, t('Steht auf dem ausgedruckten Passwortblatt.')),
    h('label', { class: 'inline' }, confirmed, t('Ich möchte den Stand des Backups in diesen Tresor schreiben.')));
  const { dialog } = modal(t('Backup wiederherstellen'), body, [
    { label: t('Abbrechen') },
    { label: t('Wiederherstellen'), primary: true, onClick: async () => {
      if (!allowed) throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
      if (!header) throw new Error(t('Bitte zuerst die Backup-Datei wählen'));
      if (!password.value.trim()) throw new Error(t('Bitte das Backup-Passwort eingeben'));
      if (!confirmed.checked) throw new Error(t('Bitte die Wiederherstellung bestätigen'));
      body.append(progress.el);
      const r = await call('restoreBackup', c.id, password.value);
      licenses.delete(c.id);
      await reloadAll();
      modal(t('Wiederherstellung abgeschlossen'), h('div', {},
        h('p', {}, t('{restored} wiederhergestellt (davon {recovered} aus dem Papierkorb), {unchanged} unverändert.', r)),
        r.failed.length ? notice(t('Fehlgeschlagen: {list}', { list: r.failed.map((f) => `${f.name} (${f.error})`).join(', ') })) : null));
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
  ownerCheck(c, slot, () => { allowed = true; choose.disabled = false; });
}

const licenses = new Map(); // containerId → licenseState (refreshed with the vault)

/** "Demo" badge while a vault has no license; click opens the license dialog. */
function licenseBadge(c) {
  const slot = h('span');
  const draw = (l) => slot.replaceChildren(l && !l.licensed ? h('button', {
    type: 'button', class: 'badge warn badge-button', title: t('Ohne Lizenz: {count} von {limit} Einträgen genutzt.', { count: l.count, limit: l.limit }),
    onclick: () => licenseDialog(c),
  }, t('Demo')) : l?.expires ? h('button', {
    type: 'button', class: 'badge badge-button', title: t('Befristete Lizenz bis {date}', { date: formatDate(l.expires) }),
    onclick: () => licenseDialog(c),
  }, t('Test bis {date}', { date: formatDate(l.expires) })) : '');
  if (c.error || c.locked) return slot;
  if (licenses.has(c.id)) draw(licenses.get(c.id));
  else call('licenseState', c.id).then((l) => { licenses.set(c.id, l); draw(l); }, () => {});
  return slot;
}

/** State badges next to the container name (functions: right-click in the sidebar). */
function containerBadges(c) {
  return h('span', { class: 'head-badges' },
    accessBadge(c),
    licenseBadge(c),
    c.protected && c.kind !== 'file' ? h('span', { class: 'badge passkey', title: t('Zusätzlich verschlüsselt') }, icon('shield', 11)) : null);
}

/** Functions of an entry (right-click in the list). */
function itemActions(i) {
  if (ui.multi.size > 1 && ui.multi.has(i.key)) return multiActions();
  const [containerId, id] = splitKey(i.key);
  const c = st.containers.find((x) => x.id === containerId) || {};
  const canWrite = writable(c);
  const open = async () => call('item', containerId, id);
  return [
    { action: 'favorite', icon: 'star', label: i.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), disabled: !canWrite, onClick: () => toggleFavorite(i) },
    '-',
    i.username ? { action: 'copy-user', icon: 'copy', label: t('Benutzername kopieren'), onClick: async () => copy((await open()).username, t('Benutzername')) } : null,
    i.type === 'login' || i.type === 'certificate' ? { action: 'copy-password', icon: 'copy', label: t('Passwort kopieren'), onClick: async () => copy((await open()).password, t('Passwort')) } : null,
    i.type === 'card' ? { action: 'copy-card', icon: 'copy', label: t('Kartennummer kopieren'), onClick: async () => copy((await open()).card.number, t('Kartennummer')) } : null,
    i.hosts?.[0] ? { action: 'open', icon: 'external', label: t('Website öffnen'), onClick: () => openUrl(`https://${i.hosts[0]}`) } : null,
    '-',
    { action: 'edit', icon: 'edit', label: t('Bearbeiten'), disabled: !canWrite, onClick: async () => {
      ui.selected = i.key;
      ui.editing = 'edit';
      ui.editingItem = await open();
      renderList();
      renderDetail();
    } },
    { action: 'duplicate', icon: 'copy', label: t('Duplizieren'), disabled: !canWrite, onClick: () => duplicateItem(containerId, id) },
    { action: 'history', icon: 'history', label: t('Verlauf'), onClick: async () => historyDialog(await open()) },
    { action: 'delete', icon: 'trash', label: t('Löschen'), danger: true, disabled: !canWrite, onClick: async () => {
      if (!(await confirmDialog(t('Eintrag löschen'), t('„{title}“ in den Papierkorb verschieben? Wiederherstellen ist bis zum Ablauf der Aufbewahrungsfrist möglich.', { title: i.title }), { confirmLabel: t('Löschen'), danger: true }))) return;
      await call('delete', containerId, id);
      if (ui.selected === i.key) ui.selected = null;
      toast(t('In den Papierkorb verschoben'));
      await reloadAll();
    } },
  ];
}

// ---------------------------------------------------------------- several entries at once (Shift/Ctrl)

const multiKeys = () => [...ui.multi].filter((k) => items.some((i) => i.key === k));
const multiItems = () => multiKeys().map((k) => items.find((i) => i.key === k));

/** Context menu for a selection of several entries. */
function multiActions() {
  const list = multiItems();
  const containerIds = [...new Set(list.map((i) => i.containerId))];
  const oneVault = containerIds.length === 1;
  const canWrite = list.every((i) => writable(st.containers.find((c) => c.id === i.containerId) || {}));
  return [
    { action: 'multi-folder', icon: 'folder', label: t('{n} Einträge in Ordner verschieben …', { n: list.length }), disabled: !oneVault || !canWrite, onClick: () => folderPickDialog(containerIds[0], list.map((i) => i.key)) },
    { action: 'multi-move', icon: 'move', label: t('{n} Einträge in anderen Tresor verschieben …', { n: list.length }), disabled: !canWrite, onClick: () => moveManyDialog(list) },
    '-',
    { action: 'multi-delete', icon: 'trash', label: t('{n} Einträge löschen', { n: list.length }), danger: true, disabled: !canWrite, onClick: () => deleteManyDialog(list) },
    '-',
    { action: 'multi-clear', icon: 'x', label: t('Auswahl aufheben'), onClick: () => { ui.multi.clear(); renderRows(); renderDetail(); } },
  ];
}

function renderMultiSelection() {
  const list = multiItems();
  const actions = multiActions().filter((a) => a !== '-' && a.action !== 'multi-clear');
  panes.detail.replaceChildren(h('div', { class: 'placeholder multi-selection' }, icon('check', 40),
    h('h2', {}, t('{n} Einträge ausgewählt', { n: list.length })),
    h('p', { class: 'muted small' }, t('Shift+Klick wählt einen Bereich, Strg+Klick einzelne Einträge. Ziehen verschiebt alle in einen Ordner.')),
    h('ul', { class: 'multi-list' }, ...list.slice(0, 12).map((i) => h('li', {}, i.title)), list.length > 12 ? h('li', { class: 'muted' }, `… +${list.length - 12}`) : null),
    h('div', { class: 'actions' }, ...actions.map((a) => h('button', { type: 'button', class: a.danger ? 'btn danger' : 'btn', disabled: a.disabled, onclick: a.onClick }, icon(a.icon), a.label)),
      h('button', { type: 'button', class: 'btn', onclick: () => { ui.multi.clear(); renderRows(); renderDetail(); } }, t('Auswahl aufheben')))));
  return undefined;
}

/** Deletes entries one by one (recycle bin); → number of failures. */
async function deleteMany(keys) {
  let failed = 0;
  let done = 0;
  const end = progress.begin('deleteMany', t('Einträge werden gelöscht …'));
  try {
    for (const key of keys) {
      const [containerId, id] = splitKey(key);
      try {
        await call('delete', containerId, id);
      } catch {
        failed++;
      }
      ui.multi.delete(key);
      if (ui.selected === key) ui.selected = null;
      progress.set('deleteMany', ++done, keys.length);
    }
  } finally {
    end();
  }
  return failed;
}

async function deleteManyDialog(list) {
  if (!(await confirmDialog(t('Einträge löschen'), t('{n} Einträge in den Papierkorb verschieben? Wiederherstellen ist bis zum Ablauf der Aufbewahrungsfrist möglich.', { n: list.length }), { confirmLabel: t('Löschen'), danger: true }))) return;
  const failed = await deleteMany(list.map((i) => i.key));
  toast(failed ? t('{n} Einträge konnten nicht gelöscht werden', { n: failed }) : t('{n} Einträge in den Papierkorb verschoben', { n: list.length }), failed ? 'error' : undefined);
  await reloadAll();
}

async function moveManyToFolder(keys, folder) {
  let moved = 0;
  let done = 0;
  const end = progress.begin('moveMany', t('Einträge werden verschoben …'));
  try {
    for (const key of keys) {
      progress.set('moveMany', ++done, keys.length);
      const item = items.find((i) => i.key === key);
      if (!item || (item.folder || '') === folder) continue;
      try {
        const [containerId, id] = splitKey(key);
        const full = await call('item', containerId, id);
        await call('save', containerId, { ...full, folder }, full.version);
        moved++;
      } catch (e) {
        toast(`${item.title}: ${e.message}`, 'error');
      }
    }
  } finally {
    end();
  }
  if (moved) toast(t('{n} Einträge verschoben nach {folder}', { n: moved, folder: folder || t('Ohne Ordner') }));
  await reloadAll();
}

/** Picks a folder of the vault (existing ones, or a new path) for several entries. */
function folderPickDialog(containerId, keys) {
  const known = [...new Set([...(explicitFolders.get(containerId) || []), ...items.filter((i) => i.containerId === containerId).map((i) => i.folder).filter(Boolean)])].sort();
  const input = h('input', { list: 'folder-pick-options', placeholder: t('optional, z. B. Kunden/Contoso'), value: ui.containerId === containerId ? ui.folder : '' });
  const options = h('datalist', { id: 'folder-pick-options' }, h('option', { value: '' }), ...known.map((f) => h('option', { value: f })));
  modal(t('In Ordner verschieben'), h('div', {}, field(t('{n} Einträge verschieben nach', { n: keys.length }), h('div', {}, input, options)),
    h('p', { class: 'muted small' }, t('Leer lassen für „Ohne Ordner“. Ein neuer Pfad legt den Ordner an.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: () => moveManyToFolder(keys, input.value.split('/').map((x) => x.trim()).filter(Boolean).join('/')) },
  ]);
  setTimeout(() => input.focus(), 0);
}

function moveManyDialog(list) {
  const targets = writableContainers().filter((c) => !list.every((i) => i.containerId === c.id));
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Einträge verschieben'), h('div', {},
    field(t('{n} Einträge verschieben nach', { n: list.length }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle in den Papierkorb verschoben. Der bisherige Verlauf bleibt in der Quelle.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      let moved = 0;
      for (const i of list) {
        if (i.containerId === target.value) continue;
        try {
          await call('move', i.containerId, target.value, i.id);
          moved++;
        } catch (e) {
          toast(`${i.title}: ${e.message}`, 'error');
        }
      }
      ui.multi.clear();
      ui.selected = null;
      toast(t('{n} Einträge verschoben', { n: moved }));
      await reloadAll();
    } },
  ]);
}

/** Copy in the same vault and folder (without passkeys); the copy is selected afterwards. */
async function duplicateItem(containerId, id) {
  try {
    const copyItem = await call('duplicate', containerId, id);
    await reloadAll();
    ui.selected = `${containerId}/${copyItem.id}`;
    ui.editing = null;
    renderList();
    renderDetail();
    toast(t('Kopie angelegt: {title}', { title: copyItem.title }));
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleFavorite(i) {
  const [containerId, id] = splitKey(i.key);
  try {
    const item = await call('item', containerId, id);
    try {
      await call('save', containerId, { ...item, favorite: !item.favorite }, item.version);
    } catch (e) {
      if (e.name !== 'ConflictError') throw e;
      if (!(await conflictDialog(containerId, item, { ...item, favorite: !item.favorite }))) return;
    }
    toast(item.favorite ? t('Aus Favoriten entfernt') : t('Zu Favoriten hinzugefügt'));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------- detail / editor

const splitKey = (key) => {
  const i = key.indexOf('/');
  return [key.slice(0, i), key.slice(i + 1)];
};

function newItem(type = 'login') {
  if (!writableContainers().length) {
    toast(t('Kein Tresor mit Schreibrechten – zuerst einen Tresor hinzufügen, erstellen oder entsperren'), 'error');
    return;
  }
  ui.newType = type;
  ui.editing = 'new';
  ui.editingItem = null;
  renderDetail();
}

async function renderDetail() {
  const pane = panes.detail;
  call('selectItem', ui.selected).catch(() => {});
  if (ui.editing) return renderEditor();
  if (ui.multi.size > 1) return renderMultiSelection();
  if (!ui.selected) {
    pane.replaceChildren(h('div', { class: 'placeholder' }, icon('shield', 56), h('p', {}, t('Wähle einen Eintrag aus oder lege einen neuen an.'))));
    return undefined;
  }
  const key = ui.selected;
  const [containerId, id] = splitKey(key);
  pane.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
  let item;
  try {
    item = await call('item', containerId, id);
  } catch (e) {
    pane.replaceChildren(notice(e.message));
    return undefined;
  }
  if (ui.selected !== key || ui.editing) return undefined;
  const canWrite = writable(st.containers.find((c) => c.id === containerId) || {});
  pane.replaceChildren(itemDetail(item, {
    copy,
    openUrl,
    containerName,
    saveFile: async (name, data) => {
      try {
        const path = await call('saveCertificate', name, data);
        if (path) toast(t('Gespeichert: {path}', { path }));
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    onRemovePasskey: canWrite ? async (credentialId) => {
      if (!(await confirmDialog(t('Passkey entfernen'), t('Passkey aus dem Eintrag entfernen? Die Anmeldung bei der Website damit ist danach nicht mehr möglich – entferne ihn dort ebenfalls.'), { confirmLabel: t('Entfernen'), danger: true }))) return;
      try {
        await call('save', containerId, { ...item, passkeys: item.passkeys.filter((p) => p.credentialId !== credentialId) }, item.version);
        await reloadAll();
      } catch (e) {
        toast(e.message, 'error');
      }
    } : null,
    actions: [
      canWrite ? { icon: 'edit', label: t('Bearbeiten'), primary: true, onClick: () => {
        ui.editing = 'edit';
        ui.editingItem = item;
        renderDetail();
      } } : null,
      canWrite ? { icon: 'move', label: t('Verschieben'), onClick: () => moveDialog(item) } : null,
      canWrite ? { icon: 'copy', label: t('Duplizieren'), onClick: () => duplicateItem(containerId, id) } : null,
      canWrite ? { icon: 'star', label: item.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), onClick: () => toggleFavorite(item) } : null,
      { icon: 'history', label: t('Verlauf'), onClick: () => historyDialog(item) },
      st.containers.find((c) => c.id === containerId)?.secure
        ? { icon: 'clock', label: t('Änderungsprotokoll'), onClick: () => changelogDialog(st.containers.find((c) => c.id === containerId), id) } : null,
      canWrite ? { icon: 'trash', label: t('Löschen'), danger: true, onClick: async () => {
        if (!(await confirmDialog(t('Eintrag löschen'), t('„{title}“ in den Papierkorb verschieben? Wiederherstellen ist bis zum Ablauf der Aufbewahrungsfrist möglich.', { title: item.title }), { confirmLabel: t('Löschen'), danger: true }))) return;
        try {
          await call('delete', containerId, id);
          ui.selected = null;
          toast(t('In den Papierkorb verschoben'));
          await reloadAll();
        } catch (e) {
          toast(e.message, 'error');
        }
      } } : null,
    ].filter(Boolean),
  }));
  return undefined;
}

function renderEditor() {
  const isNew = ui.editing === 'new';
  const item = isNew ? { type: ui.newType || 'login', urls: [], password: ui.newPassword || '' } : ui.editingItem;
  ui.newPassword = '';
  const targets = writableContainers();
  const folderTarget = isNew ? ui.containerId : item.containerId;
  const knownFolders = [...new Set([...(explicitFolders.get(folderTarget) || []), ...items.filter((i) => i.containerId === folderTarget).map((i) => i.folder).filter(Boolean)])].sort();
  const folderContainer = st.containers.find((c) => c.id === folderTarget);
  const form = itemForm(item, {
    isNew,
    folders: knownFolders,
    // Without the "folders" function only existing folders can be chosen (no new ones by typing).
    folderFree: !folderContainer || featureAllowed(folderContainer, 'folders'),
    typeFixed: isNew,
    defaultFolder: ui.containerId ? ui.folder : '',
    containers: isNew ? targets : st.containers.map((c) => ({ id: c.id, name: c.name })),
    containerId: isNew
      ? [ui.containerId, st.settings.defaultContainer].find((id) => targets.some((c) => c.id === id)) || targets[0]?.id
      : item.containerId,
    onCancel: () => {
      ui.editing = null;
      renderDetail();
    },
    onSave: async (next, containerId) => {
      let saved;
      try {
        saved = await call('save', containerId, next, isNew ? undefined : item.version);
      } catch (e) {
        if (e.name !== 'ConflictError' || isNew) throw e;
        saved = await conflictDialog(containerId, item, next);
        if (!saved) return;
      }
      toast(t('Gespeichert'));
      icons.set(saved.key, saved.icon || '');
      licenses.delete(containerId);
      ui.editing = null;
      ui.selected = saved.key;
      await reloadAll();
    },
  });
  // Save and cancel also at the top, so long entries need no scrolling to the buttons at the end.
  const topSave = h('button', { type: 'button', class: 'btn primary', title: t('Speichern (Strg+S)'), onclick: () => form.requestSubmit() }, icon('check'), t('Speichern'));
  const topCancel = h('button', { type: 'button', class: 'btn', onclick: () => { ui.editing = null; renderDetail(); } }, t('Abbrechen'));
  form.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  panes.detail.replaceChildren(h('div', { class: 'editor' },
    h('div', { class: 'editor-head' }, h('h2', {}, isNew ? t('Neuer Eintrag') : t('Eintrag bearbeiten')), h('div', { class: 'actions' }, topSave, topCancel)),
    form));
}

// ---------------------------------------------------------------- dialogs

/**
 * Someone else saved the entry while it was being edited: show who and when, then let the user choose.
 * Returns the saved item, or null (keep editing / reloaded).
 */
async function conflictDialog(containerId, mine, next) {
  let current = null;
  try {
    current = await call('item', containerId, mine.id);
  } catch {
    // Deleted meanwhile: only "save anyway" or cancel make sense.
  }
  const changed = current ? ['title', 'username', 'password', 'urls', 'notes', 'totp', 'folder', 'fields']
    .filter((f) => JSON.stringify(current[f] ?? null) !== JSON.stringify(mine[f] ?? null)) : [];
  return new Promise((resolve) => {
    modal(t('Eintrag wurde inzwischen geändert'), h('div', {},
      notice(current
        ? t('„{title}“ wurde nach dem Öffnen von {who} geändert ({when}). Deine Änderungen sind noch nicht gespeichert.', {
          title: current.title, who: current.updatedBy || t('jemand anderem'), when: formatDateTime(current.updated),
        })
        : t('Der Eintrag wurde inzwischen gelöscht. Deine Änderungen sind noch nicht gespeichert.'), 'warn'),
      changed.length ? h('p', { class: 'muted' }, t('Dort geändert: {fields}', { fields: changed.map((f) => t(FIELD_LABELS[f] || f)).join(', ') })) : null), [
      { label: t('Weiter bearbeiten'), onClick: () => resolve(null) },
      current ? { label: t('Neuen Stand anzeigen (meine Änderungen verwerfen)'), onClick: async () => {
        ui.editing = null;
        await reloadAll();
        resolve(null);
      } } : null,
      { label: t('Meine Änderungen trotzdem speichern'), danger: true, onClick: async () => {
        resolve(await call('save', containerId, next, current?.version));
      } },
    ].filter(Boolean));
  });
}

function containerMenu() {
  const option = (iconName, title, text, onClick, disabled) => h('button', { class: 'option-card', disabled, onclick: () => {
    close();
    onClick();
  } }, icon(iconName, 20), h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, text)));
  const { close } = modal(t('Tresor hinzufügen'), h('div', {},
    option('note', t('Neuer Datei-Tresor'), t('Verschlüsselte Datei wie bei KeePass, abgesichert mit Passkey und/oder Masterpasswort.'), createFileDialog),
    option('folder', t('Datei-Tresor öffnen'), t('Vorhandene .kvpws-Datei, z. B. von einem Netzlaufwerk.'), openFile),
    option('link', t('Vorhandenen Key Vault hinzufügen'), st.signedIn
      ? t('Aus deinen Key Vaults wählen oder per Adresse/Einladungslink. Der Zugriff kommt über Azure-Rollen.')
      : t('Key Vault per Adresse oder Einladungslink. Der Zugriff kommt über Azure-Rollen.'), () => addContainerDialog()),
    option('plus', t('Neuen Key-Vault-Tresor erstellen'), st.signedIn
      ? t('Legt einen Key Vault in einem Azure-Abonnement an, z. B. für ein Team.')
      : t('Zuerst mit Microsoft Entra ID anmelden (Seitenleiste: „Key-Vault-Tresore anmelden“).'), createContainerDialog, !st.signedIn)), []);
}

const defaultEmail = () => st.settings.fileEmail || st.account?.username || '';

function authenticatorSelect() {
  return h('select', {},
    h('option', { value: 'platform' }, t('Windows Hello auf diesem Gerät (PIN, Gesicht, Fingerabdruck)')),
    h('option', { value: 'cross-platform' }, t('Sicherheitsschlüssel oder Smartphone')));
}

const PASSKEY_ONLY_HINT = 'Kein Masterpasswort, kein Wiederherstellungscode: Die Datei öffnet sich nur mit einem Passkey (oder Windows Hello). Richte danach einen zweiten Passkey oder einen zweiten Admin ein, damit die Datei nicht verloren geht.';

/** Prominent warning before a vault is stored as a local file: the file can simply be copied and taken away. */
function fileRiskBox() {
  const accept = h('input', { type: 'checkbox' });
  const box = h('div', { class: 'danger-box', role: 'alert' },
    h('h3', {}, t('⚠ Sicherheitshinweis: Der Tresor liegt als Datei auf diesem Gerät')),
    h('p', {}, t('Eine Datei lässt sich unbemerkt kopieren, per USB-Stick, E-Mail oder Cloud-Sync mitnehmen und an einem anderen Ort in Ruhe angreifen. Anders als bei Azure Key Vault gibt es kein Zugriffsprotokoll, keine zentrale Sperre und kein Entziehen von Rechten für bereits kopierte Dateien.')),
    h('ul', {},
      h('li', {}, t('Speichere die Datei nur auf verschlüsselten Laufwerken (BitLocker) oder geschützten Netzlaufwerken – nicht auf USB-Sticks, in privaten Cloud-Ordnern oder als Mail-Anhang.')),
      h('li', {}, t('Geht ein Gerät oder eine Kopie verloren: alle Passwörter darin sofort ändern.')),
      h('li', {}, t('Ohne gültigen Passkey ist die Datei nicht lesbar – geht der letzte Passkey verloren, sind die Daten weg.')),
      h('li', {}, t('Für Teams und Firmendaten empfehlen wir einen Tresor in Azure Key Vault.'))),
    h('label', { class: 'inline' }, accept, t('Ich habe den Hinweis verstanden und bin für den sicheren Speicherort der Datei verantwortlich.')));
  return { box, accepted: () => accept.checked };
}

function createFileDialog() {
  const name = h('input', { placeholder: t('z. B. Persönlich oder Team Infrastruktur') });
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  const risk = fileRiskBox();
  modal(t('Neuer Datei-Tresor'), h('div', {},
    risk.box,
    h('p', { class: 'muted' }, t('Alle Einträge werden in der Datei verschlüsselt. Du wirst Admin der Datei und kannst sie danach für weitere Personen freigeben – jede Person nutzt ihren eigenen Passkey.')),
    field(t('Name'), name),
    field(t('Deine E-Mail-Adresse'), email),
    field(t('Anmelden mit'), authenticator),
    notice(t(PASSKEY_ONLY_HINT), 'info')), [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und erstellen'), primary: true, onClick: async () => {
      if (!risk.accepted()) throw new Error(t('Bitte den Sicherheitshinweis bestätigen'));
      if (!name.value.trim()) throw new Error(t('Bitte einen Namen eingeben'));
      if (!email.value.includes('@')) throw new Error(t('Bitte eine gültige E-Mail-Adresse eingeben'));
      const filePath = await call('chooseNewFile', name.value.trim());
      if (!filePath) return false;
      const r = await call('createSecureFile', { path: filePath, name: name.value.trim(), email: email.value, attachment: authenticator.value });
      ui.containerId = r.id;
      ui.view = 'container';
      await render();
      toast(t('Datei erstellt – du bist Admin. Unter „Benutzer und Freigabe“ gibst du sie für andere frei.'));
      return true;
    } },
  ]);
  setTimeout(() => name.focus(), 0);
}

function secureUnlockPanel(c, info) {
  const status = h('div');
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  const unlockButton = h('button', { class: 'btn primary block', onclick: async () => {
    unlockButton.disabled = true;
    setChildren(status);
    try {
      const r = await call('unlockContainerPasskey', c.id);
      if (r?.pending) {
        setChildren(status, notice(t('Deine Anfrage wartet auf die Freigabe durch einen Admin der Datei. Sicherheitscode zum Vergleichen: {code}', { code: r.safetyCode }), 'info'));
      } else {
        await reloadAll();
        if (st.platform === 'win32' && r?.platform === false && !r.hasPlatform) offerWindowsHello(c);
      }
    } catch (e) {
      setChildren(status, notice(e.message));
    }
    unlockButton.disabled = false;
  } }, icon('key'), t('Mit Passkey entsperren'));
  const requestButton = h('button', { class: 'btn block', onclick: async () => {
    requestButton.disabled = true;
    try {
      const r = await call('requestFileAccess', c.id, { email: email.value, attachment: authenticator.value });
      setChildren(status, notice(t('Anfrage gespeichert. Nenne dem Admin der Datei diesen Sicherheitscode: {code}. Nach der Freigabe entsperrst du mit deinem Passkey.', { code: r.safetyCode }), 'info'));
    } catch (e) {
      setChildren(status, notice(e.message));
    }
    requestButton.disabled = false;
  } }, icon('user'), t('Zugriff anfordern'));
  return h('div', { class: 'unlock-panel' },
    icon('shield', 40),
    h('h3', {}, t('Abgesicherte Datei')),
    h('p', { class: 'muted' }, t('Diese Datei lässt sich nur mit einem Passkey oder Windows Hello öffnen.')),
    info.passkeys.length ? unlockButton : null,
    status,
    h('details', { open: !info.passkeys.length || undefined },
      h('summary', {}, t('Noch kein Zugriff? Zugriff anfordern')),
      field(t('Deine E-Mail-Adresse'), email),
      field(t('Anmelden mit'), authenticator),
      requestButton));
}

async function offerWindowsHello(c) {
  if (!(await confirmDialog(t('Mit Windows Hello merken?'), t('Dann reicht beim nächsten Öffnen von „{name}“ deine Windows-PIN, dein Gesicht oder Fingerabdruck. Der Schlüssel bleibt an dieses Gerät gebunden.', { name: c.name }), { confirmLabel: t('Mit Windows Hello merken') }))) return;
  try {
    await call('fileMemberOp', c.id, { type: 'addCredential', attachment: 'platform' });
    toast(t('Windows Hello hinterlegt'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

function migrateDialog(c) {
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  modal(t('In abgesichertes Format umwandeln'), h('div', {},
    h('p', { class: 'muted' }, t('Die Datei bekommt einen neuen Schlüssel und Benutzer mit Rollen. Masterpasswort, Wiederherstellungsschlüssel und Einladungen funktionieren danach nicht mehr; andere Personen fordern den Zugriff neu an. Der Verlauf alter Versionen entfällt.')),
    field(t('Deine E-Mail-Adresse'), email),
    field(t('Anmelden mit'), authenticator),
    notice(t(PASSKEY_ONLY_HINT), 'info')), [
    { label: t('Abbrechen') },
    { label: t('Umwandeln'), primary: true, onClick: async () => {
      const id = await call('migrateFile', c.id, { email: email.value, attachment: authenticator.value });
      ui.containerId = id;
      toast(t('Umgewandelt – du bist Admin der Datei'));
      await reloadAll();
    } },
  ]);
}

async function membersDialog(c) {
  let info;
  try {
    info = await call('fileMembers', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const body = h('div', { class: 'members' });
  modal(t('Benutzer und Freigabe'), body, [{ label: t('Schließen') }]);
  const op = async (o, message) => {
    try {
      await call('fileMemberOp', c.id, o);
      if (message) toast(message);
      info = await call('fileMembers', c.id);
      draw();
      reloadAll();
    } catch (e) {
      toast(e.message, 'error');
      info = await call('fileMembers', c.id).catch(() => info);
      draw();
    }
  };
  const roleSelect = (value, onChange, disabled) => h('select', { disabled, onchange: (e) => onChange(e.target.value) },
    ...FILE_ROLES.map((r) => h('option', { value: r, selected: r === value }, t(ROLE_NAMES[r]))));
  function draw() {
    const admin = info.myRole === 'admin';
    const me = info.members.find((m) => m.me);
    const pending = info.members.filter((m) => m.status === 'pending');
    const active = info.members.filter((m) => m.status === 'active');
    const admins = active.filter((m) => m.role === 'admin');
    setChildren(body,
      h('p', { class: 'muted' }, t('Die Datei öffnet sich nur mit Passkey oder Windows Hello. Jede Person meldet sich mit ihrer E-Mail-Adresse und ihrem eigenen Passkey an; Admins geben den Zugriff frei.')),
      admins.length === 1 && me?.role === 'admin' && me.credentials?.length === 1
        ? notice(t('Es gibt keinen Wiederherstellungscode. Richte einen zweiten Passkey oder einen zweiten Admin ein, damit die Datei nicht verloren geht.'), 'warn') : null,
      admin ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: info.sharing, onchange: (e) => op({ type: 'sharing', enabled: e.target.checked },
        e.target.checked ? t('Freigabe aktiv – andere können jetzt Zugriff anfordern') : t('Freigabe beendet – keine neuen Anfragen')) }),
      t('Freigabe aktiv: andere Personen können mit der Datei Zugriff anfordern')) : null,
      admin && pending.length ? h('h3', {}, t('Offene Anfragen')) : null,
      admin && pending.length ? h('p', { class: 'muted small' }, t('Vergleiche den Sicherheitscode mit der Person (z. B. am Telefon), bevor du freigibst.')) : null,
      ...(admin ? pending : []).map((m) => {
        let role = 'editor';
        return h('div', { class: 'member-row' },
          h('div', { class: 'grow' }, h('b', {}, m.email), h('div', { class: 'muted small' }, t('Sicherheitscode {code}', { code: m.safetyCode }), ' · ', formatDateTime(m.requested))),
          roleSelect(role, (v) => { role = v; }),
          h('button', { class: 'btn small primary', onclick: () => op({ type: 'approve', memberId: m.id, role }, t('{email} freigegeben', { email: m.email })) }, t('Freigeben')),
          h('button', { class: 'btn small', onclick: () => op({ type: 'reject', memberId: m.id }, t('Anfrage abgelehnt')) }, t('Ablehnen')));
      }),
      h('h3', {}, t('Benutzer')),
      ...active.map((m) => h('div', { class: 'member-row' },
        h('div', { class: 'grow' }, h('b', {}, m.email, m.me ? ` (${t('du')})` : ''),
          h('div', { class: 'muted small' }, t('{count} Passkeys', { count: m.passkeyCount }), m.since ? ` · ${t('seit {date}', { date: formatDateTime(m.since) })}` : '')),
        admin ? roleSelect(m.role, (v) => op({ type: 'setRole', memberId: m.id, role: v }, t('Rolle geändert')))
          : h('span', { class: 'badge' }, t(ROLE_NAMES[m.role])),
        admin && !m.me ? h('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmDialog(t('Benutzer entfernen'), t('{email} entfernen? Die Datei bekommt dabei einen neuen Schlüssel, damit alte Zugänge nicht mehr funktionieren.', { email: m.email }), { confirmLabel: t('Entfernen'), danger: true }))) return;
          op({ type: 'remove', memberId: m.id }, t('Entfernt – Schlüssel gewechselt'));
        } }, t('Entfernen')) : null)),
      h('h3', {}, t('Meine Passkeys')),
      ...(me?.credentials || []).map((cred) => h('div', { class: 'member-row' },
        icon(cred.platform ? 'user' : 'key', 16),
        h('div', { class: 'grow' }, cred.label || t('Passkey'), h('div', { class: 'muted small' }, formatDateTime(cred.created), cred.usable ? '' : ` · ${t('anderes Gerät')}`)),
        me.credentials.length > 1 ? h('button', { class: 'btn small', onclick: () => op({ type: 'removeCredential', credentialEntryId: cred.id }, t('Passkey entfernt')) }, t('Entfernen')) : null)),
      h('div', { class: 'actions' },
        st.platform === 'win32' ? h('button', { class: 'btn small', onclick: () => op({ type: 'addCredential', attachment: 'platform' }, t('Windows Hello hinterlegt')) }, icon('user', 14), t('Mit Windows Hello merken')) : null,
        h('button', { class: 'btn small', onclick: () => op({ type: 'addCredential', attachment: 'cross-platform' }, t('Passkey hinzugefügt')) }, icon('key', 14), t('Sicherheitsschlüssel oder Smartphone hinzufügen'))));
  }
  draw();
}

const FIELD_LABELS = {
  type: 'Typ', title: 'Titel', username: 'Benutzername', password: 'Passwort', urls: 'Websites', notes: 'Notizen', totp: 'Einmalcode (TOTP)',
  folder: 'Ordner', favorite: 'Favorit', fields: 'Zusätzliche Felder', passkeys: 'Passkeys', tags: 'Tags',
};

function describeChange(e) {
  const title = e.title || t('Eintrag');
  switch (e.action) {
    case 'file-create': return t('Datei erstellt');
    case 'file-rename': return t('Datei umbenannt: {from} → {name}', { from: e.from, name: e.name });
    case 'file-migrate': return t('In abgesichertes Format umgewandelt ({count} Einträge)', { count: e.count });
    case 'item-create': return t('„{title}“ angelegt', { title });
    case 'item-update': {
      const fields = (e.fields || []).map((f) => t(FIELD_LABELS[f] || f)).join(', ');
      if (e.fromFolder !== undefined && e.fromFolder !== e.folder) {
        return t('„{title}“ verschoben: {from} → {to}', { title, from: e.fromFolder || '/', to: e.folder || '/' });
      }
      return fields ? t('„{title}“ geändert: {fields}', { title, fields }) : t('„{title}“ gespeichert (ohne Änderung)', { title });
    }
    case 'item-delete': return t('„{title}“ in den Papierkorb verschoben', { title });
    case 'item-restore': return t('„{title}“ wiederhergestellt', { title });
    case 'item-purge': return t('„{title}“ endgültig gelöscht', { title });
    case 'folder-create': return t('Ordner „{folder}“ angelegt', { folder: e.folder });
    case 'folder-delete': return t('Ordner „{folder}“ gelöscht', { folder: e.folder });
    case 'member-approve': return t('{target} freigegeben ({role})', { target: e.target, role: t(ROLE_NAMES[e.role] || e.role) });
    case 'member-role': return t('Rolle von {target}: {role}', { target: e.target, role: t(ROLE_NAMES[e.role] || e.role) });
    case 'member-remove': return t('{target} entfernt', { target: e.target });
    case 'member-reject': return t('Anfrage von {target} abgelehnt', { target: e.target });
    case 'sharing-on': return t('Freigabe aktiviert');
    case 'sharing-off': return t('Freigabe beendet');
    case 'passkey-add': return t('Passkey hinzugefügt ({label})', { label: e.label || '' });
    case 'passkey-remove': return t('Passkey entfernt');
    case 'key-rotate': return t('Schlüssel gewechselt (Version {version})', { version: e.keyVersion });
    case 'logo-set': return t('Logo geändert');
    case 'logo-remove': return t('Logo entfernt');
    default: return t('Eintrag nicht lesbar');
  }
}

async function changelogDialog(c, itemId) {
  let entries;
  try {
    entries = await call('changelog', c.id, itemId);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(itemId ? t('Änderungsprotokoll des Eintrags') : t('Änderungsprotokoll: {name}', { name: c.name }), h('div', { class: 'changelog' },
    entries.length ? h('ul', { class: 'log-list' }, ...entries.map((e) => h('li', { class: e.trusted ? '' : 'untrusted' },
      h('div', { class: 'log-when' }, formatDateTime(e.at)),
      h('div', { class: 'grow' }, h('div', {}, describeChange(e)), h('div', { class: 'muted small' }, e.email,
        e.trusted ? '' : ` · ${t('Signatur ungültig – Änderung wird ignoriert')}`)))))
      : h('p', { class: 'muted' }, t('Noch keine Änderungen protokolliert.'))));
}

function addContainerDialog(prefill = '') {
  const input = h('input', { value: prefill, placeholder: t('https://<name>.vault.azure.net oder kvpwsafe://add?…') });
  const name = h('input', { placeholder: t('optional') });
  const list = h('div', { class: 'vault-list' });
  const filter = h('input', { type: 'search', placeholder: t('Key Vaults filtern (Name, Ressourcengruppe)'), hidden: true });
  let allVaults = [];
  const showVaults = () => {
    const q = filter.value.trim().toLowerCase();
    const vaults = q ? allVaults.filter((v) => [v.name, v.vaultUrl, v.resourceGroup].some((x) => String(x || '').toLowerCase().includes(q))) : allVaults;
    setChildren(list, vaults.length
      ? vaults.slice(0, 200).map((v) => h('button', { type: 'button', class: 'option-card', disabled: v.added, onclick: () => {
        input.value = v.vaultUrl;
        name.value = v.name;
      } }, icon('vault', 18), h('div', {}, h('b', {}, v.name),
        h('div', { class: 'muted small' }, [v.resourceGroup, v.added ? t('bereits hinzugefügt') : v.access ? t(LEVEL_LABEL[v.access.write ? (v.access.manage ? 'manage' : 'write') : 'read']) : v.container ? t('Keevault-Tresor') : null].filter(Boolean).join(' · ')))))
      : [h('p', { class: 'muted small' }, q ? t('Keine Treffer') : showAll.checked
        ? t('Keine Key Vaults sichtbar. Für die Liste brauchst du mindestens die Rolle „Leser“ auf dem Key Vault.')
        : t('Keine eingerichteten Passwort-Tresore mit Zugriff gefunden. Für die Liste brauchst du „Leser“ und eine Key-Vault-Datenrolle.'))]);
  };
  filter.addEventListener('input', showVaults);
  const showAll = h('input', { type: 'checkbox' });
  const loadVaults = () => {
    list.replaceChildren(h('span', { class: 'spinner' }));
    call('vaults', { all: showAll.checked }).then((vaults) => {
      allVaults = vaults;
      filter.hidden = vaults.length < 6;
      showVaults();
      if (!filter.hidden) filter.focus();
    }, (e) => setChildren(list, [h('p', { class: 'muted small' }, e.message)]));
  };
  showAll.addEventListener('change', loadVaults);
  const showAllLabel = h('label', { class: 'inline small muted' }, showAll, t('Auch Key Vaults zeigen, die nicht als Passwort-Tresore eingerichtet sind'));
  if (st.signedIn && !prefill) loadVaults();
  else showAllLabel.hidden = true;
  modal(t('Tresor hinzufügen'), h('div', {},
    h('p', { class: 'muted' }, t('Füge einen vorhandenen Key Vault hinzu, z. B. aus einer Einladung. Ohne passende Azure-Rolle bleibt er gesperrt.')),
    filter,
    list,
    showAllLabel,
    field(t('Key Vault oder Einladungslink'), input),
    field(t('Anzeigename'), name)), [
    { label: t('Abbrechen') },
    { label: t('Hinzufügen'), primary: true, onClick: async () => {
      const id = await call('addContainer', input.value, name.value.trim());
      toast(t('Tresor hinzugefügt'));
      if (st?.opened) {
        ui.containerId = id;
        ui.view = 'container';
        await reloadAll();
      }
    } },
  ]);
}

function suggestVaultName(text) {
  const slug = String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `kv-pws-${slug}`.slice(0, 24).replace(/-+$/, '');
}

async function createContainerDialog() {
  let subs;
  try {
    subs = await call('subscriptions');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (!subs.length) {
    toast(t('Kein Azure-Abonnement verfügbar'), 'error');
    return;
  }
  const VIA = { home: '', guest: t('Gast'), lighthouse: t('nur Lighthouse') };
  const display = h('input', { placeholder: t('z. B. Team Infrastruktur') });
  const name = h('input', { placeholder: t('kv-pws-team (weltweit eindeutig)') });
  const sub = h('select', {}, ...subs.map((s) => h('option', { value: s.id }, VIA[s.via] ? `${s.name} (${VIA[s.via]})` : s.name)));
  const rg = h('select');
  const loc = h('select');
  const purge = h('input', { type: 'checkbox', checked: true });
  const subNotice = h('div');
  const rgNotice = h('div');
  // Mode: create a new vault in the resource group, or use an existing empty one there.
  const mode = h('select', {},
    h('option', { value: 'new' }, t('Neuen Key Vault in der Ressourcengruppe anlegen')),
    h('option', { value: 'existing' }, t('Vorhandenen leeren Key Vault verwenden')));
  const existing = h('select');
  let rgPermissions = null;
  const newFields = h('div', {}, field(t('Key-Vault-Name'), name, t('3–24 Zeichen: Buchstaben, Ziffern, Bindestriche')));
  const existingFields = h('div', { hidden: true }, field(t('Key Vault'), existing));
  const drawRgNotice = () => {
    const s = current();
    const msg = s.via === 'lighthouse' ? null
      : mode.value === 'new' && rgPermissions && !rgPermissions.createVault
        ? notice(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen (nötig: Besitzer oder Mitwirkender). Wähle „Vorhandenen leeren Key Vault verwenden“ oder eine andere Ressourcengruppe.'), 'warn')
        : rgPermissions && !rgPermissions.assignRoles
          ? notice(t('Du darfst hier keine Rollen vergeben – Zugriff für Gruppen und Gäste muss dann jemand mit Besitzer-Rechten erteilen.'), 'info') : null;
    setChildren(rgNotice, msg);
  };
  const loadGroup = async () => {
    const s = current();
    rgPermissions = null;
    existing.replaceChildren();
    if (!rg.value || s.via === 'lighthouse') return drawRgNotice();
    call('groupPermissions', s.id, s.tenantId, rg.value).then((p) => { rgPermissions = p; drawRgNotice(); }, () => drawRgNotice());
    if (mode.value !== 'existing') return drawRgNotice();
    existing.replaceChildren(h('option', { value: '' }, t('Wird geladen …')));
    try {
      const vaults = await call('groupVaults', s.id, s.tenantId, rg.value);
      const label = (v) => (v.added ? t('bereits in der App') : v.marked ? t('bereits Tresor') : !v.readable ? t('kein Datenzugriff') : !v.empty ? t('nicht leer') : '');
      existing.replaceChildren(...(vaults.length ? vaults.map((v) => h('option', {
        value: v.vaultUrl, disabled: !v.readable || (!v.empty && !v.marked) || v.added, dataset: { resourceId: v.resourceId, name: v.name },
      }, label(v) ? `${v.vaultName} (${label(v)})` : v.vaultName)) : [h('option', { value: '' }, t('Keine Key Vaults in dieser Ressourcengruppe'))]));
      const firstUsable = [...existing.options].find((o) => !o.disabled && o.value);
      if (firstUsable) existing.value = firstUsable.value;
    } catch (e) {
      existing.replaceChildren(h('option', { value: '' }, e.message));
    }
    return drawRgNotice();
  };
  mode.addEventListener('change', () => {
    newFields.hidden = mode.value !== 'new';
    existingFields.hidden = mode.value !== 'existing';
    purgeLabel.hidden = mode.value !== 'new';
    loadGroup();
  });
  const current = () => subs.find((s) => s.id === sub.value);

  // Access: Entra groups / people of the subscription's tenant and guests to invite.
  const access = []; // { principal } | { email }  + level
  const accessList = h('div', { class: 'access-list' });
  const search = h('input', { placeholder: t('Entra-Gruppe, Person oder E-Mail für einen Gast …') });
  const results = h('div', { class: 'search-results' });
  const level = h('select', {}, ...Object.entries(ACCESS_LEVELS).map(([k, v]) => h('option', { value: k, selected: k === 'read' }, t(v.label))));
  const drawAccess = () => setChildren(accessList, access.length
    ? access.map((a, i) => h('div', { class: 'member' },
      icon(a.email ? 'plus' : a.principal.type === 'Group' ? 'users' : 'user'),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, a.email || a.principal.displayName),
        h('div', { class: 'row-sub' }, a.email ? t('wird als Gast eingeladen') : a.principal.detail || '')),
      h('span', { class: 'badge accent' }, t(ACCESS_LEVELS[a.level].label)),
      iconButton('x', t('Entfernen'), () => { access.splice(i, 1); drawAccess(); })))
    : [h('p', { class: 'muted small' }, t('Noch niemand – du selbst bekommst immer Bearbeiten und Verwalten.'))]);
  const add = (entry) => {
    access.push({ ...entry, level: level.value });
    search.value = '';
    results.replaceChildren();
    drawAccess();
  };
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) return results.replaceChildren();
      const found = await call('searchPrincipalsIn', q, current().tenantId).catch((e) => {
        toast(e.message, 'error');
        return [];
      });
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) ? q.toLowerCase() : null;
      const choices = found.map((p) => h('button', { type: 'button', class: 'choice', onclick: () => add({ principal: p }) },
        icon(p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.type === 'Group' ? t('Gruppe') : p.detail)));
      if (email && !found.some((p) => String(p.detail || '').toLowerCase() === email)) {
        choices.push(current().via === 'lighthouse'
          ? h('div', { class: 'muted small' }, t('Gäste lassen sich nicht über Azure Lighthouse einladen.'))
          : h('button', { type: 'button', class: 'choice', onclick: () => add({ email }) }, icon('plus'), h('span', {}, t('„{email}“ als Gast einladen', { email }))));
      }
      return results.replaceChildren(...choices);
    }, 300);
  });
  drawAccess();

  const syncLocation = () => {
    const l = rg.selectedOptions[0]?.dataset.location;
    if (l) loc.value = l;
  };
  const loadSubscription = async () => {
    const s = current();
    setChildren(subNotice, s.via === 'lighthouse'
      ? notice(t('Diese Subscription siehst du nur über Azure Lighthouse. So angelegte Key Vaults lassen sich nicht nutzen: Lighthouse vergibt keine Datenrollen und lädt keine Gäste ein. Lass dich im Kunden-Tenant als Gast einladen und gib dem Gastkonto Besitzer auf der Ressourcengruppe – dann erscheint die Subscription hier mit „Gast“.'), 'warn')
      : s.via === 'guest' ? notice(t('Wird im Tenant „{tenant}“ mit deinem Gastkonto angelegt; Gruppen und Personen stammen aus diesem Verzeichnis.', { tenant: s.tenantName || s.tenantId }), 'info') : null);
    access.length = 0;
    drawAccess();
    try {
      const [groups, locations] = await Promise.all([call('resourceGroups', s.id, s.tenantId), call('locations', s.id, s.tenantId)]);
      rg.replaceChildren(...groups.map((g) => h('option', { value: g.name, dataset: { location: g.location } }, g.name)));
      loc.replaceChildren(...locations.map((l) => h('option', { value: l.name }, l.displayName)));
      syncLocation();
      loadGroup();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  rg.addEventListener('change', () => {
    syncLocation();
    loadGroup();
  });
  sub.addEventListener('change', loadSubscription);
  display.addEventListener('input', () => {
    if (!name.dataset.touched) name.value = suggestVaultName(display.value);
  });
  name.addEventListener('input', () => {
    name.dataset.touched = '1';
  });
  const regionField = field(t('Region'), loc);
  const purgeLabel = h('label', { class: 'inline' }, purge, t('Löschschutz (Purge Protection) – empfohlen, nicht umkehrbar'));
  mode.addEventListener('change', () => { regionField.hidden = mode.value !== 'new'; });
  modal(t('Neuen Key-Vault-Tresor erstellen'), h('div', {},
    h('p', { class: 'muted' }, t('Legt einen Azure Key Vault (RBAC, Soft Delete) an und gibt dir Bearbeiten- und Verwalten-Rechte. Nötig: Besitzer (oder Mitwirkender + Benutzerzugriffsadministrator) auf der Ressourcengruppe.')),
    field(t('Anzeigename'), display),
    h('div', { class: 'grid2' }, field(t('Abonnement'), sub), field(t('Ressourcengruppe'), rg)),
    subNotice,
    field(t('Key Vault'), mode),
    rgNotice,
    newFields,
    existingFields,
    regionField,
    purgeLabel,
    h('h3', {}, t('Zugriff')),
    h('div', { class: 'field-row access-search' }, search, level),
    results,
    accessList), [
    { label: t('Abbrechen') },
    { label: t('Erstellen'), primary: true, onClick: async () => {
      const s = current();
      if (s.via === 'lighthouse') throw new Error(t('Über Azure Lighthouse lässt sich hier kein nutzbarer Tresor anlegen (siehe Hinweis).'));
      if (!rg.value) throw new Error(t('Bitte eine Ressourcengruppe wählen'));
      const members = access.filter((a) => a.principal).map((a) => ({ principal: a.principal, level: a.level }));
      const guests = access.filter((a) => a.email).map((a) => ({ email: a.email, level: a.level }));
      if (mode.value === 'existing') {
        const option = existing.selectedOptions[0];
        if (!option?.value || option.disabled) throw new Error(t('Bitte einen leeren Key Vault wählen'));
        const r = await call('adoptVault', {
          subscriptionId: s.id, tenantId: s.tenantId, via: s.via, vaultUrl: option.value, resourceId: option.dataset.resourceId,
          displayName: display.value.trim() || option.dataset.name, members, guests,
        });
        for (const w of r.warnings) toast(w, 'error');
        if (!r.warnings.length) toast(t('Key Vault als Tresor eingerichtet'));
        ui.containerId = r.id;
        ui.view = 'container';
        return reloadAll();
      }
      if (rgPermissions && !rgPermissions.createVault) throw new Error(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen'));
      toast(t('Tresor wird erstellt …'));
      const r = await call('createContainer', {
        subscriptionId: s.id, tenantId: s.tenantId, via: s.via, resourceGroup: rg.value, location: loc.value,
        name: name.value.trim(), displayName: display.value.trim() || name.value.trim(), purgeProtection: purge.checked,
        members,
        guests,
      });
      for (const w of r.warnings) toast(w, 'error');
      if (!r.warnings.length) toast(t('Tresor erstellt. Neue Rollen können einige Minuten brauchen, bis sie wirken.'));
      ui.containerId = r.id;
      ui.view = 'container';
      await reloadAll();
    } },
  ]);
  await loadSubscription();
}

async function shareDialog(container) {
  const listEl = h('div', {}, h('span', { class: 'spinner' }));
  const search = h('input', { placeholder: t('Name, E-Mail oder Sicherheitsgruppe suchen …') });
  const results = h('div', { class: 'search-results' });
  const level = h('select', {}, ...Object.entries(ACCESS_LEVELS).map(([k, v]) => h('option', { value: k, selected: k === 'write' }, t(v.label))));
  const chosenEl = h('div', { class: 'chosen muted' }, t('Niemand ausgewählt'));
  let chosen = null;

  const load = async () => {
    try {
      const members = await call('members', container.id);
      listEl.replaceChildren(...(members.length ? members.map(memberRow) : [h('p', { class: 'muted' }, t('Keine Rollenzuweisungen gefunden.'))]));
    } catch (e) {
      listEl.replaceChildren(notice(e.message));
    }
  };
  const memberRow = (m) => h('div', { class: 'member' },
    icon(m.principalType === 'Group' ? 'users' : 'user'),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, m.displayName),
      h('div', { class: 'row-sub' }, [m.detail, m.assignments.map((a) => (a.inherited ? t('{role} (geerbt)', { role: a.label }) : a.label)).join(', ')].filter(Boolean).join(' · '))),
    h('span', { class: m.level === 'none' ? 'badge warn' : 'badge accent' }, t(LEVEL_LABEL[m.level])),
    m.removable ? iconButton('trash', t('Zugriff entfernen'), async () => {
      if (!(await confirmDialog(t('Zugriff entfernen'), t('Zugriff von „{who}“ auf „{name}“ entfernen?', { who: m.displayName, name: container.name }), { confirmLabel: t('Entfernen'), danger: true }))) return;
      try {
        await call('removeMember', container.id, m.principalId);
        toast(t('Zugriff entfernt'));
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }) : null);

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const query = search.value.trim();
      const found = await call('searchPrincipals', query, container.id).catch((e) => {
        toast(e.message, 'error');
        return [];
      });
      // Unknown e-mail address: offer to invite the person as guest into the vault's tenant.
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query) ? query.toLowerCase() : null;
      if (email && !found.some((p) => [p.detail, p.mail].some((v) => String(v || '').toLowerCase() === email))) {
        found.push({ invite: true, email, type: 'User', displayName: t('„{email}“ als Gast einladen', { email }), detail: t('Neue Person im Verzeichnis dieses Key Vaults') });
      }
      results.replaceChildren(...found.map((p) => h('button', { type: 'button', class: 'choice', onclick: () => {
        chosen = p;
        chosenEl.textContent = p.invite ? t('{email} (wird als Gast eingeladen)', { email: p.email }) : `${p.displayName} – ${p.type === 'Group' ? t('Gruppe') : p.detail}`;
        chosenEl.classList.remove('muted');
        results.replaceChildren();
      } }, icon(p.invite ? 'plus' : p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.detail))));
    }, 300);
  });

  const add = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    if (!chosen) {
      toast(t('Bitte zuerst eine Person oder Gruppe auswählen'), 'error');
      return;
    }
    add.disabled = true;
    try {
      const r = chosen.invite
        ? await call('inviteGuest', container.id, chosen.email, level.value)
        : await call('addMember', container.id, chosen, level.value);
      toast(chosen.invite
        ? t('{email} als Gast eingeladen und freigegeben – die Person bekommt eine Einladungs-E-Mail', { email: chosen.email })
        : r.discoverable ? t('Freigegeben') : t('Freigegeben – Einladungslink senden, damit der Tresor automatisch erscheint'));
      chosen = null;
      chosenEl.textContent = t('Niemand ausgewählt');
      chosenEl.classList.add('muted');
      search.value = '';
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      add.disabled = false;
    }
  } }, icon('plus'), t('Freigeben'));

  modal(t('„{name}“ freigeben', { name: container.name }), h('div', {},
    h('p', { class: 'muted small' }, t('Freigaben sind Azure-Rollenzuweisungen auf dem Key Vault: Lesen = Key Vault Secrets User, Bearbeiten = Key Vault Secrets Officer, Verwalten = zusätzlich Key Vault Data Access Administrator.')),
    container.protected ? notice(t('Der Tresor ist zusätzlich geschützt: Neue Mitglieder brauchen außerdem eine Einladung (Schutz und Benutzer → Benutzer einladen).'), 'info') : null,
    h('h3', {}, t('Zugriff hinzufügen')),
    search,
    results,
    h('div', { class: 'field-row', style: { marginTop: '8px', gap: '8px' } }, chosenEl, h('div', { style: { width: '150px' } }, level), add),
    h('h3', {}, t('Mitglieder')),
    listEl,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: async () => copy(await call('invite', container.id), t('Einladungslink')) }, icon('link'), t('Einladungslink kopieren')))),
  [{ label: t('Schließen') }]);
  load();
}

function trashDialog(container) {
  const listEl = h('div', {}, h('span', { class: 'spinner' }));
  const load = async () => {
    const entries = await call('trash', container.id);
    listEl.replaceChildren(...(entries.length ? entries.map((e) => h('div', { class: 'member' },
      icon('trash'),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, e.title),
        h('div', { class: 'row-sub' }, e.scheduledPurgeDate
          ? t('gelöscht {deleted} · endgültig ab {purge}', { deleted: formatDateTime(e.deletedDate), purge: formatDateTime(e.scheduledPurgeDate) })
          : t('gelöscht {deleted}', { deleted: formatDateTime(e.deletedDate) }))),
      h('button', { type: 'button', class: 'btn small', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await call('restore', container.id, e.id);
          toast(t('Wiederhergestellt'));
          await reloadAll();
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, t('Wiederherstellen')),
      !featureAllowed(container, 'purge') ? null : h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
        if (!(await confirmDialog(t('Endgültig löschen'), t('„{title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.', { title: e.title }), { confirmLabel: t('Endgültig löschen'), danger: true }))) return;
        try {
          await call('purge', container.id, e.id);
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, t('Endgültig löschen')))) : [h('p', { class: 'muted' }, t('Der Papierkorb ist leer.'))]));
  };
  modal(t('Papierkorb – {name}', { name: container.name }), h('div', {},
    container.kind === 'file' ? null : h('p', { class: 'muted small' }, t('Gelöschte Einträge bleiben im Key Vault (Soft Delete) bis zum Ende der Aufbewahrungsfrist. Mit Löschschutz ist endgültiges Löschen erst danach möglich.')),
    listEl), [{ label: t('Schließen') }]);
  load().catch((e) => listEl.replaceChildren(notice(e.message)));
}

async function historyDialog(item) {
  let versions;
  try {
    versions = await call('history', item.containerId, item.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(t('Verlauf – {title}', { title: item.title }), h('div', {}, ...versions.map((v, i) => h('div', { class: 'member' },
    icon('history'),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, formatDateTime(v.updated), i === 0 ? h('span', { class: 'badge accent' }, t('aktuell')) : null),
      h('div', { class: 'row-sub mono' }, String(v.version).slice(0, 16))),
    i > 0 ? h('button', { type: 'button', class: 'btn small', onclick: () => showVersion(item, v) }, t('Anzeigen')) : null))),
  [{ label: t('Schließen') }]);
}

async function showVersion(item, v) {
  let old;
  try {
    old = await call('version', item.containerId, item.id, v.version);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(t('Version vom {date}', { date: formatDateTime(v.updated) }), itemDetail(old, { copy, openUrl, containerName }), [
    { label: t('Schließen') },
    { label: t('Diese Version wiederherstellen'), primary: true, onClick: async () => {
      await call('restoreVersion', item.containerId, item.id, v.version);
      toast(t('Version wiederhergestellt'));
      await reloadAll();
    } },
  ]);
}

function moveDialog(item) {
  const targets = writableContainers().filter((c) => c.id !== item.containerId);
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Eintrag verschieben'), h('div', {},
    field(t('„{title}“ verschieben nach', { title: item.title }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle in den Papierkorb verschoben. Der bisherige Verlauf bleibt in der Quelle.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      const saved = await call('move', item.containerId, target.value, item.id);
      ui.selected = saved.key;
      toast(t('Verschoben'));
      await reloadAll();
    } },
  ]);
}

function openImport(container) {
  importDialog({
    containers: writableContainers(),
    defaultContainer: container?.id || st.settings.defaultContainer,
    existing: async (containerId) => items.filter((i) => i.containerId === containerId),
    save: async (containerId, list, onProgress) => {
      const listener = (ev) => onProgress(ev.done, ev.total);
      progressListeners.add(listener);
      try {
        return await call('importItems', containerId, list);
      } finally {
        progressListeners.delete(listener);
      }
    },
    download: () => call('saveSampleCsv').then((p) => p && toast(t('Gespeichert'))),
    onDone: () => reloadAll(),
  });
}

// ---------------------------------------------------------------- AI agents: released vaults and folders

const mcpScopes = () => (Array.isArray(st.settings.mcpScopes) ? st.settings.mcpScopes : []);
const mcpShared = (vaultId, folder) => mcpScopes().some((x) => x.vaultId === vaultId && (x.folder || '') === folder);

async function setMcpScopes(next) {
  await call('updateSettings', { mcpScopes: next });
  st.settings.mcpScopes = next;
}

async function toggleMcpScope(vaultId, folder) {
  const shared = mcpShared(vaultId, folder);
  await setMcpScopes(shared ? mcpScopes().filter((x) => !(x.vaultId === vaultId && (x.folder || '') === folder)) : [...mcpScopes(), { vaultId, folder }]);
  toast(shared ? t('Freigabe für KI-Agenten aufgehoben') : t('Für KI-Agenten freigegeben'));
}

/** Context menu entry (vault: folder ''), only while agents are on and limited to released areas. */
const mcpScopeAction = (vaultId, folder) => (st.settings.mcpEnabled && st.settings.mcpScope !== 'all'
  ? { action: 'mcp-scope', icon: 'link', label: mcpShared(vaultId, folder) ? t('Freigabe für KI-Agenten aufheben') : t('Für KI-Agenten freigeben'), onClick: () => toggleMcpScope(vaultId, folder) }
  : null);

// ---------------------------------------------------------------- reports (password check, access report)

/** What the report dialogs need from the app. */
function reportCtx(containerId = null) {
  return {
    call,
    containerId,
    containerName,
    openItem: (i) => {
      ui.view = 'container';
      ui.containerId = i.containerId;
      ui.folder = i.folder || '';
      ui.folderOf = i.containerId;
      ui.selected = i.key;
      ui.editing = null;
      render();
    },
  };
}

let expiryReminded = false;

/** Once per unlock: entries that have expired or expire within 30 days. */
function expiryReminder() {
  if (expiryReminded || !st?.opened) return;
  const due = expiringEntries(items);
  if (!due.length) return;
  expiryReminded = true;
  const expired = due.filter((x) => x.state === 'expired').length;
  const first = due[0].entry;
  toast(expired
    ? t('{expired} Einträge abgelaufen, {soon} laufen bald ab – z. B. „{title}“', { expired, soon: due.length - expired, title: first.title })
    : t('{soon} Einträge laufen in den nächsten 30 Tagen ab – z. B. „{title}“ in {days} Tagen', { soon: due.length, title: first.title, days: daysUntil(first.expires) }), 'warn');
}

// ---------------------------------------------------------------- updates

const updateListeners = new Set();

/** Release notes from the signed manifest (CHANGELOG section) as a list; "- " lines are items, others plain text. */
function releaseNotes(notes) {
  const text = notesForLanguage(notes, getLanguage());
  if (!text) return null;
  const items = [];
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) items.push(h('li', {}, line.slice(2)));
    else if (line.trim() && items.length) items[items.length - 1].append(' ', line.trim());
    else if (line.trim()) items.push(h('p', {}, line.trim()));
  }
  return h('div', { class: 'release-notes' }, h('h4', {}, t('Neu in dieser Version')),
    h('ul', {}, ...items.filter((x) => x.tagName === 'LI')), ...items.filter((x) => x.tagName !== 'LI'));
}

/**
 * "Check for updates" (version label, settings, tray): result, download progress, install. With `offered` (new
 * version found at start, mode "ask") the dialog shows that result right away – "Later" closes it.
 */
async function updateDialog(offered) {
  const body = h('div', {});
  const { close } = modal(offered ? t('Update verfügbar') : t('Updates'), body, [{ label: offered ? t('Später') : t('Schließen') }]);
  const draw = (s) => {
    if (!s) return;
    const managed = s.kind === 'msi' || s.kind === 'msix';
    if (s.status === 'checking') return body.replaceChildren(h('p', {}, h('span', { class: 'spinner' }), ' ', t('Suche nach Updates …')));
    if (s.status === 'error') return body.replaceChildren(notice(t('Update fehlgeschlagen: {message}', { message: s.error })));
    if (s.status === 'downloading') {
      return body.replaceChildren(h('p', {}, t('Version {version} wird heruntergeladen …', { version: s.version || '' })),
        h('progress', { class: 'update-progress', max: 100, value: s.progress || 0 }));
    }
    if (s.status === 'none') return body.replaceChildren(h('p', {}, t('Keevault {version} ist aktuell.', { version: s.current })));
    if (s.status === 'available' || s.status === 'ready') {
      const notes = releaseNotes(s.notes);
      return body.replaceChildren(
        h('p', {}, t('Version {version} ist verfügbar (installiert: {current}).', { version: s.version, current: s.current })),
        ...(notes ? [notes] : []),
        managed
          ? h('p', { class: 'muted small' }, t('Diese Installation (MSI/MSIX) wird von deiner IT bzw. über das Windows-Paket aktualisiert.'))
          : h('p', { class: 'muted small' }, t('Keevault lädt das Update von keevault.de, installiert es und startet neu. Deine Daten bleiben unverändert.')),
        managed
          ? h('button', { type: 'button', class: 'btn', onclick: () => openUrl('https://keevault.de/download.html') }, icon('external', 14), t('Download-Seite öffnen'))
          : h('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await call('installUpdate');
            } catch (err) {
              toast(err.message, 'error');
            }
          } }, icon('download', 14), s.status === 'ready' ? t('Jetzt installieren und neu starten') : t('Jetzt aktualisieren')));
    }
    return undefined;
  };
  updateListeners.add(draw);
  body.closest('dialog')?.addEventListener('close', () => updateListeners.delete(draw));
  if (offered) {
    draw(offered);
    return close;
  }
  draw({ status: 'checking' });
  try {
    draw(await call('checkForUpdates'));
  } catch (e) {
    draw({ status: 'error', error: e.message });
  }
  return close;
}

function settingsDialog() {
  const s = st.settings;
  const enforced = (k) => s.enforced.includes(k);
  const language = h('select', { disabled: enforced('language') },
    ...Object.entries(LANGUAGES).map(([k, label]) => h('option', { value: k, selected: s.language === k }, k === 'auto' ? t(label) : label)));
  const tenant = h('input', { value: s.tenantId, disabled: enforced('tenantId'), placeholder: t('automatisch') });
  const client = h('input', { value: s.clientId, disabled: enforced('clientId'), placeholder: t('automatisch') });
  const directory = h('select', { disabled: enforced('tenantId') || !st.signedIn, onchange: async () => {
    directory.disabled = true;
    try {
      const r = await call('switchTenant', directory.value);
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      tenant.value = directory.value;
      s.tenantId = directory.value;
      toast(t('Verzeichnis gewechselt'));
      await reloadAll();
    } catch (e) {
      toast(e.message, 'error');
    }
    directory.disabled = false;
  } }, h('option', { value: '' }, t('Standardverzeichnis meines Kontos')));
  if (st.signedIn) {
    call('tenants').then((list) => {
      for (const x of list) directory.append(h('option', { value: x.tenantId, selected: x.tenantId === s.tenantId }, x.domain ? x.name + ' (' + x.domain + ')' : x.name));
    }, () => {});
  }
  const autoLock = h('input', { type: 'number', min: 0, max: 1440, value: s.autoLockMinutes, disabled: enforced('autoLockMinutes') });
  const clip = h('input', { type: 'number', min: 0, max: 600, value: s.clipboardSeconds, disabled: enforced('clipboardSeconds') });
  const prompt = h('select', { disabled: enforced('unlockPrompt') },
    ...[['none', 'Ohne Rückfrage, wenn möglich (SSO, Standard)'], ['select_account', 'Konto bestätigen'], ['login', 'Immer neu anmelden (Passwort/MFA)']]
      .map(([v, l]) => h('option', { value: v, selected: s.unlockPrompt === v }, t(l))));
  const browser = h('input', { type: 'checkbox', checked: s.browserIntegration });
  const windowsProvider = h('input', { type: 'checkbox', checked: s.windowsProvider });
  const windowsStatus = h('div', { class: 'muted small' }, h('span', { class: 'spinner' }));
  call('windowsProviderStatus').then((w) => windowsStatus.replaceChildren(!w.supported ? t('Nur unter Windows 11 verfügbar.')
    : !w.installed ? t('Nicht installiert – windows/Install-PasskeyProvider.ps1 ausführen (siehe README).')
      : w.enabled ? t('Installiert und in Windows aktiviert.')
        : w.registered ? t('Installiert, aber in Windows noch nicht aktiviert (Einstellungen → Konten → Passkeys → Erweiterte Optionen).')
          : t('Installiert, aber noch nicht bei Windows registriert.')), () => windowsStatus.replaceChildren());
  const extensionIds = h('input', { value: s.extensionIds.join(', '), disabled: enforced('extensionIds') });
  const signInWindows = h('input', { type: 'checkbox', checked: s.signInWindows !== false });
  const autoTypeKeys = h('select', {},
    ...[['CommandOrControl+Shift', 'Strg+Umschalt+U / P / O'], ['CommandOrControl+Alt', 'Strg+Alt+U / P / O'], ['', 'Aus (nur im App-Fenster)']]
      .map(([v, l]) => h('option', { value: v, selected: s.autoTypeKeys === v }, t(l))));
  const mcpEnabled = h('input', { type: 'checkbox', checked: !!s.mcpEnabled, disabled: enforced('mcpEnabled') });
  const offlineMirror = h('input', { type: 'checkbox', checked: !!s.offlineMirror && st.pinSet, disabled: enforced('offlineMirror') || !st.pinSet });
  const mcpBox = h('div', {});
  const mcpMode = h('select', {},
    h('option', { value: 'selected', selected: s.mcpScope !== 'all' }, t('Nur freigegebene Tresore und Ordner (empfohlen)')),
    h('option', { value: 'all', selected: s.mcpScope === 'all' }, t('Alle Tresore, auf die ich Zugriff habe')));
  const scopeList = h('div', {});
  const vaultName = (id) => st.containers.find((c) => c.id === id)?.name || id;
  const drawScopes = () => scopeList.replaceChildren(...(mcpScopes().length ? mcpScopes().map((x) => h('div', { class: 'inline' },
    icon(x.folder ? 'folder' : 'vault', 14), h('span', {}, x.folder ? `${vaultName(x.vaultId)} / ${x.folder}` : t('{vault} (ganzer Tresor)', { vault: vaultName(x.vaultId) })),
    h('button', { type: 'button', class: 'btn small', onclick: async () => {
      await setMcpScopes(mcpScopes().filter((y) => !(y.vaultId === x.vaultId && (y.folder || '') === (x.folder || ''))));
      drawScopes();
    } }, t('Entfernen')))) : [h('p', { class: 'muted small' }, t('Noch nichts freigegeben – Agenten sehen keine Einträge.'))]));
  const scopeVault = h('select', {}, ...st.containers.filter((c) => !c.error).map((c) => h('option', { value: c.id }, c.name)));
  const scopeFolder = h('select', {});
  const fillFolders = async () => {
    const id = scopeVault.value;
    const paths = new Set([...items.filter((i) => i.containerId === id).map((i) => i.folder), ...(explicitFolders.get(id) || await call('folders', id).catch(() => []))].filter(Boolean));
    for (const p of [...paths]) p.split('/').forEach((_, n, parts) => paths.add(parts.slice(0, n + 1).join('/')));
    scopeFolder.replaceChildren(h('option', { value: '' }, t('Ganzer Tresor')), ...[...paths].sort().map((p) => h('option', { value: p }, p)));
  };
  scopeVault.addEventListener('change', fillFolders);
  if (s.mcpEnabled) {
    fillFolders();
    drawScopes();
  }
  const scopeAdd = h('button', { type: 'button', class: 'btn small', onclick: async () => {
    if (!scopeVault.value) return;
    if (!mcpShared(scopeVault.value, scopeFolder.value)) await setMcpScopes([...mcpScopes(), { vaultId: scopeVault.value, folder: scopeFolder.value }]);
    drawScopes();
  } }, icon('plus', 14), t('Freigeben'));
  if (s.mcpEnabled) {
    call('mcpInfo').then((info) => {
      const snippet = (label, text) => h('div', { class: 'field' }, h('label', {}, label),
        h('pre', { class: 'snippet' }, text),
        h('button', { type: 'button', class: 'btn small', onclick: () => navigator.clipboard.writeText(text).then(() => toast(t('Kopiert'))) }, icon('copy', 14), t('Kopieren')));
      mcpBox.replaceChildren(
        h('p', { class: 'muted small' }, t('In den KI-Client eintragen – danach den Client neu starten. Beim ersten Zugriff fragt Keevault, ob du den Agenten erlaubst.')),
        snippet(t('Claude Desktop (claude_desktop_config.json)'), info.claudeDesktop),
        snippet(t('Claude Code (Befehl im Terminal)'), info.claudeCode),
        snippet(t('VS Code / GitHub Copilot (.vscode/mcp.json oder Benutzer-mcp.json)'), info.vscode),
        snippet(t('Andere MCP-Clients (stdio)'), `command: ${info.command}\nargs: ${info.args.join(' ')}\nenv: ELECTRON_RUN_AS_NODE=1`),
        h('div', { class: 'field' }, h('label', {}, t('Erlaubte Agenten')),
          info.agents.length ? h('div', {}, ...info.agents.map((a) => {
            const session = info.sessions.find((x) => x.agent === a);
            const rule = info.rules?.[a] || { write: true, until: null };
            const writeSel = h('select', { onchange: async () => { await call('mcpAgentRule', a, { write: writeSel.value === 'rw' }); toast(t('Gespeichert')); } },
              h('option', { value: 'rw', selected: rule.write !== false }, t('Lesen und Schreiben')), h('option', { value: 'ro', selected: rule.write === false }, t('Nur lesen')));
            const untilSel = h('select', { onchange: async () => { await call('mcpAgentRule', a, { days: Number(untilSel.value) }); toast(t('Gespeichert')); } },
              h('option', { value: '0', selected: !rule.until }, t('unbegrenzt')), ...[1, 7, 30, 90].map((d) => h('option', { value: String(d) }, t('{n} Tage', { n: d }))));
            return h('div', { class: 'inline' }, h('span', {}, a), writeSel, untilSel,
              rule.until ? h('span', { class: 'badge' }, t('bis {date}', { date: new Date(rule.until).toLocaleDateString() })) : null,
              session ? h('span', { class: 'badge accent' }, t('Passwörter freigegeben bis {time}', { time: new Date(session.until).toLocaleTimeString() })) : null,
              h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
                await call('mcpRemoveAgent', a);
                e.currentTarget.closest('.inline').remove();
                toast(t('Entfernt'));
              } }, t('Entfernen')));
          })) : h('p', { class: 'muted small' }, t('Noch kein Agent verbunden.'))),
      );
    }, () => {});
  }
  const updateMode = h('select', { disabled: enforced('updateMode') },
    ...[['ask', 'Beim Start prüfen und Update anbieten (Standard)'], ['auto', 'Automatisch aktuell halten'], ['off', 'Aus – nur manuell suchen']]
      .map(([v, l]) => h('option', { value: v, selected: (s.updateMode || 'ask') === v }, t(l))));
  const machine = h('div', { class: 'muted small' });
  const drawMachine = (x) => {
    if (!x?.supported) return machine.replaceChildren();
    const yes = (v) => (v ? t('ja') : t('nein'));
    const button = h('button', { type: 'button', class: 'btn small', onclick: async () => {
      button.disabled = true;
      try {
        drawMachine((await call('runMachineSetup')).machine);
        toast(t('Gerät eingerichtet – Edge/Chrome ggf. neu starten'));
      } catch (e) {
        toast(e.message, 'error');
        button.disabled = false;
      }
    } }, t('Mit Administratorrechten einrichten'));
    return machine.replaceChildren(
      h('div', {}, t('Zertifikat des Passkey-Anbieters vertraut: {v}', { v: yes(x.certTrusted) })),
      h('div', {}, t('Erweiterungs-Richtlinie Edge: {edge} · Chrome: {chrome}', { edge: yes(x.edgePolicy), chrome: yes(x.chromePolicy) })),
      (!x.certTrusted || !x.edgePolicy) && x.canRunSetup ? button : null);
  };
  call('machineSetupStatus').then(drawMachine, () => {});
  modal(t('Einstellungen'), h('div', {},
    field(t('Sprache'), language),
    h('div', { class: 'grid2' },
      field(t('Automatisch sperren nach (Minuten)'), autoLock, t('0 = nur beim Sperren des Computers')),
      field(t('Zwischenablage leeren nach (Sekunden)'), clip, t('0 = nie'))),
    h('h3', {}, t('Microsoft Entra ID (Key-Vault-Tresore)')),
    st.account ? h('p', { class: 'muted small' }, t('Angemeldet als {user}', { user: st.account.username })) : h('p', { class: 'muted small' }, t('Keine IDs nötig: Melde dich einfach an, deine Key Vaults werden automatisch gesucht.')),
    field(t('Verzeichnis (Tenant)'), directory),
    h('details', { open: st.ownApp || undefined }, h('summary', {}, t('Eigene App-Registrierung (optional)')),
      h('p', { class: 'muted small' }, t('Leer lassen für die Standard-Anmeldung. Eigene App-Registrierung: infra/Setup-KvPwSafe.ps1.')),
      h('div', { class: 'grid2' }, field(t('Tenant-ID'), tenant), field(t('Client-ID'), client))),
    field(t('Entsperren'), prompt),
    st.platform === 'win32' ? h('label', { class: 'inline' }, signInWindows, t('Anmeldung im Windows-Dialog (wie PowerShell/Azure CLI) statt im Browser')) : null,
    h('h3', {}, t('Browser-Erweiterung')),
    h('label', { class: 'inline' }, browser, t('Datei-Tresore in der Browser-Erweiterung verfügbar machen')),
    h('p', { class: 'muted small' }, t('Registriert einen Native-Messaging-Host für Edge und Chrome (nur für dein Benutzerkonto). Die Erweiterung fragt beim ersten Zugriff nach deiner Zustimmung in dieser App.')),
    field(t('Erweiterungs-IDs'), extensionIds),
    h('h3', {}, t('Windows-Passkey-Anbieter')),
    h('label', { class: 'inline' }, windowsProvider, t('Keevault als Passkey-Anbieter in Windows verwenden (wie 1Password)')),
    h('p', { class: 'muted small' }, t('Dann erscheint Keevault im Windows-Passkey-Dialog – auch für andere Browser und Apps. Jede Anmeldung bestätigst du in dieser App.')),
    windowsStatus,
    h('h3', {}, t('Abtippen (Auto-Type)')),
    field(t('Tastenkürzel, überall in Windows'), autoTypeKeys, t('Eintrag in der App auswählen, ins Zielfeld klicken, Kürzel drücken: U = Benutzername, P = Passwort, O = Einmalcode. Gilt nur, solange die App entsperrt ist; Strg+Umschalt überdeckt in Edge Vorlesen/InPrivate/Favoriten.')),
    h('h3', {}, t('App-PIN')),
    h('p', { class: 'muted small' }, st.pinSet
      ? t('Eine PIN ist gesetzt und wird beim Entsperren abgefragt.')
      : `${t('Keine PIN – jeder an diesem PC kann die App entsperren, solange Windows angemeldet ist.')} ${t('Tipp: Mit einer PIN (unter Einstellungen) entsperrst du ohne neues Microsoft-Fenster – deine Tresore erscheinen sofort.')}`),
    st.opened ? h('button', { type: 'button', class: 'btn small', onclick: () => pinDialog() }, icon('key', 14), st.pinSet ? t('PIN ändern') : t('PIN festlegen'))
      : h('p', { class: 'muted small' }, t('Zum Ändern zuerst entsperren.')),
    h('h3', {}, t('Offline-Lesemodus')),
    h('label', { class: 'inline' }, offlineMirror, t('Einträge verschlüsselt für unterwegs spiegeln (nur lesen, PIN nötig)')),
    h('p', { class: 'muted small' }, st.pinSet
      ? t('Ohne Netzwerk zeigt Keevault den letzten Stand – nur lesen, keine Änderungen. Der Spiegel liegt AES-256-verschlüsselt im Profil; zum Öffnen braucht es dein Windows-Konto und die PIN. Er füllt sich beim nächsten Entsperren mit PIN.')
      : t('Dafür zuerst eine App-PIN festlegen – sie schützt den Offline-Speicher zusammen mit deinem Windows-Konto.')),
    h('h3', {}, t('KI-Agenten (MCP)')),
    h('label', { class: 'inline' }, mcpEnabled, t('KI-Agenten wie Claude oder GitHub Copilot anbinden (Model Context Protocol)')),
    h('p', { class: 'muted small' }, t('Agenten sehen beim Suchen nur Titel, Benutzer und URL. Passwörter lesen erlaubst du pro Sitzung, Einträge anlegen oder ändern bestätigst du jedes Mal. Löschen ist nicht möglich. Läuft Keevault nicht oder ist gesperrt, bekommt der Agent nichts.')),
    s.mcpEnabled ? h('div', {},
      field(t('Zugriff für KI-Agenten'), mcpMode, t('Freigeben geht auch per Rechtsklick auf einen Tresor oder Ordner. Ein freigegebener Ordner schließt seine Unterordner ein.')),
      h('div', { class: 'field' }, h('label', {}, t('Freigegeben')), scopeList,
        h('div', { class: 'inline' }, scopeVault, scopeFolder, scopeAdd)),
      mcpBox) : h('p', { class: 'muted small' }, t('Nach dem Einschalten und Speichern erscheinen hier die Einstellungen für deinen KI-Client.')),
    h('h3', {}, t('Updates')),
    st.updateKind === 'msi' || st.updateKind === 'msix'
      ? h('p', { class: 'muted small' }, t('Diese Installation (MSI/MSIX) wird von deiner IT bzw. über das Windows-Paket aktualisiert.'))
      : field(t('Automatische Updates'), updateMode, t('„Automatisch“ installiert neue Versionen, sobald die App gesperrt ist oder beendet wird. Die Updates kommen von keevault.de.')),
    h('button', { type: 'button', class: 'btn small', onclick: () => updateDialog() }, icon('download', 14), t('Jetzt nach Updates suchen')),
    h('h3', {}, t('Einrichtung dieses Geräts')),
    machine,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        try {
          const r = await call('windowsProviderRegister');
          toast(r.registered ? t('Bei Windows registriert') : t('Registrierung fehlgeschlagen ({code})', { code: r.hresult }), r.registered ? 'info' : 'error');
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, t('Bei Windows registrieren')),
      h('button', { type: 'button', class: 'btn small', onclick: () => call('openWindowsPasskeySettings') }, t('Windows-Einstellungen öffnen'))),
    s.enforced.length ? h('p', { class: 'muted small' }, t('Ausgegraute Werte sind über kvpwsafe.config.json vorgegeben.')) : null,
    h('p', { class: 'muted small' }, t('Version {version}', { version: st.version })),
    st.signedIn ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
      await call('signOut');
      render();
    } }, icon('logout'), t('Abmelden und Token-Cache löschen')) : null), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      const changedTenant = tenant.value.trim() !== s.tenantId || client.value.trim() !== s.clientId;
      await call('updateSettings', {
        language: language.value,
        tenantId: tenant.value.trim(),
        clientId: client.value.trim(),
        autoLockMinutes: Number(autoLock.value) || 0,
        clipboardSeconds: Number(clip.value) || 0,
        unlockPrompt: prompt.value,
        browserIntegration: browser.checked,
        windowsProvider: windowsProvider.checked,
        autoTypeKeys: autoTypeKeys.value,
        signInWindows: signInWindows.checked,
        updateMode: updateMode.value,
        mcpEnabled: mcpEnabled.checked,
        offlineMirror: offlineMirror.checked && st.pinSet,
        mcpScope: mcpMode.value,
        extensionIds: extensionIds.value.split(/[\s,;]+/).filter((x) => /^[a-p]{32}$/.test(x)),
      });
      if (changedTenant && st.signedIn) await call('switchTenant', tenant.value.trim());
      toast(t('Gespeichert'));
      await render();
    } },
  ]);
}

/**
 * Strg+Umschalt+U / P / O: types user name, password or current one-time code of the selected entry into the
 * previous window (the app minimizes itself first). Typing instead of pasting also works where pasting is blocked.
 */
async function typeSelected(what) {
  if (!ui.selected) return toast(t('Zuerst einen Eintrag auswählen'), 'error');
  try {
    const [containerId, id] = splitKey(ui.selected);
    return await call('autoType', containerId, id, what);
  } catch (e) {
    return toast(e.message, 'error');
  }
}

// Unexpected errors go to the diagnostics log (Einstellungen → Protokoll), without any secret values.
window.addEventListener('error', (e) => call('log', { level: 'error', message: e.message, detail: `${e.filename}:${e.lineno}` }).catch(() => {}));
window.addEventListener('unhandledrejection', (e) => call('log', { level: 'error', message: e.reason?.message || String(e.reason), detail: (e.reason?.stack || '').split(/\r?\n/).slice(0, 3).join(' / ') }).catch(() => {}));

document.addEventListener('keydown', (e) => {
  if (!st?.opened || document.querySelector('dialog[open]')) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    document.getElementById('search')?.focus();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newItem('login');
  } else if (e.ctrlKey && e.shiftKey && ['u', 'p', 'o'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    typeSelected(e.key.toLowerCase());
  } else if (e.key === 'Escape' && ui.editing) {
    ui.editing = null;
    renderDetail();
  } else if (e.key === 'Escape' && ui.multi.size) {
    ui.multi.clear();
    renderList();
    renderDetail();
  } else if (e.key === 'Delete' && ui.multi.size > 1 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    deleteManyDialog(multiItems());
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    for (const el of document.querySelectorAll('.list li.row-item[data-key]')) ui.multi.add(el.dataset.key);
    renderList();
    renderDetail();
  }
});

render().catch((e) => {
  document.body.dataset.ready = '1';
  root.replaceChildren(h('div', { class: 'splash' }, notice(e.message)));
});
