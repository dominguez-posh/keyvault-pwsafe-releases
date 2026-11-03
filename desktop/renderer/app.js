import { h, icon, iconButton, setChildren, toast, avatar, modal, confirmDialog, formatDateTime, passkeySuccess } from '../../extension/core/dom.js';
import { itemDetail, itemForm, generatorPanel } from '../../extension/core/ui-item.js';
import { DEFAULT_OPTIONS } from '../../extension/core/generator.js';
import { unlockPanel, manageDialog, enableDialog, setClipboardWriter, showRecoveryKey, strengthMeter } from '../../extension/core/ui-protect.js';
// Codes in dialogs (recovery key, invitation code) go through the app's clipboard like everything else.
setClipboardWriter((text) => call('copy', text));
import { importDialog } from '../../extension/core/ui-import.js';
import { ACCESS_LEVELS } from '../../extension/core/azure.js';
import { setLanguage, t, LANGUAGES, getLanguage, locale } from '../../extension/core/i18n.js';
import { pickImage, LOGO_MAX_CHARS } from '../../extension/core/image.js';
import { ROLE_NAMES, FILE_ROLES } from '../../extension/core/members.js';
import { MAX_FOLDER_DEPTH, entryTemplate, resolveLogin } from '../../extension/core/model.js';
import { expiryState, expiringEntries, daysUntil } from '../../extension/core/health.js';
import { healthDialog, accessReportDialog } from './reports.js';
import { releaseNotesSince } from '../../extension/core/release-notes.js';
import * as progress from './progress.js';
import { buildItemLink, parseItemLink } from '../../extension/core/links.js';
import { FOLDER_ICONS, MAX_FOLDER_IMAGE, isFolderImage } from '../../extension/core/folder-icons.js';

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
// Windows: the window has no title bar (desktop/main.js) – a drag strip at the top and room for the window buttons.
if (/Win/.test(navigator.platform)) document.documentElement.classList.add('frameless');
document.body.prepend(h('div', { class: 'drag-strip', 'aria-hidden': 'true' }));
// Search field in the top bar (above list and details); renderList puts the current view's field into it.
const topSearch = h('div', { class: 'top-search' });
// "New" in the top bar, at the content edge of the detail column.
const topActions = h('div', { class: 'top-actions' });
// Window buttons (drawn by Windows) are dimmed with the page while a dialog is open.
if (/Win/.test(navigator.platform)) {
  let dimmed = false;
  new MutationObserver(() => {
    const now = !!document.querySelector('dialog.modal[open]');
    if (now === dimmed) return;
    dimmed = now;
    window.pwsafe.invoke('titleBarDim', [now]).catch?.(() => {});
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
}
const panes = { sidebar: h('aside', { class: 'sidebar' }), list: h('section', { class: 'list-pane' }), detail: h('section', { class: 'detail-pane' }) };
const ui = { view: 'all', containerId: null, selected: null, editing: null, editingItem: null, query: '', folder: '', folderOf: null, multi: new Set(), multiFolders: new Set(), anchor: null, type: '', vaultQuery: '', searchAll: false, devices: false };
// Vaults that fit in the sidebar without scrolling; with more, the list scrolls and a search appears above it.
const VAULTS_FIT = 5;
const explicitFolders = new Map(); // containerId → created folders (also empty ones)
const folderIconMap = new Map(); // containerId → { [stored folder path]: symbol name or image data URL }
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
/** Every copy confirms itself ("… in die Zwischenablage kopiert") or says that it failed. */
const copy = (text, label = t('Wert')) => Promise.resolve(text).then((value) => call('copy', value))
  .then(() => toast(t('{label} in die Zwischenablage kopiert', { label })))
  .catch((e) => toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error'));
const openUrl = (url) => call('openExternal', url);
const formatDate = (iso) => new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);

/** Tab bar + panels for a dialog; the active tab per key survives closing (e.g. reopening the settings after Save). */
const activeTabs = {};
function tabbed(key, pages) {
  const panels = pages.map((p) => h('div', { class: 'tab-panel' }, ...p.content));
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = (i) => {
    activeTabs[key] = i;
    [...bar.children].forEach((b, n) => b.classList.toggle('active', n === i));
    panels.forEach((p, n) => { p.hidden = n !== i; });
  };
  pages.forEach((p, i) => bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(i) }, p.icon ? icon(p.icon, 16) : null, h('span', {}, p.label))));
  show(Math.min(activeTabs[key] || 0, pages.length - 1));
  return h('div', { class: 'tabbed' }, bar, ...panels);
}
const notice = (text, kind = 'error') => h('div', { class: `notice ${kind}` }, text);
const writable = (c) => c.access?.write !== false && !c.error && !c.locked;
const writableContainers = () => st.containers.filter(writable).map((c) => ({ id: c.id, name: c.name, personal: !!c.personal }));

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
    clearSelection();
    busyContainers.clear();
    items = [];
    render();
  } else if (ev.type === 'changed' && st?.opened) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadAll().catch(() => {}), 250);
  } else if (ev.type === 'changed' && st && !st.opened) {
    // Unlocked elsewhere (tray, an agent's request, a test): show the vaults. Still locked: the screen stays as it is.
    call('state').then((s) => { if (s.opened) render(); }).catch(() => {});
  } else if (ev.type === 'rdp-type-failed') {
    toast(t('Der Windows-Anmeldedialog kam nicht nach vorne – das Passwort liegt in der Zwischenablage, dort mit Strg+V einfügen.'), 'error');
  } else if (ev.type === 'sync-stopped' && st?.opened) {
    toast(t('{provider} läuft nicht – Änderungen an Tresoren in diesem Ordner werden nicht synchronisiert. Starte {provider}.', { provider: ev.provider }), 'error');
  } else if (ev.type === 'link') {
    const entry = parseItemLink(ev.url);
    if (entry) openItemLink(entry);
    else addContainerDialog(ev.url);
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
  } else if (ev.type === 'question') {
    questionDialog(ev);
  } else if (ev.type === 'questionClose') {
    openQuestions.get(ev.id)?.();
  } else if (ev.type === 'mcpTrusted') {
    loadAgentTrust();
  } else if (ev.type === 'passkeyFlash') {
    flashPasskey(ev.text);
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

/**
 * Question from the main process (AI agent wants to connect, read a password or change an entry): a dialog in the
 * app's style – agent badge, request, answers as buttons (the recommended one highlighted). Escape or × = cancel.
 */
const openQuestions = new Map(); // id → close without answer
// MCP argument names that differ from the item fields (FIELD_LABELS below).
const AGENT_FIELD_ALIAS = { url: 'urls', generatePassword: 'password' };
function questionDialog(q) {
  let answered = false;
  const answer = (value) => {
    if (answered) return;
    answered = true;
    openQuestions.delete(q.id);
    call('answerQuestion', q.id, value).catch(() => {});
  };
  const icons = { 'agent-connect': 'link', 'agent-read': 'key', 'agent-write': 'edit' };
  let choice = q.choices?.[0]?.value || 'allow';
  const options = (q.choices || []).map((c, i) => {
    const input = h('input', { type: 'radio', name: `q${q.id}`, value: c.value, checked: i === 0, onchange: () => { choice = c.value; } });
    return h('label', { class: 'q-option' }, input,
      h('span', { class: 'q-option-text' }, h('span', { class: 'q-option-label' }, c.label), c.hint ? h('span', { class: 'q-option-hint' }, c.hint) : null));
  });
  const target = q.entry ? h('div', { class: 'q-target' },
    h('span', { class: 'q-target-icon' }, icon(q.kind === 'agent-read' ? 'key' : 'edit', 16)),
    h('div', { class: 'q-target-text' }, h('div', { class: 'q-target-entry' }, q.entry), h('div', { class: 'q-target-vault' }, icon('vault', 12), q.vault || '')),
    q.fields?.length ? h('div', { class: 'q-fields' }, ...[...new Set(q.fields.map((f) => AGENT_FIELD_ALIAS[f] || f))].map((f) => h('span', { class: 'q-chip' }, FIELD_LABELS[f] ? t(FIELD_LABELS[f]) : f))) : null) : null;
  const allow = h('button', { type: 'button', class: 'btn primary', onclick: () => { answer(choice); close(); } }, q.allow || t('Erlauben'));
  const body = h('div', { class: `question ${q.kind}` },
    h('div', { class: 'q-hero' },
      h('span', { class: 'q-badge' }, icon(icons[q.kind] || 'shield', 26)),
      h('div', { class: 'q-hero-text' },
        h('div', { class: 'q-eyebrow' }, t('Anfrage eines KI-Agenten')),
        h('div', { class: 'q-title' }, q.title))),
    q.lead ? h('p', { class: 'q-lead' }, q.lead) : null,
    target,
    options.length ? h('div', { class: 'q-options', role: 'radiogroup' }, ...options) : null,
    q.note ? h('p', { class: 'q-note' }, icon('shield', 13), q.note) : null,
    h('div', { class: 'q-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { answer(q.cancel); close(); } }, t('Ablehnen')),
      allow));
  const { dialog, close } = modal('', body, []);
  dialog.classList.add('question-modal');
  dialog.addEventListener('close', () => answer(q.cancel));
  openQuestions.set(q.id, () => { answered = true; close(); });
  allow.focus();
}

/** Success moment after a passkey request from Windows: centred badge animation, gone after about a second. */
function flashPasskey(text) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = h('div', { class: 'passkey-flash' }, passkeySuccess(text));
  document.body.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, reduced ? 500 : 1300);
}

function windowsDialog(r) {
  const decide = async (decision) => {
    windowsDialogs.delete(r.id);
    await call('windowsDecision', r.id, decision);
    if (!decision.cancel) flashPasskey(r.kind === 'create' ? t('Passkey gespeichert') : t('Angemeldet'));
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
      ...r.logins.map((l, i) => h('option', { value: `${l.containerId}|${l.id}`, selected: i === 0 && l.sameUser }, `${l.title}${l.username ? ` – ${l.username}` : ''} (${l.container})`)));
    body = h('div', {}, head, lockedHint,
      h('p', {}, t('Passkey für {user} in Keevault speichern?', { user: r.user?.name || r.user?.displayName || t('dieses Konto') })),
      r.excluded ? notice(t('Für dieses Konto ist bereits ein Passkey im Tresor gespeichert. Die Website lehnt einen zweiten vermutlich ab.'), 'warn') : null,
      r.containers.length ? [
        field(t('Speichern in'), existing),
        field(t('Tresor'), container),
        field(t('Titel'), title),
      ] : notice(t('Kein Tresor mit Schreibrechten verfügbar.')));
    const syncExisting = () => {
      container.disabled = !!existing.value;
      title.disabled = !!existing.value;
    };
    existing.addEventListener('change', syncExisting);
    syncExisting();
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
  st = await fetchState();
  setLanguage(st.settings.language);
  document.title = 'Keevault';
  document.body.dataset.ready = '1';
  // Installed version, always at the bottom right (the detail pane keeps room below its content, see desktop.css).
  let versionTag = document.getElementById('app-version');
  if (!versionTag) document.body.append(versionTag = h('button', { id: 'app-version', type: 'button', onclick: () => updateDialog() }));
  applyViewClass();
  versionTag.textContent = `Keevault ${st.version}`;
  versionTag.title = t('Nach Updates suchen …');
  const firstRun = !st.hasFiles && !st.settings.entraUsed && !st.settings.enforced.includes('tenantId') && !st.settings.policyContainers.length;
  if (!st.opened && firstRun && !st.settings.setupOffered && !st.smoke && !st.demo) {
    // First start on this device, nothing set up yet: straight into the app (nothing to unlock), the wizards follow.
    try {
      await call('unlock', { entra: false });
      return render();
    } catch {
      return renderSetup();
    }
  }
  if (!st.opened) return firstRun ? renderSetup() : renderLocked();
  await loadItems();
  // Admin mode shows itself in the brand ("Keevault for Admins") and the copper accent – no extra badge.
  const shell = h('div', { class: 'shell' }, panes.sidebar, panes.list, panes.detail, topSearch, topActions);
  root.replaceChildren(shell);
  setupSplitters(shell);
  renderSidebar();
  renderList();
  checkWindowsRequests();
  loadLogos();
  if (st.requirePin && !st.pinSet && !document.querySelector('dialog[open]')) pinDialog({ forced: true });
  // First start on this device with nothing set up: the personal vault wizard, then the setup wizard for a team vault
  // (skipped when the personal vault brought the vaults along from another device). Each opens only once.
  // The desktop demo (fresh profile each start) shows the same first start, with example resources and its own PIN.
  else if ((st.demo ? st.platform !== 'web' : !st.containers.length) && !st.settings.setupOffered && !document.querySelector('dialog[open]') && !st.smoke) {
    call('updateSettings', { personalOffered: true, setupOffered: true }).catch(() => {});
    setTimeout(() => firstStartWizards({ always: st.demo }), 400);
  } else if (!document.querySelector('dialog[open]') && !st.smoke && !st.demo) checkOtherInstallation();
  await renderDetail();
  if (pendingItemLink) openItemLink(pendingItemLink);
}

// ---------------------------------------------------------------- resizable panes

// Default split: the list is the widest column (about half the window), the detail beside it.
// list: null = proportional (55 % of the width beside the sidebar) until the user drags it.
const PANE_DEFAULTS = { sidebar: 300, list: null };
// The sidebar never gets narrower than its head needs (logo, "Keevault for Admins", lock and menu button).
// The sidebar keeps room for longer vault names next to their marks (#19) – it is never dragged narrower than 280 px.
const PANE_LIMITS = { sidebar: [280, 420], list: [260, 960] };
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
    const wanted = widths.list ?? Math.round((shell.clientWidth - sidebar) * 0.55);
    const list = Math.max(PANE_LIMITS.list[0], Math.min(wanted, PANE_LIMITS.list[1], room > 0 ? room - sidebar : Infinity));
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
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add('dragging');
      shell.classList.add('resizing');
      const startX = e.clientX;
      const start = parseInt(shell.style.getPropertyValue(pane === 'list' ? '--list-w' : '--sidebar-w'), 10) || 0;
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
  await loadAgentTrust();
}

// Entries AI agents read without asking ("never ask again"): item key → agent names, for the context menu.
let agentTrust = new Map();
async function loadAgentTrust() {
  const map = new Map();
  for (const x of await call('mcpTrusted').catch(() => [])) {
    const key = `${x.vaultId}/${x.entryId}`;
    map.set(key, [...(map.get(key) || []), x.agent]);
  }
  agentTrust = map;
}

// Settings changed here (admin mode, view) count up: a state fetched before such a change keeps the newer settings –
// otherwise a reload that was under way switched the admin mode back in the window while it stayed on.
let settingsRev = 0;
async function fetchState() {
  const rev = settingsRev;
  const fresh = await call('state');
  return rev === settingsRev || !st ? fresh : { ...fresh, settings: st.settings };
}

async function reloadAll() {
  st = await fetchState();
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
  await renderDetail();
  if (pendingItemLink) openItemLink(pendingItemLink);
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
    h('div', { class: 'muted small' }, t('Für Unternehmen: Anmeldung mit dem Arbeitskonto, Teilen über Azure-Rollen, Audit-Log.'))));
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
    // PIM before signing in (e.g. the Key Vault role is only eligible): turned on in the menu → View.
    st.settings.pimOnLock ? h('button', { class: 'btn block pim-lock', title: t('Rolle mit Privileged Identity Management aktivieren'), onclick: () => openUrl(ADMIN_LINKS[0].url) },
      icon('ac-elevate'), t('PIM: Rolle aktivieren')) : null,
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
/** Admin mode on or off; the list, the New menu and the open entry follow at once. */
async function setAdminMode(on, pin) {
  settingsRev++;
  st.settings = on ? await call('activateAdminMode', pin) : await call('deactivateAdminMode');
  applyViewClass();
  renderSidebar();
  renderList();
  renderDetail();
  toast(on ? t('Admin-Modus aktiv') : t('Admin-Modus beendet'));
}

/** "Activate admin mode": confirmed with the app PIN – without a PIN it cannot be switched on. */
function adminModeDialog() {
  if (!st.pinSet) {
    modal(t('Admin-Modus aktivieren'), h('div', {},
      h('p', {}, t('Der Admin-Modus wird mit deiner App-PIN bestätigt. Lege zuerst eine PIN fest.'))), [
      { label: t('Abbrechen') },
      { label: t('PIN festlegen …'), primary: true, onClick: () => { setTimeout(() => pinDialog(), 0); } },
    ]);
    return;
  }
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'admin-pin', 'aria-label': t('App-PIN') });
  const { dialog } = modal(t('Admin-Modus aktivieren'), h('div', {},
    h('p', {}, t('Im Admin-Modus siehst du Assets (Server, VMs), Admin Center und Verbindungen. Bestätige mit deiner App-PIN.')),
    field(t('App-PIN'), pin)), [
    { label: t('Abbrechen') },
    { label: t('Aktivieren'), primary: true, onClick: async () => {
      try {
        await setAdminMode(true, pin.value);
        return true;
      } catch (e) {
        toast(e.message, 'error');
        pin.select();
        return false;
      }
    } },
  ]);
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('.modal-footer .btn.primary')?.click(); });
  setTimeout(() => pin.focus(), 0);
}

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
      st = await fetchState();
    } } : null,
    { label: t('Speichern'), primary: true, onClick: async () => {
      if (next.value !== repeat.value) throw new Error(t('Die PINs stimmen nicht überein'));
      await call('setPin', { current: current?.value, next: next.value });
      toast(t('PIN gespeichert'));
      st = await fetchState();
    } },
  ].filter(Boolean));
  void close;
  setTimeout(() => (current || next).focus(), 0);
}

// ---------------------------------------------------------------- sidebar

function select(next) {
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
function syncNewEntryTarget() {
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
const REMOTE_KINDS = 'cloud network'.split(' ');
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
function syncState(loc) {
  if (loc?.kind !== 'cloud') return { level: '', text: '' };
  const provider = loc.provider || t('Cloud-Ordner');
  if (loc.clientRunning === false) return { level: 'problem', text: t('{provider} läuft nicht – nicht synchronisiert', { provider }) };
  if (loc.providerStatus === 'error' || loc.providerStatus === 'terminated') return { level: 'problem', text: t('Synchronisierung gestört') };
  if (loc.online === false || loc.providerStatus === 'offline') return { level: 'pending', text: t('offline – wird später synchronisiert') };
  if (loc.inSync === false || loc.providerStatus === 'syncing') return { level: 'pending', text: t('wird synchronisiert …') };
  return { level: 'ok', text: loc.inSync ? t('synchronisiert') : '' };
}

/** Above the list of a file vault in a cloud folder that does not sync: what is wrong and what to do (#15). */
function syncNotice(container) {
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

function containerIcon(c) {
  if (c.personal) return icon('user');
  if (logos.get(c.id)) return h('img', { class: 'container-logo', src: logos.get(c.id), alt: '' });
  if (c.kind === 'file') return icon('note');
  return icon(c.protected ? 'shield' : 'vault');
}

function renderSidebar() {
  applyViewClass(); // admin colour and the brand change together
  const nav = (view, label, iconName, count) => h('button', {
    class: `nav ${ui.view === view && !ui.containerId ? 'active' : ''}`,
    dataset: { view },
    onclick: () => select({ view, containerId: null }),
  }, icon(iconName), h('span', { class: 'nav-label' }, label), h('span', { class: 'count' }, count));
  // The personal vault has its own place right below the views; the vault list shows the others.
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
        draggedVault = c.id;
      },
      ondragend: () => { draggedVault = null; } },
      h('button', {
        class: `nav ${ui.containerId === c.id ? 'active' : ''}`,
        title: [c.vaultUrl || c.path, c.error?.message, t('Rechtsklick: alle Funktionen')].filter(Boolean).join('\n'),
        onclick: () => select({ view: 'container', containerId: c.id }),
      // Personal vault: the person first, then where it lives (OneDrive, iCloud, Dropbox …); other vaults the other way round.
      }, ...(c.personal ? [containerIcon(c), sourceBadge(c)] : [sourceBadge(c), containerIcon(c)]), h('span', { class: 'nav-label' }, c.name),
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
    personal.length ? h('div', { class: 'personal-slot' }, ...personal.map(vaultRow)) : null,
    h('div', { class: 'nav-section' }, h('span', {}, t('Tresore')), h('span', { class: 'spacer' }), containers.length > 1 ? vaultFinder() : null,
      iconButton('plus', t('Tresor hinzufügen oder erstellen'), containerMenu)),
    containers.length ? vaultList(containers) : h('p', { class: 'muted small pad' }, t('Noch keine Tresore. Mit + hinzufügen oder erstellen.')),
    // Pinned to the bottom edge (sticky): stays reachable however many vaults the list above holds.
    h('div', { class: 'sidebar-foot' }, adminMode() ? modeSwitch() : null, h('button', { type: 'button', class: 'help-btn', title: t('Hilfe und Tipps (F1)'), onclick: helpDialog },
      h('span', { class: 'help-mark', 'aria-hidden': 'true' }, '?'), t('Hilfe')),
      // Admin mode next to Help (#23) – only once offered under Settings → View (and while it is on, to end it).
      st.settings.adminOffered || adminMode() ? adminFootButton() : null),
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

/** Help: the most useful tips for daily use and links into the knowledge base on the website (in the app's language). */
function helpDialog() {
  const en = getLanguage() === 'en';
  const kb = (de, enSlug) => (en ? `https://keevault.de/en/knowledge/${enSlug}.html` : `https://keevault.de/wissen/${de}.html`);
  const tip = (keys, text) => h('li', {}, keys ? h('kbd', {}, keys) : null, h('span', {}, text));
  const article = (iconName, title, sub, url) => h('button', { type: 'button', class: 'help-article', onclick: () => openUrl(url) },
    h('span', { class: 'help-article-icon' }, icon(iconName, 16)), h('span', { class: 'help-article-text' }, h('b', {}, title), h('span', {}, sub)), icon('external', 14));
  modal(t('Hilfe'), h('div', { class: 'help' },
    h('h3', {}, t('Tipps für jeden Tag')),
    h('ul', { class: 'help-tips' },
      tip(t('Strg F'), t('Suchen – standardmäßig im geöffneten Tresor, mit „Alle“ in allen Tresoren.')),
      tip(t('Strg N'), t('Neuer Eintrag: Login, Notiz, Karte oder Zertifikat.')),
      tip(t('Rechtsklick'), t('Auf Einträgen und Tresoren: alle Funktionen, z. B. „Link kopieren“ für Kolleginnen und Kollegen.')),
      tip(t('Strg+Umschalt+U / P / O'), t('Benutzername, Passwort oder Einmalcode in jedes Fenster tippen (Auto-Type, einstellbar).')),
      tip(null, t('Passkeys: Die Browser-Erweiterung und Windows fragen Keevault – der Anhänger oben im Browser zeigt, welches Konto genutzt wird.')),
      tip(null, t('Schloss oben links sperrt Keevault sofort; das Menü daneben enthält Einstellungen und Werkzeuge.'))),
    h('h3', {}, t('Wissensdatenbank')),
    h('div', { class: 'help-articles' },
      article('check', t('Erste Schritte'), t('Installieren, anmelden, ersten Tresor öffnen'), kb('erste-schritte', 'getting-started')),
      article('key', t('Passkeys'), t('Im Browser und unter Windows nutzen'), kb('passkeys', 'passkeys')),
      article('users', t('Teilen und Zugriff'), t('Kolleginnen und Kollegen einladen, Rollen'), kb('teilen', 'sharing')),
      article('info', t('Fehlerbehebung'), t('Wenn etwas nicht klappt'), kb('fehlerbehebung', 'troubleshooting')),
      article('shield', t('Sicherheit'), t('Wie Keevault schützt – und wo die Grenzen liegen'), en ? 'https://keevault.de/en/security.html' : 'https://keevault.de/sicherheit.html'),
      article('note', t('FAQ'), t('Antworten auf häufige Fragen'), en ? 'https://keevault.de/en/faq.html' : 'https://keevault.de/faq.html')),
    h('div', { class: 'help-foot' },
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(en ? 'https://keevault.de/en/knowledge/index.html' : 'https://keevault.de/wissen/index.html') }, t('Alle Artikel')),
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(en ? 'https://keevault.de/en/support.html' : 'https://keevault.de/support.html') }, t('Support')),
      h('span', { class: 'muted' }, `Keevault ${st.version}`))), [{ label: t('Schließen'), primary: true }]);
}

/** See-through ground (light/strong) as classes on <html>; the main process switches the window material. */
function applyViewClass() {
  const mode = st?.settings?.transparency || 'light';
  document.documentElement.classList.toggle('see-through', mode === 'light' || mode === 'strong');
  document.documentElement.classList.toggle('see-through-strong', mode === 'strong');
  document.documentElement.classList.toggle('show-admin', st?.settings?.adminTools === true);
  // Admin mode in the copper/red of the admin palette – only the colour changes, never the layout.
  document.documentElement.classList.toggle('admin-theme', st?.settings?.adminTools === true);
}

const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const zoomNow = () => Number(st?.settings?.zoom) || 1;

/** Zoom one step in (+1), out (-1) or back to 100 % (0); remembered in the settings. */
async function stepZoom(dir) {
  const now = zoomNow();
  let next = 1;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > now + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (dir < 0) next = [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? ZOOM_STEPS[0];
  await setView({ zoom: next });
  toast(t('Zoom {n} %', { n: Math.round(next * 100) }));
}

async function setView(patch) {
  settingsRev++;
  st.settings = await call('updateSettings', patch);
  applyViewClass();
  document.querySelectorAll('[data-view-value]').forEach((el) => el.dispatchEvent(new Event('view-changed')));
}

function viewRow(label, control) {
  return h('div', { class: 'view-row' }, h('span', { class: 'grow' }, label), control);
}

function zoomControl() {
  const value = h('span', { class: 'zoom-value', 'data-view-value': '' });
  const show = () => { value.textContent = `${Math.round(zoomNow() * 100)} %`; };
  value.addEventListener('view-changed', show);
  show();
  const step = (dir, label, text) => h('button', { type: 'button', class: 'view-step', 'aria-label': label, title: label, onclick: () => stepZoom(dir) }, text);
  return h('span', { class: 'zoom-control' }, step(-1, t('Verkleinern (Strg −)'), '−'),
    h('button', { type: 'button', class: 'view-reset', title: t('Auf 100 % (Strg 0)'), onclick: () => stepZoom(0) }, value),
    step(1, t('Vergrößern (Strg +)'), '+'));
}

/** View: an on/off switch for a setting (`on` = its default when unset), `after` redraws what it affects. */
function onOffControl(key, label, on, after) {
  const box = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': label, 'data-view-value': '' });
  const draw = () => box.replaceChildren(...[[true, t('An')], [false, t('Aus')]].map(([value, text]) => {
    const current = (st.settings[key] ?? on) === value;
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(current), class: current ? 'on' : '',
      onclick: async () => { await setView({ [key]: value }); after?.(); },
    }, text);
  }));
  box.addEventListener('view-changed', draw);
  draw();
  return box;
}

/** View → "Ansicht auf Standard": zoom, transparency, bottom bar, source marks and column widths as on first start. */
async function resetView() {
  try { localStorage.removeItem('paneWidths'); } catch {}
  await setView({ zoom: 1, theme: 'system', transparency: 'light', sourceBadges: true, pimButton: false, pimOnLock: false, adminPim: false, adminTools: false });
  await render();
  toast(t('Ansicht zurückgesetzt'));
}

/** View: a segmented choice for a setting – `choices` as [value, label], `fallback` when unset. */
function choiceControl(key, label, choices, fallback) {
  const box = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': label, 'data-view-value': '' });
  const draw = () => box.replaceChildren(...choices.map(([value, text]) => {
    const current = (st.settings[key] || fallback) === value;
    return h('button', { type: 'button', role: 'radio', 'aria-checked': String(current), class: current ? 'on' : '', onclick: () => setView({ [key]: value }) }, text);
  }));
  box.addEventListener('view-changed', draw);
  draw();
  return box;
}

/** Empty detail pane: the Keevault mark as a quiet outline – shield with the keyhole, like a shadow of the logo. */
function placeholderMark() {
  const mark = h('span', { class: 'placeholder-mark', 'aria-hidden': 'true' });
  mark.innerHTML = '<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">'
    + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
    + '<path d="M12 8.3a2 2 0 0 1 1.15 3.64l.6 3.56h-3.5l.6-3.56A2 2 0 0 1 12 8.3z" fill="currentColor" stroke="none"/></svg>';
  return mark;
}


/** Sidebar foot, next to Help: admin mode as a switch – on asks for the app PIN, off ends it at once. */
function adminFootButton() {
  const on = adminMode();
  return h('button', { type: 'button', role: 'switch', 'aria-checked': String(on), class: `admin-switch admin-foot ${on ? 'on' : ''}`,
    title: on ? t('Admin-Modus beenden') : t('Admin-Modus aktivieren …'), dataset: { action: on ? 'admin-off' : 'admin-on' },
    onclick: () => (on ? setAdminMode(false) : adminModeDialog()) },
  h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })), t('Admin'));
}

/** Admin mode: PIM in the sidebar head (Settings → View → "PIM button in admin mode"). */
function pimHeadButton() {
  const b = iconButton('ac-elevate', t('PIM: Rolle aktivieren'), () => openUrl(ADMIN_LINKS[0].url));
  b.classList.add('pim-head');
  return b;
}

/** Settings → View: every view setting (the menu keeps only design and zoom); changes apply at once. */
function viewSettings() {
  return [
    viewRow(t('Zoom'), zoomControl()),
    viewRow(t('Design'), choiceControl('theme', t('Design'), [['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]], 'system')),
    viewRow(t('Transparenz'), choiceControl('transparency', t('Transparenz'), [['off', t('Aus')], ['light', t('Leicht')], ['strong', t('Stark')]], 'light')),
    viewRow(t('Speicherort'), onOffControl('sourceBadges', t('Speicherort'), true, renderSidebar)),
    viewRow(t('PIM beim Entsperren'), onOffControl('pimOnLock', t('PIM beim Entsperren'), false)),
    viewRow(t('Admin-Modus anbieten'), onOffControl('adminOffered', t('Admin-Modus anbieten'), false, renderSidebar)),
    viewRow(t('PIM-Knopf im Admin-Modus'), onOffControl('adminPim', t('PIM-Knopf im Admin-Modus'), false, renderSidebar)),
    h('p', { class: 'muted small' }, t('Änderungen gelten sofort. „Admin-Modus anbieten“ zeigt unten neben „Hilfe“ einen Schalter für den Admin-Modus (Einschalten mit der App-PIN). Der PIM-Knopf erscheint im Admin-Modus oben links zwischen „Keevault for Admins“ und dem Schloss.')),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', dataset: { action: 'view-reset' }, onclick: resetView }, icon('refresh', 14), t('Auf Standard zurücksetzen'))),
  ];
}

/** Burger next to the logo: opens the main menu; a dot when the password check reports expiring entries. */
function mainMenuButton() {
  const b = iconButton('menu', t('Menü'), (e) => mainMenu(e.currentTarget));
  b.classList.add('menu-btn');
  b.setAttribute('aria-haspopup', 'menu');
  if (expiringEntries(items).length) b.append(h('span', { class: 'menu-dot', 'aria-hidden': 'true' }));
  return b;
}

/** Main menu (account, reload, settings, tools, lock) as a card under the burger. */
function mainMenu(anchor) {
  const existing = document.querySelector('.main-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const name = st.account?.name || st.account?.username || t('Lokal');
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || 'K';
  const expiring = expiringEntries(items).length;
  const entry = (action, iconName, label, onClick, extra = null) => h('button', { type: 'button', role: 'menuitem', dataset: { action }, onclick: () => {
    close();
    onClick();
  } }, icon(iconName, 16), h('span', { class: 'grow' }, label), extra);
  // One menu (#18): the most used view settings on top, then actions and tools. Every view setting is under
  // Settings → View; admin mode is offered there and then sits next to Help (#23).
  const menu = h('div', { class: 'main-menu', role: 'menu', 'aria-label': t('Menü') },
    h('div', { class: 'main-menu-account' },
      h('span', { class: 'main-menu-avatar' }, initials),
      h('span', { class: 'main-menu-who' }, h('b', {}, name), h('span', {}, st.account?.username || t('Nur Datei-Tresore')))),
    h('div', { class: 'main-menu-pane view-pane', role: 'group', 'aria-label': t('Ansicht') },
      viewRow(t('Design'), choiceControl('theme', t('Design'), [['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]], 'system')),
      viewRow(t('Zoom'), zoomControl())),
    h('div', { class: 'context-sep' }),
    h('div', { class: 'main-menu-pane', role: 'group', 'aria-label': t('Menü') },
      entry('settings', 'settings', t('Einstellungen'), settingsDialog),
      entry('reload', 'refresh', t('Neu laden'), refresh),
      h('div', { class: 'main-menu-label' }, t('Werkzeuge')),
      entry('generator', 'key', t('Passwort-Generator'), generatorDialog),
      entry('health', 'shield', t('Passwort-Check'), () => healthDialog(reportCtx()), expiring ? h('span', { class: 'count warn', title: t('Einträge laufen ab') }, expiring) : null),
      st.signedIn ? entry('access', 'users', t('Zugriffsbericht'), () => accessReportDialog(reportCtx())) : null,
      entry('trash', 'trash', t('Papierkorb'), openTrash),
      h('div', { class: 'context-sep' }),
      entry('lock', 'lock', t('Sperren'), () => call('lock'))));
  const close = () => {
    menu.classList.add('closing');
    setTimeout(() => menu.remove(), 120);
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      anchor.focus();
    }
  };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  // Small window: the menu ends 10 px above the bottom edge and scrolls instead of being cut off.
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 18)}px`;
  menu.style.left = `${Math.max(10, r.right - menu.offsetWidth)}px`;
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  menu.querySelector('button')?.focus();
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

const adminMode = () => st?.settings?.adminTools === true;
// Admin mode: the switch at the bottom of the sidebar shows either the passwords (logins, notes, cards, …) or the
// devices – cleanly apart, the list head says which.
const deviceMode = () => adminMode() && ui.devices;
// Assets and secrets keep their own folders: empty asset folders are stored with this prefix (never shown), entry
// folders belong to the side of their entry. Folder actions only touch the side that is shown.
const ASSET_FOLDERS = 'assets:';
const folderScope = () => (deviceMode() ? 'assets' : 'secrets');
const nsFolder = (p) => (deviceMode() && p ? ASSET_FOLDERS + p : p);
const folderList = (id) => (explicitFolders.get(id) || [])
  .filter((f) => f.startsWith(ASSET_FOLDERS) === deviceMode()).map((f) => (deviceMode() ? f.slice(ASSET_FOLDERS.length) : f));
const modeItems = (id) => items.filter((i) => i.containerId === id && (i.type === 'server') === deviceMode());

/** Sidebar bottom (admin mode): "Passwords | Devices" in the segment style of the menu. */
function modeSwitch() {
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
function typePills(base) {
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

const TYPE_TESTS = { login: (i) => i.type === 'login', passkey: (i) => i.rpIds.length > 0, note: (i) => i.type === 'note', card: (i) => i.type === 'card', certificate: (i) => i.type === 'certificate' };

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

function visibleItems({ ignoreType = false } = {}) {
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

function renderList() {
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
        draggedPasskey = null;
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
      h('span', { class: 'new-plus' }, icon('plus', 15)), t('Neu')),
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

const DRAG_TYPE = 'application/x-kvpwsafe-item';
const DRAG_FOLDER = 'application/x-kvpwsafe-folder';
const DRAG_VAULT = 'application/x-kvpwsafe-vault';
const DRAG_PASSKEY = 'application/x-kvpwsafe-passkey';
let draggedPasskey = null; // { from: entry key, credentialId } while a passkey is dragged
let draggedVault = null; // container id while a vault row is dragged
// What is being dragged right now (dataTransfer can only be read on drop; the vault rows decide earlier whether they accept).
let draggedKeys = [];
let draggedFolder = null; // { containerId, folders: [...] } while folders are dragged (alone or with entries)

/** Starts dragging entries (keys) and folders of container c; either list may be empty. */
function startDrag(e, c, keys, folders) {
  if (keys.length) e.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
  if (folders.length) e.dataTransfer.setData(DRAG_FOLDER, [c.id, ...folders].join('\n'));
  e.dataTransfer.effectAllowed = 'move';
  draggedKeys = keys;
  draggedFolder = folders.length ? { containerId: c.id, folders } : null;
}

function endDrag() {
  draggedKeys = [];
  draggedFolder = null;
}

/** What a drop carries: entry keys and { containerId, folders } (or null). */
function dropped(e) {
  const keys = e.dataTransfer.types.includes(DRAG_TYPE) ? e.dataTransfer.getData(DRAG_TYPE).split('\n').filter(Boolean) : [];
  const [containerId, ...folders] = e.dataTransfer.types.includes(DRAG_FOLDER) ? e.dataTransfer.getData(DRAG_FOLDER).split('\n').filter(Boolean) : [];
  endDrag();
  return { keys, folder: containerId && folders.length ? { containerId, folders } : null };
}

/** Entries that travel inside one of the dragged folders anyway (they keep their place in it). */
const outsideFolders = (keys, folder) => keys.filter((k) => {
  const i = items.find((x) => x.key === k);
  const at = i?.folder || '';
  return !folder || !folder.folders.some((f) => at === f || at.startsWith(`${f}/`));
});

/** Whether the dragged entries (or folder) may go into vault c: writable, from another vault, nothing shared into the personal one. */
function vaultAccepts(c, keys, folder = null) {
  if (folder) {
    if (!writable(c) || !featureAllowed(c, 'folders') || folder.containerId === c.id) return false;
    if (c.personal && !st.containers.find((x) => x.id === folder.containerId)?.personal) return false;
    // Entries dragged along with the folders must fit as well.
    return !keys.length || vaultAccepts(c, keys);
  }
  if (!keys.length || !writable(c)) return false;
  const sources = keys.map((k) => splitKey(k)[0]);
  if (sources.every((id) => id === c.id)) return false;
  return !(c.personal && sources.some((id) => !st.containers.find((x) => x.id === id)?.personal));
}

/** Sidebar vault row as drop target: moves the dragged entries into that vault after a short confirmation. */
/** Sidebar order: the ids in the setting first (in that order), the rest after them as they come. */
function orderedVaults(list) {
  const order = st.settings.containerOrder || [];
  const rank = (c, i) => { const k = order.indexOf(c.id); return k < 0 ? order.length + i : k; };
  return list.map((c, i) => [c, rank(c, i)]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/** A vault dropped onto another one: before it (upper half) or after it (lower half); remembered in the settings. */
async function reorderVault(id, targetId, after) {
  const ids = orderedVaults(st.containers.filter((c) => !c.personal)).map((c) => c.id).filter((x) => x !== id);
  const at = ids.indexOf(targetId);
  if (at < 0) return;
  ids.splice(after ? at + 1 : at, 0, id);
  st.settings = await call('updateSettings', { containerOrder: ids });
  renderSidebar();
}

function vaultDropTarget(c) {
  const half = (e) => e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2;
  return {
    ondragover: (e) => {
      // Reordering: another vault (not the personal one) is dragged over this row.
      if (e.dataTransfer.types.includes(DRAG_VAULT)) {
        if (c.personal || !draggedVault || draggedVault === c.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.toggle('drop-after', half(e));
        e.currentTarget.classList.toggle('drop-before', !half(e));
        return;
      }
      const ok = e.dataTransfer.types.includes(DRAG_FOLDER) ? vaultAccepts(c, draggedKeys, draggedFolder)
        : e.dataTransfer.types.includes(DRAG_TYPE) && vaultAccepts(c, draggedKeys);
      if (!ok) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drop');
    },
    ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop', 'drop-before', 'drop-after'); },
    ondrop: async (e) => {
      e.preventDefault();
      const after = half(e);
      e.currentTarget.classList.remove('drop', 'drop-before', 'drop-after');
      if (e.dataTransfer.types.includes(DRAG_VAULT)) {
        const id = e.dataTransfer.getData(DRAG_VAULT);
        draggedVault = null;
        if (id && id !== c.id && !c.personal) await reorderVault(id, c.id, after);
        return;
      }
      const { keys: all, folder } = dropped(e);
      if (folder) {
        if (!vaultAccepts(c, all, folder)) return;
        const rest = outsideFolders(all, folder).map((k) => items.find((i) => i.key === k)).filter(Boolean);
        if (folder.folders.length === 1 && !rest.length) {
          await moveFolderTo(folder.containerId, folder.folders[0], c);
          return;
        }
        // Several folders (and entries): one question for all of them.
        if (!(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: c.name }),
          t('{folders} Ordner (mit Unterordnern) und {n} Einträge nach „{vault}“ verschieben? Danach sehen alle mit Zugriff auf „{vault}“ die Einträge. Sie werden im Ziel neu angelegt und in der Quelle gelöscht.', { folders: folder.folders.length, n: rest.length, vault: c.name }),
          { confirmLabel: t('Verschieben') }))) return;
        for (const f of folder.folders) await moveFolderTo(folder.containerId, f, c, { confirmed: true });
        if (rest.length) await moveItemsTo(rest, c.id);
        clearSelection();
        await reloadAll();
        return;
      }
      const keys = all;
      if (!vaultAccepts(c, keys)) return;
      const list = keys.map((k) => items.find((i) => i.key === k)).filter(Boolean).filter((i) => i.containerId !== c.id);
      if (!list.length) return;
      const what = list.length === 1 ? `„${list[0].title}“` : t('{n} Einträge', { n: list.length });
      if (!(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: c.name }),
        t('{what} nach „{vault}“ verschieben? Danach sehen ihn alle mit Zugriff auf „{vault}“. Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht.', { what, vault: c.name }),
        { confirmLabel: t('Verschieben') }))) return;
      await moveItemsTo(list, c.id);
    },
  };
}

/**
 * Drag & drop target "folder" (a folder row, or the bar of the parent folder): takes dragged entries – and a dragged
 * folder of the same vault, which moves in with its subfolders and entries (never into itself or a subfolder of it).
 */
function dropTarget(folder, container = null) {
  // Folders go in only within their vault, never into themselves or a subfolder of theirs; one that already lies
  // directly in the target stays where it is (and does not block the others).
  const oneFits = (f) => f !== folder && !folder.startsWith(`${f}/`);
  const folderFits = (src) => !!src && !!container && src.containerId === container.id && src.folders.every(oneFits)
    && src.folders.some((f) => parentOf(f) !== folder);
  return {
    ondragover: (e) => {
      const types = e.dataTransfer.types;
      if (types.includes(DRAG_FOLDER) ? !folderFits(draggedFolder) : !types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drop');
    },
    ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop'); },
    ondrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.classList.remove('drop');
      const { keys: all, folder: src } = dropped(e);
      if (src) {
        if (!folderFits(src)) return;
        moveSelectionInto(container, src.folders, outsideFolders(all, src), folder);
        return;
      }
      if (all.length > 1) moveManyToFolder(all, folder);
      else if (all[0]) moveToFolder(all[0], folder);
    },
  };
}

const parentOf = (folder) => (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '');

/** Folders and entries dragged together into folder target of the same vault: the folders first, then the entries. */
async function moveSelectionInto(c, folders, keys, target) {
  for (const f of folders) if (parentOf(f) !== target) await moveFolderInto(c, f, target);
  if (keys.length) await moveManyToFolder(keys, target);
  clearSelection();
  renderList();
  renderDetail();
}

/** Moves folder src (with subfolders and entries) into target ('' = top level) of the same vault. */
async function moveFolderInto(c, src, target) {
  const name = src.split('/').pop();
  const next = target ? `${target}/${name}` : name;
  if (next === src) return;
  // The deepest subfolder must stay within MAX_FOLDER_DEPTH levels.
  const depth = (f) => f.split('/').filter(Boolean).length;
  const inside = [...modeItems(c.id).map((i) => i.folder || ''), ...folderList(c.id)]
    .filter((f) => f === src || f.startsWith(`${src}/`));
  const deepest = Math.max(depth(src), ...inside.map(depth));
  if (depth(next) + deepest - depth(src) > MAX_FOLDER_DEPTH) {
    toast(t('Dort wären es mehr als {n} Ordnerebenen', { n: MAX_FOLDER_DEPTH }), 'error');
    return;
  }
  try {
    const r = await call('renameFolder', c.id, src, next, folderScope());
    for (const err of r.errors) toast(err, 'error');
    if (ui.folder === src || ui.folder.startsWith(`${src}/`)) ui.folder = next + ui.folder.slice(src.length);
    explicitFolders.set(c.id, await call('folders', c.id));
    toast(t('Ordner „{name}“ verschoben', { name }));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
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

/** Folder view of a container: breadcrumb, subfolders of the current folder, then its entries. */
function folderRows(container, list, row, rerender) {
  const all = new Set([...folderList(container.id), ...list.map((i) => i.folder).filter(Boolean)]);
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
    syncNewEntryTarget();
  };
  const out = [];
  if (cur) {
    const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
    out.push(h('li', { class: 'folder-crumb', ...dropTarget(parent, container) },
      h('button', { class: 'icon-btn', title: t('Übergeordneter Ordner'), onclick: () => open(parent) }, icon('back', 16)),
      folderGlyph(container.id, cur, 16), h('b', {}, cur.split('/').join(' / '))));
  }
  for (const f of children) {
    const count = inside(f);
    const name = f.slice(prefix.length);
    const dragFolder = writable(container) && featureAllowed(container, 'folders');
    out.push(h('li', { class: `row-item folder-row ${ui.multiFolders.has(f) ? 'multi' : ''}`, dataset: { folder: f },
      // Ctrl/Shift select folders (together with entries); a plain click opens the folder.
      onclick: (e) => {
        if (selectRow(e, `folder:${f}`)) { rerender(); renderDetail(); return; }
        clearSelection();
        ui.anchor = null;
        open(f);
      },
      oncontextmenu: (e) => contextMenu(e, folderActions(container, f, count, open)), ...dropTarget(f, container),
      draggable: dragFolder ? 'true' : false,
      ondragstart: dragFolder ? (e) => {
        if (e.target !== e.currentTarget) return;
        const selected = ui.multiFolders.has(f);
        startDrag(e, container, selected ? [...ui.multi] : [], selected ? [...ui.multiFolders] : [f]);
      } : undefined,
      ondragend: dragFolder ? endDrag : undefined },
      h('span', { class: 'folder-icon' }, folderGlyph(container.id, f, 18)),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, name), h('div', { class: 'row-sub' }, t('{count} Einträge', { count }))),
      !count && writable(container) ? h('button', { class: 'icon-btn', title: t('Leeren Ordner löschen'), onclick: async (e) => {
        e.stopPropagation();
        try {
          await call('removeFolder', container.id, nsFolder(f));
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
    folderIconMap.set(c.id, await call('folderIcons', c.id).catch(() => ({})));
    await reloadAll();
  };
  return [
    { action: 'open-folder', icon: 'folder', label: t('Öffnen'), onClick: () => open(folder) },
    { action: 'folder-icon', icon: 'image', label: t('Symbol ändern …'), disabled: !canWrite, onClick: () => folderIconDialog(c, folder) },
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
              h('p', { class: 'muted small' }, t('„Nur Ordner“ verschiebt die Einträge eine Ebene nach oben ({parent}). „Mit Inhalt“ löscht sie.', { parent: parent || t('Ohne Ordner') }))), [
              { label: t('Abbrechen'), onClick: () => resolve(null) },
              { label: t('Nur Ordner löschen'), onClick: () => resolve('keep') },
              { label: t('Mit Inhalt löschen'), danger: true, onClick: () => resolve('delete') },
            ]);
          });
          if (!choice) return;
          if (choice === 'delete') {
            if (!(await confirmDialog(t('Wirklich alle Einträge löschen?'), `${t('Achtung: {count} Einträge aus „{folder}“ und allen Unterordnern werden gelöscht.', { folder, count: inside.length })} ${await deleteNotice(c)}`, { confirmLabel: t('Ja, {count} Einträge löschen', { count: inside.length }), danger: true }))) return;
            const failed = await deleteMany(inside.map((i) => i.key));
            if (failed) toast(t('{n} Einträge konnten nicht gelöscht werden', { n: failed }), 'error');
          } else {
            const r = await call('renameFolder', c.id, folder, parent, folderScope());
            for (const err of r.errors) toast(err, 'error');
          }
        }
        await call('removeFolder', c.id, nsFolder(folder)).catch(() => {});
        // Subfolders that only existed as empty folders.
        for (const f of folderList(c.id).filter((x) => x.startsWith(`${folder}/`))) await call('removeFolder', c.id, nsFolder(f)).catch(() => {});
        if (ui.folder === folder || ui.folder.startsWith(`${folder}/`)) ui.folder = parent;
        toast(t('Ordner gelöscht'));
        await reloadFolders();
      } catch (e) {
        toast(e.message, 'error');
      }
    } },
  ];
}

/** Symbol of a folder in the list: the chosen one, its own image, or the plain folder. */
function folderGlyph(containerId, folder, size) {
  const value = folderIconMap.get(containerId)?.[nsFolder(folder)];
  if (isFolderImage(value)) return h('img', { class: 'folder-img', src: value, width: size, height: size, alt: '' });
  return icon(value || 'folder', size);
}

function folderIconDialog(c, folder) {
  const current = folderIconMap.get(c.id)?.[nsFolder(folder)] || '';
  const save = async (value) => {
    await call('setFolderIcon', c.id, nsFolder(folder), value);
    folderIconMap.set(c.id, await call('folderIcons', c.id));
    renderList();
  };
  const { close } = modal(t('Symbol für „{folder}“', { folder: folder.split('/').pop() }), h('div', {},
    h('div', { class: 'icon-grid' }, ...FOLDER_ICONS.map((name) => h('button', {
      type: 'button', class: `icon-choice ${(current || 'folder') === name ? 'on' : ''}`, title: name, dataset: { icon: name },
      onclick: async () => {
        try {
          await save(name === 'folder' ? '' : name);
          close();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    }, icon(name, 22)))),
    isFolderImage(current) ? h('p', { class: 'muted small inline' }, h('img', { class: 'folder-img', src: current, width: 22, height: 22, alt: '' }), t('Eigenes Bild')) : null), [
    { label: t('Eigenes Bild …'), onClick: async () => {
      const url = await pickImage({ size: 32, maxChars: MAX_FOLDER_IMAGE });
      if (!url) return false;
      await save(url);
      return true;
    } },
    { label: t('Standard'), onClick: () => save('') },
    { label: t('Schließen') },
  ]);
}

function renameFolderDialog(c, folder) {
  const name = h('input', { value: folder });
  modal(t('Ordner umbenennen'), h('div', {},
    h('p', { class: 'muted' }, t('Unterordner und Einträge werden mit umbenannt. Mit „/“ verschiebst du den Ordner, z. B. Kunden/Alt.')),
    field(t('Ordner'), name)), [
    { label: t('Abbrechen') },
    { label: t('Umbenennen'), primary: true, onClick: async () => {
      const r = await call('renameFolder', c.id, folder, name.value, folderScope());
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
      await call('addFolder', c.id, nsFolder(name.value));
      explicitFolders.set(c.id, await call('folders', c.id));
      ui.folder = name.value.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      renderList();
    } },
  ]);
  setTimeout(() => name.focus(), 0);
}

/** Problems with the access (shown as a tag right of the name); the regular levels are a symbol before it (roleMark). */
function accessBadge(c) {
  if (c.error) return h('span', { class: 'badge danger' }, t('Kein Zugriff'));
  if (c.kind === 'file') return null;
  if (!c.access) return h('span', { class: 'badge' }, t('Zugriff unbekannt'));
  if (!c.access.read && !c.access.manage) return h('span', { class: 'badge warn' }, t('Ohne Datenzugriff'));
  return null;
}

/** Symbol left of the vault name for the own permission – eye, pen, shield, crown; hover spells it out. */
function roleMark(c) {
  const mark = (name, level, text) => h('span', { class: `role-mark role-${level}`, title: text, 'aria-label': text, role: 'img' }, icon(name, 18));
  const owner = (text) => mark('crown', 'owner', text);
  const admin = (text) => mark('shield', 'admin', text);
  const write = (text) => mark('edit', 'write', text);
  const read = (text) => mark('eye', 'read', text);
  if (c.error || c.locked && c.kind !== 'file') return null;
  if (c.personal) return owner(t('Dein persönlicher Tresor – nur du hast Zugriff'));
  if (c.kind === 'file' && c.secure && c.role) {
    if (c.role === 'admin') return owner(t('Admin: lesen, bearbeiten und Mitglieder einladen bzw. Berechtigungen vergeben'));
    if (c.role === 'editor') return write(t('Bearbeiten: Einträge lesen und ändern'));
    return read(t('Nur lesen: Einträge ansehen und kopieren, nichts ändern'));
  }
  if (c.kind === 'file') return write(t('Datei-Tresor: lesen und bearbeiten ({path})', { path: c.path || '' }));
  const x = c.access;
  if (!x) return null;
  if (x.manage) return owner(x.read ? t('Besitzer: lesen, bearbeiten, verwalten und Berechtigungen vergeben') : t('Besitzer: darf Berechtigungen vergeben, hat selbst aber keinen Datenzugriff'));
  if (x.admin) return admin(t('Verwalten: lesen, bearbeiten und Tresor-Einstellungen festlegen'));
  if (x.write) return write(t('Bearbeiten: Einträge lesen und ändern'));
  if (x.read) return read(t('Nur lesen: Einträge ansehen und kopieren, nichts ändern'));
  return null;
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
  // Taller than the window (small window, long menu): it scrolls from the top edge – submenus then open inside it.
  if (menu.getBoundingClientRect().height > hgt - 16) menu.classList.add('scrolls');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, w - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, hgt - rect.height - 8))}px`;
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
      // Which metadata is readable without the entry itself (tags): titles, user names, websites, folders – unless the vault is protected.
      row(t('Metadaten'), c.protected ? t('verschlüsselt (zusätzlicher Schutz)') : t('Titel, Benutzername, Websites und Ordner stehen als Tags im Klartext – lesbar für jede Rolle mit Metadaten-Leserecht (z. B. Key Vault Reader). Für sensible Tresore: Rechtsklick → „Zusätzlich schützen“.')),
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
  { action: 'group-manage', icon: 'settings', label: 'Verwaltung', members: ['vault-settings', 'mcp-scope', 'license', 'logo', 'rename', 'migrate', 'changelog'] },
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
      : { action: 'invite', icon: 'link', label: t('Einladungslink kopieren'), onClick: () => copy(call('invite', c.id), t('Einladungslink')) },
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

/** Functions of an entry (right-click in the list). */
/**
 * "Copy link": a web link to the entry for colleagues (extension/core/links.js). It grants no access – whoever opens
 * it needs rights on the vault; the copy confirmation says so.
 */
function copyItemLink(container, id) {
  const link = buildItemLink(container, id);
  if (!link) return;
  copy(link, t('Link zum Eintrag'));
  toast(t('Öffnen können ihn alle mit Zugriff auf „{vault}“.', { vault: container.name }));
}

// Entry link that arrived while Keevault was locked or the vault was still missing: opened once that is resolved.
let pendingItemLink = null;

/** Opens an entry from a link: selects vault and entry; offers to add a vault this app does not know yet. */
async function openItemLink(link) {
  pendingItemLink = link;
  if (!st?.opened) return; // after unlocking (render)
  const sameHost = (c) => {
    try {
      return new URL(c.vaultUrl || '').host.toLowerCase() === link.host;
    } catch {
      return false;
    }
  };
  const container = st.containers.find(sameHost);
  if (!container) {
    // Not added yet: the invite dialog with the vault prefilled; the entry opens after the vault was added.
    // Only once: closing the dialog without adding drops the link (no dialog on every reload).
    if (link.prompted) {
      pendingItemLink = null;
      return;
    }
    link.prompted = true;
    const invite = new URL('kvpwsafe://add');
    invite.searchParams.set('vault', link.vaultUrl);
    if (link.name) invite.searchParams.set('name', link.name);
    if (!document.querySelector('dialog[open]')) addContainerDialog(invite.toString());
    return;
  }
  pendingItemLink = null;
  const key = `${container.id}/${link.id}`;
  if (!items.some((i) => i.key === key)) {
    if (container.locked) {
      select({ view: 'container', containerId: container.id });
      toast(t('Tresor zuerst entsperren, dann den Link erneut öffnen.'), 'error');
      return;
    }
    toast(t('Eintrag nicht gefunden – gelöscht, verschoben oder kein Zugriff.'), 'error');
    return;
  }
  ui.query = '';
  ui.type = '';
  ui.folder = '';
  select({ view: 'container', containerId: container.id, selected: key });
}

// Retention per vault (days, from the vault's Azure properties); null when it cannot be read (no ARM access).
const retentionCache = new Map();

/** Trash of a vault: deleted entries until the end of the retention period – restore, or purge if the vault settings allow it. */
/** Main menu → Trash: the vault on screen, otherwise a short choice of the vaults. */
function openTrash() {
  const shown = ui.containerId && st.containers.find((c) => c.id === ui.containerId);
  if (shown && !shown.error && !shown.locked) return trashDialog(shown);
  const ready = st.containers.filter((c) => !c.error && !c.locked);
  if (ready.length === 1) return trashDialog(ready[0]);
  const { close } = modal(t('Papierkorb'), h('div', {},
    h('p', { class: 'muted' }, t('Von welchem Tresor?')),
    ...ready.map((c) => h('button', { type: 'button', class: 'choice', onclick: () => { close(); trashDialog(c); } }, containerIcon(c), h('span', {}, c.name)))), [{ label: t('Abbrechen') }]);
  return undefined;
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
      h('button', { type: 'button', class: 'btn small', dataset: { restore: e.id }, onclick: async (ev) => {
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
    container.kind === 'file' ? null : h('p', { class: 'muted small' }, t('Gelöschte Einträge bleiben im Key Vault (Soft Delete) bis zum Ende der Aufbewahrungsfrist und lassen sich bis dahin hier oder im Azure-Portal wiederherstellen. Mit Löschschutz ist endgültiges Löschen erst danach möglich.')),
    listEl), [{ label: t('Schließen') }]);
  load().catch((e) => listEl.replaceChildren(notice(e.message)));
}

/**
 * Text for delete confirmations. Key Vault keeps deleted secrets for its retention period (soft delete, always on):
 * they can be restored from the trash (vault menu) or in the Azure portal. File vaults keep deleted entries in their own trash.
 */
async function deleteNotice(container) {
  if (!container) return '';
  if (container.kind === 'file') return t('Der Eintrag bleibt im Papierkorb des Datei-Tresors, bis er dort endgültig gelöscht wird.');
  if (!retentionCache.has(container.id)) {
    const days = await Promise.race([
      call('vaultInfo', container.id).then((x) => x?.retentionDays || null, () => null),
      new Promise((r) => { setTimeout(() => r(undefined), 2500); }),
    ]);
    if (days !== undefined) retentionCache.set(container.id, days);
  }
  const days = retentionCache.get(container.id);
  return days
    ? t('{days} Tage lang im Papierkorb wiederherstellbar (Rechtsklick auf den Tresor → Papierkorb, oder im Azure-Portal), danach endgültig gelöscht.', { days })
    : t('Während der Aufbewahrungsfrist des Key Vaults (7–90 Tage) im Papierkorb wiederherstellbar, danach endgültig gelöscht.');
}

function itemActions(i) {
  if (selectionSize() > 1 && ui.multi.has(i.key)) return multiActions();
  const [containerId, id] = splitKey(i.key);
  const c = st.containers.find((x) => x.id === containerId) || {};
  const canWrite = writable(c);
  const open = async () => call('item', containerId, id);
  // Copying takes the sign-in the entry uses (a linked login: the linked entry's user name and password).
  const usable = async () => resolveLogin(await open(), (c, x) => call('item', c, x));
  const openSite = async () => {
    const u = await usable();
    if (u.linked?.microsoft) return call('openWithMicrosoft', { containerId, id, url: `https://${i.hosts[0]}` }).catch((e) => toast(e.message, 'error'));
    return openUrl(`https://${i.hosts[0]}`);
  };
  return [
    { action: 'favorite', icon: 'star', label: i.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), disabled: !canWrite, onClick: () => toggleFavorite(i) },
    '-',
    i.username || i.loginLinked ? { action: 'copy-user', icon: 'copy', label: t('Benutzername kopieren'), onClick: async () => copy((await usable()).username, t('Benutzername')) } : null,
    i.type === 'login' || i.type === 'certificate' ? { action: 'copy-password', icon: 'copy', label: t('Passwort kopieren'), onClick: async () => copy((await usable()).password, t('Passwort')) } : null,
    i.type === 'card' ? { action: 'copy-card', icon: 'copy', label: t('Kartennummer kopieren'), onClick: async () => copy((await open()).card.number, t('Kartennummer')) } : null,
    i.hosts?.[0] ? { action: 'open', icon: 'external', label: t('Website öffnen'), onClick: () => (i.loginLinked ? openSite() : openUrl(`https://${i.hosts[0]}`)) } : null,
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
    { action: 'copy-link', icon: 'link', label: t('Link kopieren'), disabled: !buildItemLink(c, id), onClick: () => copyItemLink(c, id) },
    agentTrust.has(i.key) ? { action: 'agent-untrust', icon: 'shield', label: t('KI-Freigabe entziehen'), onClick: async () => {
      const agents = agentTrust.get(i.key).join(', ');
      if (!(await confirmDialog(t('KI-Freigabe entziehen'), t('„{agents}“ liest „{title}“ bisher ohne Rückfrage. Danach fragt Keevault wieder nach.', { agents, title: i.title }), { confirmLabel: t('Entziehen') }))) return;
      await call('mcpUntrust', containerId, id);
      await loadAgentTrust();
      toast(t('KI-Freigabe entzogen'));
    } } : null,
    { action: 'delete', icon: 'trash', label: t('Löschen'), danger: true, disabled: !canWrite, onClick: async () => {
      if (!(await confirmDialog(t('Eintrag löschen'), `${t('„{title}“ löschen?', { title: i.title })} ${await deleteNotice(c)}`, { confirmLabel: t('Löschen'), danger: true }))) return;
      await call('delete', containerId, id);
      if (ui.selected === i.key) ui.selected = null;
      toast(t('In den Papierkorb verschoben'));
      await reloadAll();
    } },
  ];
}

// ---------------------------------------------------------------- several entries at once (Shift/Ctrl)

/** Clears the selection of entries and folders. */
function clearSelection() {
  ui.multi.clear();
  ui.multiFolders.clear();
}

/** Entries and folders selected together. */
const selectionSize = () => ui.multi.size + ui.multiFolders.size;

/**
 * Ctrl/Shift on a row of the list (entry or folder). token: "key:<entry key>" or "folder:<path>". Shift selects the
 * range from the last clicked row, Ctrl toggles one row; folders and entries mix freely. Returns false for a plain click.
 */
function selectRow(e, token) {
  const add = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.add(tk.slice(7)) : ui.multi.add(tk.slice(4)));
  const has = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.has(tk.slice(7)) : ui.multi.has(tk.slice(4)));
  const drop = (tk) => (tk.startsWith('folder:') ? ui.multiFolders.delete(tk.slice(7)) : ui.multi.delete(tk.slice(4)));
  const anchor = ui.anchor || (ui.selected ? `key:${ui.selected}` : null);
  if (e.shiftKey && anchor) {
    const order = [...document.querySelectorAll('.list li.row-item')].map((el) => (el.dataset.key ? `key:${el.dataset.key}` : el.dataset.folder != null ? `folder:${el.dataset.folder}` : null)).filter(Boolean);
    const a = order.indexOf(anchor);
    const b = order.indexOf(token);
    if (a >= 0 && b >= 0) {
      add(anchor);
      for (const tk of order.slice(Math.min(a, b), Math.max(a, b) + 1)) add(tk);
      return true;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    if (!selectionSize() && anchor && anchor !== token) add(anchor);
    if (has(token)) drop(token);
    else add(token);
    ui.anchor = token;
    return true;
  }
  return false;
}

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
    { action: 'multi-clear', icon: 'x', label: t('Auswahl aufheben'), onClick: () => { clearSelection(); renderRows(); renderDetail(); } },
  ];
}

function renderMultiSelection() {
  const list = multiItems();
  const folders = [...ui.multiFolders].sort((a, b) => a.localeCompare(b));
  // With folders in the selection the buttons act on the entries only – dragging moves everything.
  const actions = list.length ? multiActions().filter((a) => a !== '-' && a.action !== 'multi-clear') : [];
  const lines = [...folders.map((f) => h('li', { class: 'multi-folder' }, icon('folder', 13), f.split('/').pop())), ...list.map((i) => h('li', {}, i.title))];
  panes.detail.replaceChildren(h('div', { class: 'placeholder multi-selection' }, icon('check', 40),
    h('h2', {}, folders.length ? t('{folders} Ordner und {n} Einträge ausgewählt', { folders: folders.length, n: list.length }) : t('{n} Einträge ausgewählt', { n: list.length })),
    h('p', { class: 'muted small' }, t('Shift+Klick wählt einen Bereich, Strg+Klick einzelne Einträge und Ordner. Ziehen verschiebt alles in einen Ordner oder Tresor.')),
    h('ul', { class: 'multi-list' }, ...lines.slice(0, 12), lines.length > 12 ? h('li', { class: 'muted' }, `… +${lines.length - 12}`) : null),
    h('div', { class: 'actions' }, ...actions.map((a) => h('button', { type: 'button', class: a.danger ? 'btn danger' : 'btn', disabled: a.disabled, onclick: a.onClick }, icon(a.icon), a.label)),
      h('button', { type: 'button', class: 'btn', onclick: () => { clearSelection(); renderRows(); renderDetail(); } }, t('Auswahl aufheben')))));
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
  const notices = [...new Set(await Promise.all([...new Set(list.map((i) => i.containerId))].map((id) => deleteNotice(st.containers.find((x) => x.id === id)))))];
  if (!(await confirmDialog(t('Einträge löschen'), `${t('{n} Einträge löschen?', { n: list.length })} ${notices.join(' ')}`, { confirmLabel: t('Löschen'), danger: true }))) return;
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
  const known = [...new Set([...folderList(containerId), ...modeItems(containerId).map((i) => i.folder).filter(Boolean)])].sort();
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
  // The personal vault is a target only when every selected entry already comes from it.
  const fromShared = list.some((i) => !st.containers.find((x) => x.id === i.containerId)?.personal);
  const targets = writableContainers().filter((c) => !list.every((i) => i.containerId === c.id) && !(c.personal && fromShared));
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Einträge verschieben'), h('div', {},
    field(t('{n} Einträge verschieben nach', { n: list.length }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht. Der bisherige Verlauf bleibt bis zum Ende der Aufbewahrungsfrist in der Quelle.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: () => moveItemsTo(list, target.value) },
  ]);
}

/**
 * A folder with everything in it into another vault: it lands there under its own name at the top level
 * ("Kunden/Contoso" → "Contoso", subfolders along); an existing folder of that name is merged. The source folder is
 * removed once every entry arrived.
 */
async function moveFolderTo(sourceId, folder, target, { confirmed = false } = {}) {
  const source = st.containers.find((c) => c.id === sourceId);
  const name = folder.split('/').pop();
  const inside = (f) => f === folder || f.startsWith(`${folder}/`);
  const map = (f) => name + f.slice(folder.length);
  const list = modeItems(sourceId).filter((i) => inside(i.folder || ''));
  if (!confirmed && !(await confirmDialog(t('Nach „{vault}“ verschieben?', { vault: target.name }),
    t('Ordner „{folder}“ ({n} Einträge, mit Unterordnern) nach „{vault}“ verschieben? Danach sehen alle mit Zugriff auf „{vault}“ die Einträge. Sie werden im Ziel neu angelegt und in der Quelle gelöscht; gibt es dort schon einen Ordner „{folder}“, landet alles darin.', { folder: name, n: list.length, vault: target.name }),
    { confirmLabel: t('Verschieben') }))) return;
  try {
    // Empty subfolders too (folders without entries exist only in the folder list).
    explicitFolders.set(sourceId, await call('folders', sourceId));
    const explicit = folderList(sourceId).filter(inside);
    for (const f of [folder, ...explicit]) await call('addFolder', target.id, nsFolder(map(f))).catch(() => {});
    const failed = await moveItemsTo(list, target.id, (i) => map(i.folder));
    if (!failed) await call('removeFolder', sourceId, nsFolder(folder)).catch(() => {});
    explicitFolders.delete(sourceId);
    explicitFolders.delete(target.id);
    if (ui.containerId === sourceId && inside(ui.folder || '')) ui.folder = '';
    if (!failed) toast(t('„{folder}“ nach „{vault}“ verschoben', { folder: name, vault: target.name }));
    await reloadAll();
  } catch (e) {
    toast(`${source?.name || ''}: ${e.message}`, 'error');
  }
}

/** Moves entries into another vault one by one (each is re-created there and deleted in the source); returns the failures. */
async function moveItemsTo(list, targetId, folderOf = null) {
  let moved = 0;
  let failed = 0;
  let last = null;
  for (const i of list) {
    if (i.containerId === targetId) continue;
    try {
      last = await call('move', i.containerId, targetId, i.id, folderOf ? { folder: folderOf(i) } : undefined);
      moved++;
    } catch (e) {
      failed++;
      toast(`${i.title}: ${e.message}`, 'error');
    }
  }
  clearSelection();
  ui.selected = list.length === 1 && last ? last.key : null;
  if (moved && !folderOf) toast(moved === 1 ? t('Verschoben') : t('{n} Einträge verschoben', { n: moved }));
  if (!folderOf) await reloadAll();
  return failed;
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

/** template: preset values of a login template (entryTemplate in core/model.js). */
function newItem(type = 'login', template = null) {
  if (!writableContainers().length) {
    toast(t('Kein Tresor mit Schreibrechten – zuerst einen Tresor hinzufügen, erstellen oder entsperren'), 'error');
    return;
  }
  ui.newType = type;
  ui.newTemplate = template;
  ui.editing = 'new';
  ui.editingItem = null;
  renderDetail();
}

async function renderDetail() {
  const pane = panes.detail;
  call('selectItem', ui.selected).catch(() => {});
  if (ui.editing) return renderEditor();
  if (selectionSize() > 1) return renderMultiSelection();
  if (!ui.selected) {
    pane.replaceChildren(h('div', { class: 'placeholder' }, placeholderMark(), h('p', {}, t('Wähle einen Eintrag aus oder lege einen neuen an.'))));
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
  // Linked login (domain or Microsoft login): shown and copied with the linked values; edited as stored (no copy).
  const shown = await resolveLogin(item, (c, i) => call('item', c, i));
  if (ui.selected !== key || ui.editing) return undefined;
  const canWrite = writable(st.containers.find((c) => c.id === containerId) || {});
  pane.replaceChildren(itemDetail(shown, {
    copy,
    // Linked to a Microsoft login: the website opens with a one-click sign-in for that account.
    openUrl: shown.linked?.microsoft ? (u) => call('openWithMicrosoft', { containerId, id, url: u })
      .then((r) => toast(r.signIn ? t('Geöffnet – die Browser-Erweiterung meldet dich mit dem Microsoft-Login an') : t('Geöffnet – ohne Browser-Erweiterung bitte selbst anmelden')), (e) => toast(e.message, 'error')) : openUrl,
    containerName,
    connect: (it, method) => connectServer(it.containerId, it.id, method),
    adminLinks: st.settings?.adminTools === true ? ADMIN_LINKS.map((l) => ({ ...l, open: (it) => openAdminLink(l, `${it.containerId}/${it.id}`) })) : null,
    linkTitle,
    saveFile: async (name, data) => {
      try {
        const path = await call('saveCertificate', name, data);
        if (path) toast(t('Gespeichert: {path}', { path }));
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    onMovePasskey: canWrite ? (passkey) => movePasskeyDialog(item, passkey) : null,
    passkeyDrag: canWrite ? (e, passkey) => {
      e.stopPropagation();
      draggedPasskey = { from: `${item.containerId}/${item.id}`, credentialId: passkey.credentialId };
      e.dataTransfer.setData(DRAG_PASSKEY, JSON.stringify(draggedPasskey));
      e.dataTransfer.effectAllowed = 'move';
    } : null,
    passkeyDragEnd: () => { draggedPasskey = null; },
    onRemovePasskey: canWrite ? async (credentialId) => {
      if (!(await confirmDialog(t('Passkey entfernen'), t('Passkey aus dem Eintrag entfernen? Die Anmeldung bei der Website damit ist danach nicht mehr möglich – entferne ihn dort ebenfalls.'), { confirmLabel: t('Entfernen'), danger: true }))) return;
      try {
        await call('save', containerId, { ...item, passkeys: item.passkeys.filter((p) => p.credentialId !== credentialId) }, item.version);
        await reloadAll();
      } catch (e) {
        toast(e.message, 'error');
      }
    } : null,
    // "⋯" in the head opens the same menu as a right-click in the list.
    menu: (anchor, items, { below = false } = {}) => {
      const r = anchor.getBoundingClientRect();
      if (below) return contextMenu({ preventDefault() {}, clientX: Math.max(8, r.right - 240), clientY: r.bottom + 6 }, items);
      // The toolbar floats at the bottom: the menu opens upwards, right above it.
      const height = items.reduce((sum, x) => sum + (x === '-' ? 9 : 34), 10);
      contextMenu({ preventDefault() {}, clientX: Math.max(8, r.right - 240), clientY: Math.max(8, r.top - height - 6) }, items);
    },
    actions: [
      canWrite ? { action: 'edit', icon: 'edit', label: t('Bearbeiten'), primary: true, onClick: () => {
        ui.editing = 'edit';
        ui.editingItem = item;
        renderDetail();
      } } : null,
      canWrite ? { icon: 'star', quick: true, on: !!item.favorite, label: item.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), onClick: () => toggleFavorite(item) } : null,
      canWrite ? { action: 'move', icon: 'move', label: t('Verschieben'), onClick: () => moveDialog(item) } : null,
      canWrite ? { action: 'duplicate', icon: 'copy', label: t('Duplizieren'), onClick: () => duplicateItem(containerId, id) } : null,
      { action: 'history', icon: 'history', label: t('Verlauf'), onClick: () => historyDialog(item) },
      buildItemLink(st.containers.find((c) => c.id === containerId), id)
        ? { icon: 'link', quick: true, label: t('Link kopieren'), onClick: () => copyItemLink(st.containers.find((c) => c.id === containerId), id) } : null,
      st.containers.find((c) => c.id === containerId)?.secure
        ? { icon: 'clock', label: t('Änderungsprotokoll'), onClick: () => changelogDialog(st.containers.find((c) => c.id === containerId), id) } : null,
      canWrite ? { action: 'delete', icon: 'trash', label: t('Löschen'), danger: true, onClick: async () => {
        if (!(await confirmDialog(t('Eintrag löschen'), `${t('„{title}“ löschen?', { title: item.title })} ${await deleteNotice(st.containers.find((x) => x.id === containerId))}`, { confirmLabel: t('Löschen'), danger: true }))) return;
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

// ---------------------------------------------------------------- admin tools

/** Logins a server entry can link to (accounts for RDP, TeamViewer, Bastion); Microsoft admin accounts marked. */
const linkOptions = () => items.filter((i) => i.type === 'login')
  // avatar: the entry's own icon or logo as in the list (#32), loaded the same way.
  .map((i) => ({ key: i.key, containerId: i.containerId, title: i.title, username: i.username, container: containerName(i.containerId), msAdmin: !!i.msAdmin, loginLinked: !!i.loginLinked, avatar: () => itemAvatar(i) }))
  .sort((a, b) => a.title.localeCompare(b.title));

function linkTitle(key) {
  const i = items.find((x) => x.key === key);
  return i ? [i.title, i.username, containerName(i.containerId)].filter(Boolean).join(' · ') : '';
}

async function connectServer(containerId, id, method) {
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
const ADMIN_LINKS = [
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
function movePasskeyDialog(item, passkey) {
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
  let chosen = targets[0].key;
  const search = h('input', { type: 'search', class: 'link-pick-search', placeholder: t('Eintrag suchen (Titel, Benutzer, Tresor) …'), 'aria-label': t('Eintrag suchen') });
  const list = h('div', { class: 'link-pick-list', role: 'listbox' });
  const LIMIT = 200;
  const draw = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = targets.filter((i) => words.every((w) => [i.title, i.username, containerName(i.containerId)].join(' ').toLowerCase().includes(w)));
    if (!hits.some((i) => i.key === chosen)) chosen = hits[0]?.key || '';
    list.replaceChildren(...[
      ...hits.slice(0, LIMIT).map((i) => h('button', { type: 'button', role: 'option', class: `link-pick-row ${i.key === chosen ? 'on' : ''}`, 'aria-selected': String(i.key === chosen),
        onclick: () => { chosen = i.key; draw(); } },
      avatar(i.title, 'avatar small'), h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, i.title),
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
    search, list,
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
function passkeyFits(i, data = draggedPasskey) {
  return !!data && i.type === 'login' && i.key !== data.from && writable(st.containers.find((c) => c.id === i.containerId) || {});
}

/** A passkey dropped on a login in the list: one confirmation, then it moves. */
async function dropPasskey(data, target) {
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
async function openAdminLink(link, key) {
  try {
    const r = await call('openAdminCenter', { url: link.url, key });
    toast(r.signIn ? t('{center} geöffnet – die Browser-Erweiterung meldet dich an', { center: link.name }) : t('{center} geöffnet – ohne Browser-Erweiterung bitte selbst anmelden', { center: link.name }));
  } catch (e) {
    toast(e.message, 'error');
  }
}


/**
 * Two installations (machine-wide MSI and per-user EXE): both are "Keevault" in the Start menu, only one updates
 * itself – people keep opening the old one. Told once per session; "Don't show again" per path and version.
 */
let otherInstallChecked = false;
async function checkOtherInstallation(found) {
  if (otherInstallChecked && !found) return;
  otherInstallChecked = true;
  const other = found || await call('otherInstallation').catch(() => null);
  if (!other) return;
  const id = `${other.dir}|${other.version}`;
  if (!found && st.settings.otherInstallDismissed === id) return;
  const text = other.kind === 'msi'
    ? t('Auf diesem Gerät ist zusätzlich eine Keevault-Installation für alle Benutzer (Version {version}, {dir}). Sie aktualisiert sich nicht selbst und steht im Startmenü ebenfalls als „Keevault“ – so startet man leicht die alte Version.', { version: other.version || '?', dir: other.dir })
    : t('Auf diesem Gerät ist zusätzlich eine Keevault-Installation nur für dich (Version {version}, {dir}). Sie steht im Startmenü ebenfalls als „Keevault“ – so startet man leicht die falsche Version.', { version: other.version || '?', dir: other.dir });
  modal(t('Zwei Keevault-Installationen'), h('div', {},
    h('p', {}, text),
    h('p', {}, other.kind === 'msi'
      ? t('Empfehlung: Die Installation für alle Benutzer unter Einstellungen → Apps deinstallieren (braucht Administratorrechte) – oder, wenn eure IT Keevault verteilt, die Installation nur für dich entfernen.')
      : t('Empfehlung: Eine der beiden unter Einstellungen → Apps deinstallieren. Deine Tresore und Einstellungen bleiben erhalten.')),
    h('p', { class: 'muted small' }, t('Diese Version: {version}', { version: st.version || '' }))), [
    { label: t('Nicht mehr anzeigen'), onClick: () => call('updateSettings', { otherInstallDismissed: id }).then((s) => { st.settings = s; }) },
    { label: t('Später') },
    { label: t('Apps öffnen'), primary: true, onClick: () => call('openAppsSettings') },
  ]);
}

function renderEditor() {
  const isNew = ui.editing === 'new';
  const item = isNew ? { type: ui.newType || 'login', urls: [], ...ui.newTemplate, password: ui.newPassword || '' } : ui.editingItem;
  ui.newPassword = '';
  ui.newTemplate = null;
  const targets = writableContainers();
  const folderTarget = isNew ? ui.containerId : item.containerId;
  const knownFolders = [...new Set([...folderList(folderTarget), ...modeItems(folderTarget).map((i) => i.folder).filter(Boolean)])].sort();
  const folderContainer = st.containers.find((c) => c.id === folderTarget);
  const form = itemForm(item, {
    isNew,
    linkOptions: linkOptions(),
    devices: adminMode(),
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
    (st.settings.personalVaults || []).length ? null : option('user', t('Persönlicher Tresor (kostenlos)'), t('Nur für dich, verschlüsselt in deinem OneDrive (oder einem anderen synchronisierten Ordner bzw. Netzlaufwerk). Masterpasswort, App-PIN, optional FIDO-Stick.'), personalWizard),
    option('note', t('Neuer Datei-Tresor'), t('Verschlüsselte Datei wie bei KeePass, abgesichert mit Passkey und/oder Masterpasswort.'), createFileDialog),
    option('folder', t('Datei-Tresor öffnen'), t('Vorhandene .kvpws-Datei, z. B. von einem Netzlaufwerk.'), openFile),
    option('link', t('Vorhandenen Key Vault hinzufügen'), st.signedIn
      ? t('Aus deinen Key Vaults wählen oder per Adresse/Einladungslink. Der Zugriff kommt über Azure-Rollen.')
      : t('Key Vault per Adresse oder Einladungslink. Der Zugriff kommt über Azure-Rollen.'), () => addContainerDialog()),
    option('plus', t('Neuen Key-Vault-Tresor erstellen'), st.signedIn
      ? t('Legt einen Key Vault in einem Azure-Abonnement an, z. B. für ein Team.')
      : t('Der Assistent führt Schritt für Schritt durch Anmeldung, Ort, Zugriff und Notfallkonten.'), () => vaultWizard({ intro: false }))), []);
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

// ---------------------------------------------------------------- personal vault wizard

/**
 * Wizard for the personal vault: what it is → where it lives (OneDrive found automatically, or another synced folder /
 * network drive; an existing vault there can be used) → master password and app PIN → optional FIDO key → recovery
 * key. The vault is free and for one person only.
 */
async function personalWizard() {
  const s = { step: 0, info: null, mode: 'create', id: null, recoveryKey: null };
  const body = h('div', { class: 'wizard' });
  const { dialog, close } = modal(t('Persönlicher Tresor'), body, []);
  dialog.classList.add('wizard-modal');
  const closed = new Promise((resolve) => dialog.addEventListener('close', resolve));
  const steps = [t('Start'), t('Speicherort'), t('Schutz'), t('FIDO-Stick'), t('Fertig')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b);
  const btn = (label, onClick, { primary = false, disabled = false } = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', disabled, onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  const go = (step) => { s.step = step; draw(); };
  const locationLine = (info) => {
    const loc = info?.location;
    if (!info?.folder) return notice(t('Kein OneDrive gefunden. Richte OneDrive ein oder wähle einen anderen synchronisierten Ordner bzw. ein Netzlaufwerk.'), 'warn');
    if (!loc || !REMOTE_KINDS.includes(loc.kind)) return notice(t('Dieser Ordner liegt lokal auf dem Gerät – bitte einen synchronisierten Ordner oder ein Netzlaufwerk wählen.'), 'warn');
    const what = loc.kind === 'cloud' ? loc.provider || t('Cloud-Ordner') : t('Netzlaufwerk');
    const s = syncState(loc);
    const state = s.level === 'ok' || !s.text ? t('bereit') : s.text;
    return notice(t('{what} · {state}', { what, state }), s.level === 'problem' ? 'warn' : 'info');
  };
  const pinFields = () => st.pinSet
    ? { el: field(t('App-PIN'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin' })), pin: () => body.querySelector('.wiz-pin').value, repeat: null }
    : { el: h('div', { class: 'grid2' },
      field(t('Neue App-PIN'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin' })),
      field(t('Wiederholen'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin2' }))),
    pin: () => body.querySelector('.wiz-pin').value, repeat: () => body.querySelector('.wiz-pin2').value };
  const ensurePin = async (pf) => {
    if (st.pinSet) return pf.pin();
    if (pf.pin() !== pf.repeat()) throw new Error(t('Die PINs stimmen nicht überein'));
    await call('setPin', { current: null, next: pf.pin() });
    st = await fetchState();
    return pf.pin();
  };

  const draw = async () => {
    let content;
    if (s.step === 0) {
      content = [
        h('p', {}, t('Ein kostenloser Tresor nur für dich: verschlüsselt in deinem OneDrive (oder einem anderen synchronisierten Ordner bzw. auf einem Netzlaufwerk) und auf jedem deiner Geräte verfügbar.')),
        h('ul', { class: 'wizard-points' },
          h('li', {}, t('Verschlüsselt mit deinem Masterpasswort – niemand sonst kann ihn öffnen, auch kein Admin.')),
          h('li', {}, t('Im Alltag entsperrst du mit deiner App-PIN; optional zusätzlich mit einem FIDO-Stick.')),
          h('li', {}, t('Nicht teilbar und ohne Lizenz.')),
          h('li', {}, t('Mehr Ordnung (z. B. privat und geschäftlich): Ordner im persönlichen Tresor anlegen.'))),
        buttons(btn(t('Abbrechen'), () => close()), btn(t('Weiter'), async () => { s.info = await call('personalInfo'); go(1); }, { primary: true })),
      ];
    } else if (s.step === 1) {
      const info = s.info;
      const ok = info?.folder && info.location && REMOTE_KINDS.includes(info.location.kind);
      content = [
        h('p', {}, t('Speicherort der Datei:')),
        h('div', { class: 'wizard-path' }, icon('folder', 16), h('code', {}, info?.path || '–')),
        locationLine(info),
        info?.exists ? h('div', { class: 'wizard-choice' },
          h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pmode', checked: s.mode === 'use', onchange: () => { s.mode = 'use'; } }), t('Bestehenden Tresor verwenden (dort liegt schon einer)')),
          h('label', { class: 'inline muted' }, h('input', { type: 'radio', name: 'pmode', disabled: true }), t('Neu erstellen – dafür einen anderen Ordner wählen'))) : null,
        buttons(
          btn(t('Zurück'), () => go(0)),
          btn(t('Anderen Ordner wählen …'), async () => { const r = await call('choosePersonalFolder'); if (r) { s.info = r; s.mode = r.exists ? 'use' : 'create'; draw(); } }),
          btn(t('Weiter'), () => { s.mode = info.exists ? 'use' : 'create'; go(2); }, { primary: true, disabled: !ok })),
      ];
    } else if (s.step === 2) {
      const pw = h('input', { type: 'password', autocomplete: 'new-password' });
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
      const pf = pinFields();
      content = s.mode === 'create' ? [
        h('p', {}, t('Das Masterpasswort verschlüsselt den Tresor. Wähle es lang und einzigartig (mindestens 12 Zeichen) – du brauchst es auf neuen Geräten und zum Ändern der PIN.')),
        h('div', { class: 'grid2' }, field(t('Masterpasswort'), pw), field(t('Wiederholen'), pw2)),
        strengthMeter(pw),
        h('p', { class: 'muted small' }, st.pinSet ? t('Deine App-PIN entsperrt den Tresor auf diesem Gerät.') : t('Lege eine App-PIN fest – sie entsperrt den Tresor auf diesem Gerät.')),
        pf.el,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Tresor erstellen'), async () => {
          if (pw.value.length < 12) throw new Error(t('Das Masterpasswort braucht mindestens 12 Zeichen'));
          if (pw.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
          const pin = await ensurePin(pf);
          const r = await call('createPersonal', { folder: s.info.folder, password: pw.value, pin });
          s.id = r.id;
          s.recoveryKey = r.recoveryKey;
          await reloadAll();
          go(3);
        }, { primary: true })),
      ] : [
        h('p', {}, t('Entsperre den vorhandenen Tresor einmal mit seinem Masterpasswort. Danach reicht auf diesem Gerät deine App-PIN.')),
        field(t('Masterpasswort'), pw),
        pf.el,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Verwenden und entsperren'), async () => {
          const pin = await ensurePin(pf);
          const r = await call('usePersonal', { folder: s.info.folder });
          s.id = r.id;
          await call('unlockContainer', r.id, { password: pw.value });
          await call('bindPersonalWithPin', pin);
          await reloadAll();
          go(3);
        }, { primary: true })),
      ];
    } else if (s.step === 3) {
      content = [
        h('p', {}, t('Optional: Ein FIDO-Stick (z. B. YubiKey) kann den Tresor zusätzlich zum Masterpasswort entsperren – praktisch auf neuen Geräten. Der Stick muss „PRF“ (hmac-secret) unterstützen.')),
        buttons(
          btn(t('Überspringen'), () => go(4)),
          btn(t('FIDO-Stick hinzufügen …'), async () => {
            const c = st.containers.find((x) => x.id === s.id);
            if (c) await manageDialog(c, protectCtx, () => reloadAll());
          }, { primary: true }),
          btn(t('Weiter'), () => go(4))),
      ];
    } else {
      content = [
        h('p', {}, t('Der persönliche Tresor ist eingerichtet und steht ganz oben in der Seitenleiste.')),
        s.recoveryKey ? h('p', {}, t('Bewahre jetzt den Wiederherstellungsschlüssel sicher auf (ausdrucken, nicht im selben Tresor) – ohne ihn sind die Daten verloren, wenn du das Masterpasswort vergisst.')) : null,
        buttons(
          s.recoveryKey ? btn(t('Wiederherstellungsschlüssel anzeigen'), () => showRecoveryKey(s.recoveryKey)) : null,
          btn(t('Fertig'), () => { close(); if (s.id) select({ view: 'container', containerId: s.id }); }, { primary: true })),
      ];
    }
    body.replaceChildren(header(), ...[content].flat().filter(Boolean));
  };
  draw();
  return closed;
}

async function firstStartWizards({ always = false } = {}) {
  await personalWizard();
  await call('syncSettings').catch(() => null);
  st = await fetchState();
  if (document.querySelector('dialog[open]')) return render();
  if (!always && (st.containers.some((c) => c.kind === 'keyvault') || st.settings.containers.length)) return render();
  await vaultWizard();
  return render();
}

/** After the personal vault was opened with its master password on this device: bind it to the PIN. */
function personalPinPrompt() {
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  modal(t('Mit PIN entsperren'), h('div', {},
    h('p', {}, t('Gib deine App-PIN ein – dann entsperrt sie den persönlichen Tresor auf diesem Gerät, ohne Masterpasswort.')),
    field(t('App-PIN'), pin)), [
    { label: t('Später') },
    { label: t('Übernehmen'), primary: true, onClick: async () => { await call('bindPersonalWithPin', pin.value); toast(t('Persönlicher Tresor mit PIN verbunden')); } },
  ]);
  setTimeout(() => pin.focus(), 0);
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

/**
 * Setup wizard for a team vault in Azure Key Vault, step by step with what each step means: what it is and what is
 * needed → sign in → where (subscription, resource group, new or existing empty Key Vault) → who gets access →
 * break-glass accounts → check and create. intro: false starts at the sign-in (or, signed in, at "where").
 */
async function vaultWizard({ intro = true } = {}) {
  const s = { step: intro ? 0 : st.signedIn ? 2 : 1, subs: null, done: null };
  const body = h('div', { class: 'wizard vault-wizard' });
  const { dialog, close } = modal(t('Tresor einrichten'), body, []);
  dialog.classList.add('wizard-modal');
  const steps = [t('Start'), t('Anmelden'), t('Ort'), t('Zugriff'), t('Notfallzugang'), t('Erstellen')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b);
  const btn = (label, onClick, { primary = false, disabled = false } = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', disabled, onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  const go = async (step) => {
    s.step = step;
    if (step === 2 && !s.subs) await loadSubscriptions();
    draw();
  };
  const explain = (...lines) => h('div', { class: 'wizard-explain' }, ...lines.map((x) => (typeof x === 'string' ? h('p', {}, x) : x)));

  const VIA = { home: '', guest: t('Gast'), lighthouse: t('nur Lighthouse') };
  const display = h('input', { placeholder: t('z. B. Team Infrastruktur') });
  const name = h('input', { placeholder: t('kv-pws-team (weltweit eindeutig)') });
  const sub = h('select');
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
  const current = () => (s.subs || []).find((x) => x.id === sub.value);
  const drawRgNotice = () => {
    const x = current();
    const msg = !x || x.via === 'lighthouse' ? null
      : mode.value === 'new' && rgPermissions && !rgPermissions.createVault
        ? notice(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen (nötig: Besitzer oder Mitwirkender). Wähle „Vorhandenen leeren Key Vault verwenden“ oder eine andere Ressourcengruppe.'), 'warn')
        : rgPermissions && !rgPermissions.assignRoles
          ? notice(t('Du darfst hier keine Rollen vergeben – Zugriff für Gruppen und Gäste muss dann jemand mit Besitzer-Rechten erteilen.'), 'info') : null;
    setChildren(rgNotice, msg);
  };
  const loadGroup = async () => {
    const x = current();
    rgPermissions = null;
    existing.replaceChildren();
    if (!x || !rg.value || x.via === 'lighthouse') return drawRgNotice();
    call('groupPermissions', x.id, x.tenantId, rg.value).then((p) => { rgPermissions = p; drawRgNotice(); }, () => drawRgNotice());
    if (mode.value !== 'existing') return drawRgNotice();
    existing.replaceChildren(h('option', { value: '' }, t('Wird geladen …')));
    try {
      const vaults = await call('groupVaults', x.id, x.tenantId, rg.value);
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
  const regionField = field(t('Region'), loc);
  const purgeLabel = h('label', { class: 'inline' }, purge, t('Löschschutz (Purge Protection) – empfohlen, nicht umkehrbar'));
  mode.addEventListener('change', () => {
    newFields.hidden = mode.value !== 'new';
    existingFields.hidden = mode.value !== 'existing';
    purgeLabel.hidden = mode.value !== 'new';
    regionField.hidden = mode.value !== 'new';
    loadGroup();
  });

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

  // Break-glass accounts: permanent full access ("Manage") to the new vault, remembered per tenant for the next one.
  const breakGlass = [];
  const bgList = h('div', { class: 'access-list' });
  const bgSearch = h('input', { placeholder: t('Notfallkonto suchen (Name oder E-Mail) …') });
  const bgResults = h('div', { class: 'search-results' });
  const bgRemember = h('input', { type: 'checkbox', checked: true });
  const drawBreakGlass = () => setChildren(bgList, breakGlass.length
    ? breakGlass.map((p, i) => h('div', { class: 'member' }, icon(p.type === 'Group' ? 'users' : 'user'),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, p.displayName), h('div', { class: 'row-sub' }, p.detail || '')),
      h('span', { class: 'badge accent' }, t('Verwalten')),
      iconButton('x', t('Entfernen'), () => { breakGlass.splice(i, 1); drawBreakGlass(); })))
    : [notice(h('span', {}, t('Ohne Notfallkonto kommt niemand an die Passwörter, wenn die normale Anmeldung klemmt (Conditional Access, MFA, PIM). '),
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(getLanguage() === 'en' ? 'https://keevault.de/en/knowledge/vault-hardening.html#break-glass-accounts' : 'https://keevault.de/wissen/tresor-absichern.html#break-glass-konten') }, t('Mehr zu Break-Glass-Konten'))), 'warn')]);
  let bgTimer;
  bgSearch.addEventListener('input', () => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(async () => {
      const q = bgSearch.value.trim();
      if (q.length < 2) return bgResults.replaceChildren();
      const found = await call('searchPrincipalsIn', q, current().tenantId).catch(() => []);
      return bgResults.replaceChildren(...found.filter((p) => !breakGlass.some((b) => b.id === p.id)).map((p) => h('button', { type: 'button', class: 'choice', onclick: () => {
        breakGlass.push({ id: p.id, type: p.type, displayName: p.displayName, detail: p.detail || '' });
        bgSearch.value = '';
        bgResults.replaceChildren();
        drawBreakGlass();
      } }, icon(p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.type === 'Group' ? t('Gruppe') : p.detail))));
    }, 300);
  });
  const loadBreakGlass = () => {
    breakGlass.length = 0;
    breakGlass.push(...((st.settings.breakGlass || {})[current()?.tenantId] || []));
    drawBreakGlass();
  };

  const syncLocation = () => {
    const l = rg.selectedOptions[0]?.dataset.location;
    if (l) loc.value = l;
  };
  const loadSubscription = async () => {
    const x = current();
    if (!x) return;
    setChildren(subNotice, x.via === 'lighthouse'
      ? notice(t('Diese Subscription siehst du nur über Azure Lighthouse. So angelegte Key Vaults lassen sich nicht nutzen: Lighthouse vergibt keine Datenrollen und lädt keine Gäste ein. Lass dich im Kunden-Tenant als Gast einladen und gib dem Gastkonto Besitzer auf der Ressourcengruppe – dann erscheint die Subscription hier mit „Gast“.'), 'warn')
      : x.via === 'guest' ? notice(t('Wird im Tenant „{tenant}“ mit deinem Gastkonto angelegt; Gruppen und Personen stammen aus diesem Verzeichnis.', { tenant: x.tenantName || x.tenantId }), 'info') : null);
    access.length = 0;
    drawAccess();
    loadBreakGlass();
    try {
      const [groups, locations] = await Promise.all([call('resourceGroups', x.id, x.tenantId), call('locations', x.id, x.tenantId)]);
      rg.replaceChildren(...groups.map((g) => h('option', { value: g.name, dataset: { location: g.location } }, g.name)));
      loc.replaceChildren(...locations.map((l) => h('option', { value: l.name }, l.displayName)));
      syncLocation();
      loadGroup();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const loadSubscriptions = async () => {
    try {
      s.subs = await call('subscriptions');
    } catch (e) {
      s.subs = null;
      throw e;
    }
    sub.replaceChildren(...s.subs.map((x) => h('option', { value: x.id }, VIA[x.via] ? `${x.name} (${VIA[x.via]})` : x.name)));
    if (s.subs.length) await loadSubscription();
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

  const checkWhere = () => {
    const x = current();
    if (!x) throw new Error(t('Kein Azure-Abonnement verfügbar'));
    if (x.via === 'lighthouse') throw new Error(t('Über Azure Lighthouse lässt sich hier kein nutzbarer Tresor anlegen (siehe Hinweis).'));
    if (!rg.value) throw new Error(t('Bitte eine Ressourcengruppe wählen'));
    if (mode.value === 'existing') {
      const option = existing.selectedOptions[0];
      if (!option?.value || option.disabled) throw new Error(t('Bitte einen leeren Key Vault wählen'));
    } else {
      if (rgPermissions && !rgPermissions.createVault) throw new Error(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen'));
      if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(name.value.trim())) throw new Error(t('Key-Vault-Name: 3–24 Zeichen, mit einem Buchstaben beginnen, Buchstaben, Ziffern und Bindestriche'));
    }
  };

  const create = async () => {
    const x = current();
    checkWhere();
    // Break-glass accounts get "Manage"; someone chosen in both lists keeps the higher level.
    const members = access.filter((a) => a.principal && !breakGlass.some((b) => b.id === a.principal.id)).map((a) => ({ principal: a.principal, level: a.level }))
      .concat(breakGlass.map((p) => ({ principal: p, level: 'manage' })));
    if (bgRemember.checked && x.tenantId) {
      st.settings = await call('updateSettings', { breakGlass: { ...(st.settings.breakGlass || {}), [x.tenantId]: breakGlass.map((p) => ({ ...p })) } });
    }
    const guests = access.filter((a) => a.email).map((a) => ({ email: a.email, level: a.level }));
    let r;
    if (mode.value === 'existing') {
      const option = existing.selectedOptions[0];
      r = await call('adoptVault', {
        subscriptionId: x.id, tenantId: x.tenantId, via: x.via, vaultUrl: option.value, resourceId: option.dataset.resourceId,
        displayName: display.value.trim() || option.dataset.name, members, guests,
      });
    } else {
      toast(t('Tresor wird erstellt …'));
      r = await call('createContainer', {
        subscriptionId: x.id, tenantId: x.tenantId, via: x.via, resourceGroup: rg.value, location: loc.value,
        name: name.value.trim(), displayName: display.value.trim() || name.value.trim(), purgeProtection: purge.checked,
        members,
        guests,
      });
    }
    for (const w of r.warnings) toast(w, 'error');
    s.done = { id: r.id, warnings: r.warnings };
    ui.containerId = r.id;
    ui.view = 'container';
    await reloadAll();
    draw();
  };

  const choice = (iconName, title, text, onClick) => h('button', { type: 'button', class: 'option-card', onclick: onClick },
    icon(iconName, 20), h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, text)));

  const draw = () => {
    let content;
    if (s.done) {
      content = [
        explain(t('Der Tresor ist eingerichtet und steht in der Seitenleiste.'),
          t('Neue Rollen können einige Minuten brauchen, bis sie wirken – bis dahin kann der Tresor kurz „Kein Zugriff“ zeigen.'),
          t('Weitere Personen gibst du später per Rechtsklick auf den Tresor → „Teilen“ frei.')),
        s.done.warnings.length ? notice(t('Nicht alles hat geklappt – siehe Meldungen. Fehlende Rollen kann jemand mit Besitzer-Rechten nachtragen.'), 'warn') : null,
        buttons(btn(t('Fertig'), () => close(), { primary: true })),
      ];
    } else if (s.step === 0) {
      content = [
        explain(t('Ein Tresor ist der Ort, an dem Keevault Passwörter, Passkeys und Zertifikate speichert. Für ein Team oder eine Firma empfehlen wir einen Tresor in Azure Key Vault: Zugriff über Azure-Rollen, Audit-Log, keine Datei, die man kopieren kann.'),
          t('Wähle, was du einrichten möchtest. Der Assistent erklärt jeden Schritt.')),
        choice('plus', t('Neuen Tresor in Azure anlegen'), t('Für ein Team: Key Vault in deinem Azure-Abonnement, Zugriff für Gruppen und Personen. Nötig: Besitzer-Rechte auf einer Ressourcengruppe.'), () => go(1)),
        choice('link', t('Vorhandenen Tresor verbinden'), t('Ein Kollege hat schon einen Tresor eingerichtet und dir Zugriff gegeben, oder du hast einen Einladungslink.'), async () => {
          // Signed in, the dialog lists the vaults found in Azure to pick from.
          if (!st.signedIn) {
            try {
              await call('signIn');
              st = await fetchState();
            } catch (e) {
              toast(e.message, 'error');
            }
          }
          close();
          addContainerDialog();
        }),
        choice('note', t('Datei-Tresor (ohne Azure)'), t('Verschlüsselte Datei wie bei KeePass, z. B. auf einem Netzlaufwerk.'), () => { close(); createFileDialog(); }),
        buttons(btn(t('Später'), () => close())),
      ];
    } else if (s.step === 1) {
      content = [
        explain(t('Für einen Tresor in Azure meldest du dich mit deinem Arbeitskonto bei Microsoft an. Keevault fragt dabei nur nach den Rechten, die es für Key Vault braucht.'),
          t('Danach sucht Keevault deine Azure-Abonnements und Ressourcengruppen.')),
        st.signedIn ? notice(t('Angemeldet als {user}', { user: st.account?.username || '' }), 'info') : null,
        buttons(
          intro ? btn(t('Zurück'), () => go(0)) : null,
          st.signedIn
            ? btn(t('Weiter'), () => go(2), { primary: true })
            : btn(t('Mit Microsoft anmelden'), async () => {
              const r = await call('signIn');
              if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
              st = await fetchState();
              await go(2);
            }, { primary: true })),
      ];
    } else if (s.step === 2) {
      content = s.subs && !s.subs.length ? [
        explain(t('Mit diesem Konto ist kein Azure-Abonnement sichtbar. Für einen Tresor in Azure brauchst du ein Abonnement mit einer Ressourcengruppe, auf der du Besitzer bist – frag deine IT danach.'),
          t('Alternativ: Lass dir Zugriff auf einen vorhandenen Tresor geben oder richte einen Datei-Tresor ein.')),
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Vorhandenen Tresor verbinden'), () => { close(); addContainerDialog(); })),
      ] : [
        explain(t('Der Tresor ist ein Azure Key Vault in einer Ressourcengruppe deines Abonnements. Keevault legt ihn mit RBAC und Soft Delete an und gibt dir Bearbeiten- und Verwalten-Rechte.'),
          t('Nötig: Besitzer (oder Mitwirkender + Benutzerzugriffsadministrator) auf der Ressourcengruppe. Der Anzeigename ist nur für die App, der Key-Vault-Name muss weltweit eindeutig sein.')),
        // Two columns: where (subscription, group), what (new or existing, region), names – fits without scrolling.
        h('div', { class: 'grid2' }, field(t('Abonnement'), sub), field(t('Ressourcengruppe'), rg)),
        subNotice,
        h('div', { class: 'grid2' }, field(t('Key Vault'), mode), regionField),
        rgNotice,
        h('div', { class: 'grid2' }, field(t('Anzeigename'), display), h('div', {}, newFields, existingFields)),
        purgeLabel,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Weiter'), () => { checkWhere(); return go(3); }, { primary: true })),
      ];
    } else if (s.step === 3) {
      content = [
        explain(t('Wer soll den Tresor nutzen? Am besten eine Entra-Gruppe (z. B. dein Team) statt einzelner Personen – dann regelt die Gruppenmitgliedschaft den Zugriff. Externe lädst du per E-Mail als Gast ein.'),
          t('Lesen: Passwörter ansehen und nutzen. Bearbeiten: auch anlegen und ändern. Verwalten: auch Zugriff vergeben. Du kannst das später jederzeit unter „Teilen“ ändern.')),
        h('div', { class: 'field-row access-search' }, search, level),
        results,
        accessList,
        buttons(btn(t('Zurück'), () => go(2)), btn(t('Weiter'), () => go(4), { primary: true })),
      ];
    } else if (s.step === 4) {
      content = [
        explain(t('Notfallkonten (Break-Glass-Konten) bekommen dauerhaft „Verwalten“ – ohne PIM und ohne Bedingungen. So kommt im Notfall jemand an die Passwörter, wenn die normale Anmeldung klemmt.'),
          t('Optional, aber empfohlen. Die Konten merkt sich Keevault für weitere Tresore in diesem Tenant.')),
        bgSearch,
        bgResults,
        bgList,
        h('label', { class: 'inline' }, bgRemember, t('Für neue Tresore in diesem Tenant merken')),
        buttons(btn(t('Zurück'), () => go(3)), btn(t('Weiter'), () => go(5), { primary: true })),
      ];
    } else {
      const x = current();
      const row = (label, value) => h('div', { class: 'summary-row' }, h('span', { class: 'muted' }, label), h('b', {}, value));
      content = [
        explain(t('Bitte prüfen. „Erstellen“ legt den Tresor in Azure an und vergibt die Rollen – das dauert etwa eine Minute.')),
        h('div', { class: 'wizard-summary' },
          row(t('Anzeigename'), display.value.trim() || (mode.value === 'existing' ? existing.selectedOptions[0]?.dataset.name || '' : name.value.trim())),
          row(t('Abonnement'), x?.name || ''),
          row(t('Ressourcengruppe'), rg.value),
          mode.value === 'existing'
            ? row(t('Key Vault'), existing.selectedOptions[0]?.textContent || '')
            : row(t('Key Vault'), `${name.value.trim()} · ${loc.selectedOptions[0]?.textContent || loc.value}${purge.checked ? ` · ${t('Löschschutz')}` : ''}`),
          row(t('Zugriff'), access.length ? access.map((a) => `${a.email || a.principal.displayName} (${t(ACCESS_LEVELS[a.level].label)})`).join(', ') : t('nur du')),
          row(t('Notfallkonten'), breakGlass.length ? breakGlass.map((p) => p.displayName).join(', ') : t('keine'))),
        buttons(btn(t('Zurück'), () => go(4)), btn(mode.value === 'existing' ? t('Einrichten') : t('Erstellen'), create, { primary: true })),
      ];
    }
    body.replaceChildren(header(), ...[content].flat().filter(Boolean));
  };
  if (s.step === 2) {
    body.replaceChildren(h('span', { class: 'spinner' }));
    try {
      await loadSubscriptions();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  draw();
  return new Promise((resolve) => dialog.addEventListener('close', resolve));
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
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => copy(call('invite', container.id), t('Einladungslink')) }, icon('link'), t('Einladungslink kopieren')))),
  [{ label: t('Schließen') }]);
  load();
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
  const targets = writableContainers().filter((c) => c.id !== item.containerId && !(c.personal && !st.containers.find((x) => x.id === item.containerId)?.personal));
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Eintrag verschieben'), h('div', {},
    field(t('„{title}“ verschieben nach', { title: item.title }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht. Der bisherige Verlauf bleibt bis zum Ende der Aufbewahrungsfrist in der Quelle.'))), [
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
    save: async (containerId, list, onProgress, extra) => {
      const listener = (ev) => onProgress(ev.done, ev.total);
      progressListeners.add(listener);
      try {
        return await call('importItems', containerId, list, extra);
      } finally {
        progressListeners.delete(listener);
      }
    },
    download: () => call('saveSampleCsv').then((p) => p && toast(t('Gespeichert'))),
    openKdbx: (bytes, creds) => call('decryptKdbx', bytes, creds),
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

/** Why this installation does not update itself ('' when it does): MSI/MSIX package, or policy SelfUpdate=0. */
function managedUpdateHint(kind) {
  if (kind === 'managed') return t('Updates verteilt deine IT (Richtlinie SelfUpdate). Die App installiert nichts selbst.');
  if (kind === 'msi' || kind === 'msix') return t('Diese Installation (MSI/MSIX) wird von deiner IT bzw. über das Windows-Paket aktualisiert.');
  return '';
}

/** Release notes from the signed manifest (CHANGELOG section) as a list; "- " lines are items, others plain text. */
function releaseNotes(notes, installed) {
  const versions = releaseNotesSince(notes, installed, getLanguage());
  if (!versions.length) return null;
  // "Area: text" → the area in bold, as in the changelog ("Browser-Erweiterung: …").
  const item = (text) => {
    const m = /^([^:]{2,40}):\s+(.+)$/.exec(text);
    return h('li', {}, m ? [h('b', {}, `${m[1]}: `), m[2]] : text);
  };
  return h('div', { class: 'release-notes' },
    h('h4', {}, versions.length > 1 ? t('Neu seit deiner Version ({count} Updates)', { count: versions.length }) : t('Neu in dieser Version')),
    h('div', { class: 'rn-scroll' }, ...versions.map((v) => h('section', { class: 'rn-version' },
      v.version ? h('div', { class: 'rn-head' }, h('span', { class: 'rn-badge' }, v.version),
        v.date ? h('span', { class: 'muted small' }, /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? new Date(`${v.date}T12:00:00`).toLocaleDateString(locale()) : v.date) : null) : null,
      h('ul', {}, ...v.items.map(item))))));
}

/** Update error of the app (search, download, signature check): its code (KV-U…) and its section in the knowledge base. */
function updateErrorView(message) {
  const code = /signatur|signiert|signature/i.test(message) ? 'KV-U2'
    : /HTTP|net::|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|offline|proxy/i.test(message) ? 'KV-U1' : 'KV-U3';
  const url = `${getLanguage() === 'en' ? 'https://keevault.de/en/knowledge/install-and-update.html' : 'https://keevault.de/wissen/installation-und-updates.html'}#${code.toLowerCase()}`;
  return h('div', {}, notice(t('Update fehlgeschlagen: {message}', { message })),
    h('p', { class: 'muted small' }, t('Fehlercode {code}', { code }), ' · ',
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(url) }, t('Hilfe zu diesem Fehler'))));
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
    const managed = !!managedUpdateHint(s.kind);
    if (s.status === 'checking') return body.replaceChildren(h('p', {}, h('span', { class: 'spinner' }), ' ', t('Suche nach Updates …')));
    if (s.status === 'error') return body.replaceChildren(updateErrorView(s.error));
    if (s.status === 'downloading') {
      return body.replaceChildren(h('p', {}, t('Version {version} wird heruntergeladen …', { version: s.version || '' })),
        h('progress', { class: 'update-progress', max: 100, value: s.progress || 0 }));
    }
    if (s.status === 'none') return body.replaceChildren(h('p', {}, t('Keevault {version} ist aktuell.', { version: s.current })));
    if (s.status === 'available' || s.status === 'ready') {
      const notes = releaseNotes(s.notes, s.current);
      return body.replaceChildren(
        h('p', {}, t('Version {version} ist verfügbar (installiert: {current}).', { version: s.version, current: s.current })),
        ...(notes ? [notes] : []),
        managed
          ? h('p', { class: 'muted small' }, managedUpdateHint(s.kind))
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
  const browser = h('input', { type: 'checkbox', checked: s.browserIntegration, disabled: enforced('browserIntegration') });
  const windowsProvider = h('input', { type: 'checkbox', checked: s.windowsProvider, disabled: enforced('windowsProvider') });
  const windowsStatus = h('div', { class: 'muted small' }, h('span', { class: 'spinner' }));
  call('windowsProviderStatus').then((w) => windowsStatus.replaceChildren(!w.supported ? t('Nur unter Windows 11 verfügbar.')
    : !w.installed ? t('Nicht installiert – windows/Install-PasskeyProvider.ps1 ausführen (siehe README).')
      : w.enabled ? t('Installiert und in Windows aktiviert.')
        : w.registered ? t('Installiert, aber in Windows noch nicht aktiviert (Einstellungen → Konten → Passkeys → Erweiterte Optionen).')
          : t('Installiert, aber noch nicht bei Windows registriert.')), () => windowsStatus.replaceChildren());
  const extensionIds = h('input', { value: s.extensionIds.join(', '), disabled: enforced('extensionIds') });
  const signInWindows = h('input', { type: 'checkbox', checked: s.signInWindows !== false, disabled: enforced('signInWindows') });
  const startWithWindows = h('input', { type: 'checkbox', checked: !!s.startWithWindows });
  const autoDiscover = h('input', { type: 'checkbox', checked: !!s.autoDiscover });
  const settingsSync = h('input', { type: 'checkbox', checked: s.settingsSync !== false });
  const autoTypeKeys = h('select', {},
    ...[['CommandOrControl+Shift', 'Strg+Umschalt+U / P / O'], ['CommandOrControl+Alt', 'Strg+Alt+U / P / O'], ['', 'Aus (nur im App-Fenster)']]
      .map(([v, l]) => h('option', { value: v, selected: s.autoTypeKeys === v }, t(l))));
  const mcpEnabled = h('input', { type: 'checkbox', checked: !!s.mcpEnabled, disabled: enforced('mcpEnabled') });
  const offlineMirror = h('input', { type: 'checkbox', checked: !!s.offlineMirror && st.pinSet, disabled: enforced('offlineMirror') || !st.pinSet });
  const mcpBox = h('div', {});
  const mcpMode = h('select', { disabled: enforced('mcpScope') },
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
    const paths = new Set([...items.filter((i) => i.containerId === id).map((i) => i.folder), ...(explicitFolders.get(id) || await call('folders', id).catch(() => []))].filter((p) => p && !p.startsWith(ASSET_FOLDERS)));
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
        h('button', { type: 'button', class: 'btn small', onclick: () => copy(text, t('Konfiguration')) }, icon('copy', 14), t('Kopieren')));
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
  // Early Access: versions in the field test before everyone gets them (beta feed on keevault.de).
  const updateChannel = h('select', { name: 'updateChannel', disabled: enforced('updateChannel') },
    ...[['stable', 'Stabil – nur freigegebene Versionen (Standard)'], ['beta', 'Early Access – neue Versionen schon im Praxistest']]
      .map(([v, l]) => h('option', { value: v, selected: (s.updateChannel || 'stable') === v }, t(l))));
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
    // h() skips null children, replaceChildren() would print "null".
    return machine.replaceChildren(h('div', {},
      h('div', {}, t('Zertifikat des Passkey-Anbieters vertraut: {v}', { v: yes(x.certTrusted) })),
      h('div', {}, t('Erweiterungs-Richtlinie Edge: {edge} · Chrome: {chrome}', { edge: yes(x.edgePolicy), chrome: yes(x.chromePolicy) })),
      (!x.certTrusted || !x.edgePolicy) && x.canRunSetup ? button : null));
  };
  call('machineSetupStatus').then(drawMachine, () => {});
  const section = (title, ...children) => h('div', { class: 'settings-section' }, h('h3', {}, title), ...children);
  const managed = !!managedUpdateHint(st.updateKind);
  // Five tabs instead of one long page: everyday settings first, integrations and agents further right.
  // Fixed size, navigation on the left (#211): the dialog no longer jumps between tabs, only the page scrolls.
  const { dialog: settingsDialogEl } = modal(t('Einstellungen'), tabbed('settings', [
    { label: t('Allgemein'), icon: 'settings', content: [
      field(t('Sprache'), language),
      st.platform === 'win32' ? h('label', { class: 'inline' }, startWithWindows, t('Mit Windows starten (im Infobereich)')) : null,
      st.platform === 'win32' ? h('p', { class: 'muted small' }, t('Dann ist Keevault für Browser-Erweiterung und KI-Agenten sofort da, ohne dass sie die App erst starten müssen.')) : null,
      section(t('Einstellungen mitnehmen'),
        h('label', { class: 'inline' }, settingsSync, t('Einstellungen im persönlichen Tresor speichern')),
        h('p', { class: 'muted small' }, (st.settings.personalVaults || []).length
          ? t('Verbundene Tresore, Ansicht und Verhalten liegen verschlüsselt im persönlichen Tresor. Auf einem neuen Gerät übernimmt Keevault sie, sobald du dort den persönlichen Tresor öffnest. PIN, Geräteschlüssel und Freigaben für KI-Agenten bleiben auf dem Gerät.')
          : t('Dafür zuerst einen persönlichen Tresor einrichten.'))),
      section(t('Updates'),
        managed
          ? h('p', { class: 'muted small' }, managedUpdateHint(st.updateKind))
          : [field(t('Automatische Updates'), updateMode, t('„Automatisch“ installiert neue Versionen, sobald die App gesperrt ist oder beendet wird. Die Updates kommen von keevault.de.')),
            field(t('Update-Kanal'), updateChannel, t('Early Access bekommt neue Versionen, bevor sie für alle freigegeben werden – hilf beim Testen. Zurück auf „Stabil“ bleibt die installierte Version, bis die stabile sie eingeholt hat.'))],
        h('button', { type: 'button', class: 'btn small', onclick: () => updateDialog() }, icon('download', 14), t('Jetzt nach Updates suchen'))),
      s.enforced.length ? h('p', { class: 'muted small' }, t('Ausgegraute Werte sind über kvpwsafe.config.json vorgegeben.')) : null,
      h('p', { class: 'muted small' }, t('Version {version}', { version: st.version })),
    ] },
    { label: t('Sicherheit'), icon: 'shield', content: [
      h('div', { class: 'grid2' },
        field(t('Automatisch sperren nach (Minuten)'), autoLock, t('0 = nur beim Sperren des Computers')),
        field(t('Zwischenablage leeren nach (Sekunden)'), clip, t('0 = nie'))),
      section(t('App-PIN'),
        h('p', { class: 'muted small' }, st.pinSet
          ? t('Eine PIN ist gesetzt und wird beim Entsperren abgefragt.')
          : `${t('Keine PIN – jeder an diesem PC kann die App entsperren, solange Windows angemeldet ist.')} ${t('Tipp: Mit einer PIN (unter Einstellungen) entsperrst du ohne neues Microsoft-Fenster – deine Tresore erscheinen sofort.')}`),
        st.opened ? h('button', { type: 'button', class: 'btn small', onclick: () => pinDialog() }, icon('key', 14), st.pinSet ? t('PIN ändern') : t('PIN festlegen'))
          : h('p', { class: 'muted small' }, t('Zum Ändern zuerst entsperren.'))),
      section(t('Offline-Lesemodus'),
        h('label', { class: 'inline' }, offlineMirror, t('Einträge verschlüsselt für unterwegs spiegeln (nur lesen, PIN nötig)')),
        h('p', { class: 'muted small' }, st.pinSet
          ? t('Ohne Netzwerk zeigt Keevault den letzten Stand – nur lesen, keine Änderungen. Der Spiegel liegt AES-256-verschlüsselt im Profil; zum Öffnen braucht es dein Windows-Konto und die PIN. Er füllt sich beim nächsten Entsperren mit PIN.')
          : t('Dafür zuerst eine App-PIN festlegen – sie schützt den Offline-Speicher zusammen mit deinem Windows-Konto.'))),
    ] },
    { label: t('Anmeldung'), icon: 'user', content: [
      section(t('Microsoft Entra ID (Key-Vault-Tresore)'),
        st.account ? h('p', { class: 'muted small' }, t('Angemeldet als {user}', { user: st.account.username })) : h('p', { class: 'muted small' }, t('Keine IDs nötig: Melde dich einfach an und füge deine Key-Vault-Tresore hinzu.')),
        h('label', { class: 'inline' }, autoDiscover, t('Gefundene Keevault-Tresore automatisch verbinden')),
        h('p', { class: 'muted small' }, t('Verbindet nach der Anmeldung jeden Key Vault, der als Keevault-Tresor eingerichtet ist und auf den du Zugriff hast. Aus: Nur Tresore, die du selbst hinzufügst oder die deine Organisation vorgibt.')),
        field(t('Verzeichnis (Tenant)'), directory),
        field(t('Entsperren'), prompt),
        st.platform === 'win32' ? h('label', { class: 'inline' }, signInWindows, t('Anmeldung im Windows-Dialog (wie PowerShell/Azure CLI) statt im Browser')) : null,
        h('details', { open: st.ownApp || undefined }, h('summary', {}, t('Eigene App-Registrierung (optional)')),
          h('p', { class: 'muted small' }, t('Leer lassen für die Standard-Anmeldung. Eigene App-Registrierung: infra/Setup-KvPwSafe.ps1.')),
          h('div', { class: 'grid2' }, field(t('Tenant-ID'), tenant), field(t('Client-ID'), client))),
        st.signedIn ? h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger small', onclick: async () => {
          await call('signOut');
          render();
        } }, icon('logout'), t('Abmelden und Token-Cache löschen'))) : null),
    ] },
    { label: t('Integrationen'), icon: 'link', content: [
      section(t('Browser-Erweiterung'),
        h('label', { class: 'inline' }, browser, t('Datei-Tresore in der Browser-Erweiterung verfügbar machen')),
        h('p', { class: 'muted small' }, t('Registriert einen Native-Messaging-Host für Edge und Chrome (nur für dein Benutzerkonto). Die Erweiterung fragt beim ersten Zugriff nach deiner Zustimmung in dieser App.')),
        field(t('Erweiterungs-IDs'), extensionIds)),
      section(t('Windows-Passkey-Anbieter'),
        h('label', { class: 'inline' }, windowsProvider, t('Keevault als Passkey-Anbieter in Windows verwenden (wie 1Password)')),
        h('p', { class: 'muted small' }, t('Dann erscheint Keevault im Windows-Passkey-Dialog – auch für andere Browser und Apps. Jede Anmeldung bestätigst du in dieser App.')),
        h('p', { class: 'muted small' }, t('Für Edge und Chrome nicht nötig – dort nutzt die Browser-Erweiterung die Passkeys direkt. Beim Einschalten meldet Keevault seine Passkey-Komponente bei Windows an, beim Ausschalten wieder ab.')),
        windowsStatus),
      section(t('Abtippen (Auto-Type)'),
        field(t('Tastenkürzel, überall in Windows'), autoTypeKeys, t('Eintrag in der App auswählen, ins Zielfeld klicken, Kürzel drücken: U = Benutzername, P = Passwort, O = Einmalcode. Gilt nur, solange die App entsperrt ist; Strg+Umschalt überdeckt in Edge Vorlesen/InPrivate/Favoriten.'))),
      section(t('Einrichtung dieses Geräts'),
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
          h('button', { type: 'button', class: 'btn small', onclick: () => call('openWindowsPasskeySettings') }, t('Windows-Einstellungen öffnen')))),
    ] },
    { label: t('Ansicht'), icon: 'eye', content: [h('div', { class: 'view-settings' }, ...viewSettings())] },
    { label: t('KI-Agenten'), icon: 'wand', content: [
      section(t('KI-Agenten (MCP)'),
        h('label', { class: 'inline' }, mcpEnabled, t('KI-Agenten wie Claude oder GitHub Copilot anbinden (Model Context Protocol)')),
        h('p', { class: 'muted small' }, t('Agenten sehen beim Suchen nur Titel, Benutzer und URL. Passwörter lesen erlaubst du pro Sitzung, Einträge anlegen oder ändern bestätigst du jedes Mal. Löschen ist nicht möglich. Läuft Keevault nicht oder ist gesperrt, bekommt der Agent nichts.')),
        s.mcpEnabled ? h('div', {},
          field(t('Zugriff für KI-Agenten'), mcpMode, t('Freigeben geht auch per Rechtsklick auf einen Tresor oder Ordner. Ein freigegebener Ordner schließt seine Unterordner ein.')),
          h('div', { class: 'field' }, h('label', {}, t('Freigegeben')), scopeList,
            h('div', { class: 'inline' }, scopeVault, scopeFolder, scopeAdd)),
          mcpBox) : h('p', { class: 'muted small' }, t('Nach dem Einschalten und Speichern erscheinen hier die Einstellungen für deinen KI-Client.'))),
    ] },
  ]), [
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
        startWithWindows: startWithWindows.checked,
        autoDiscover: autoDiscover.checked,
        settingsSync: settingsSync.checked,
        updateMode: updateMode.value,
        updateChannel: updateChannel.value === 'beta' ? 'beta' : 'stable',
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
  settingsDialogEl.classList.add('settings-modal');
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

// Zoom: Ctrl + / Ctrl − / Ctrl 0 (also Ctrl with the number pad keys), everywhere in the window.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || !st) return;
  const key = e.key;
  const dir = key === '+' || key === '=' || e.code === 'NumpadAdd' ? 1 : key === '-' || e.code === 'NumpadSubtract' ? -1 : key === '0' || e.code === 'Numpad0' ? 0 : null;
  if (dir === null) return;
  e.preventDefault();
  stepZoom(dir);
});

document.addEventListener('keydown', (e) => {
  if (!st?.opened || document.querySelector('dialog[open]')) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    document.getElementById('search')?.focus();
  } else if (e.key === 'F1') {
    e.preventDefault();
    helpDialog();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (deviceMode()) newItem('server', { type: 'server', server: { kind: 'windows' } });
    else newItem('login');
  } else if (e.ctrlKey && e.shiftKey && ['u', 'p', 'o'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    typeSelected(e.key.toLowerCase());
  } else if (e.key === 'Escape' && ui.editing) {
    ui.editing = null;
    renderDetail();
  } else if (e.key === 'Escape' && selectionSize()) {
    clearSelection();
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
