import { h, icon, iconButton, setChildren, toast, avatar, confirmDialog, modal, formatDateTime } from '../core/dom.js';
import { itemDetail, itemForm, generatorPanel } from '../core/ui-item.js';
import { DEFAULT_OPTIONS } from '../core/generator.js';
import { itemMatchesHost, urlScore, pageOrigin } from '../core/match.js';
import { faviconToDataUrl } from '../core/image.js';
import { itemHosts, resolveLogin } from '../core/model.js';
import { setLanguage, t } from '../core/i18n.js';
import { call, copy, unlockError } from '../lib/api.js';
import { buildItemLink } from '../core/links.js';
import { sharedNames, vaultChoiceLabel } from '../core/session-meta.js';
import { vaultDot } from '../core/ui-vault.js';
import { linkedAssetsDialog, moveDialog, movePasskeyDialog } from './item-move.js';
import { openWebUrl } from './open-url.js';
import { errorView, refreshingNote, showLoading } from './loading.js';
import { getSettings } from '../lib/settings.js';

/** Links from an entry: only http(s), anything else is refused with a message (open-url.js). */
const openEntryUrl = (url) => openWebUrl(url, { open: (u) => chrome.tabs.create({ url: u }), notify: (m) => toast(m, 'error') });

/** Entry with the sign-in it uses: a login linked to another (domain or Microsoft login) gets that one's values. */
const usableItem = async (containerId, id) => resolveLogin(await call('item', { containerId, id }), (c, i) => call('item', { containerId: c, id: i }));

const view = document.getElementById('view');
const topActions = document.getElementById('top-actions');

let st = null;
let tab = null;
let host = null;
let items = [];
let listTab = null;
let query = '';
let unlocking = false; // #508: an unlock with the PIN is running (the busy button stays)
// How well each entry of this website fits the page path (urlScore) – loaded for the few matching entries only.
const siteScores = new Map();
const scoreKey = (s) => `${s.containerId}/${s.id}`;

const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
// Names in the selects to save or move: with the host when the name comes from the vault or is taken twice (#479).
const choiceName = (c) => vaultChoiceLabel(c, sharedNames(st.containers));
const writableContainers = () => st.containers.filter((c) => c.access?.write !== false && !c.error && !c.locked).map((c) => ({ id: c.id, name: choiceName(c) }));

function setView(...children) {
  view.className = 'view';
  setChildren(view, ...children);
}

function renderTop() {
  const buttons = [];
  if (st?.open) {
    buttons.push(iconButton('wand', t('Passwortgenerator'), renderGenerator));
    buttons.push(iconButton('refresh', t('Neu laden'), async () => {
      try {
        await call('refresh');
        await reload();
        toast(t('Aktualisiert'));
      } catch (e) {
        toast(e.message, 'error');
      }
    }));
    buttons.push(iconButton('lock', t('Sperren'), async () => {
      await call('lock');
      await reload();
    }));
  }
  buttons.push(iconButton('settings', t('Einstellungen'), () => chrome.runtime.openOptionsPage()));
  topActions.replaceChildren(...buttons);
}

// #495: a load started later (retry, new event) wins; durations of the last load for the smoke test (window.kvLoadTimes).
let loadToken = 0;
window.kvLoadTimes = {};

async function reload({ step } = {}) {
  const my = loadToken;
  const started = performance.now();
  const next = await call('state');
  if (my !== loadToken) return undefined;
  window.kvLoadTimes.state = Math.round(performance.now() - started);
  st = next;
  setLanguage(st.settings.language);
  renderTop();
  if (!st.open && unlocking) return undefined; // #508: an app event mid-unlock keeps the busy button (no fresh, empty form)
  if (!st.open) return st.demo || st.desktop?.connected ? renderLocked() : renderOffline();
  step?.(t('Lade Tresore …'));
  const listStarted = performance.now();
  const [list, ctx] = await Promise.all([
    call('items').catch((e) => {
      toast(e.message, 'error');
      return [];
    }),
    tab?.id ? call('tabContext', { tabId: tab.id }).catch(() => null) : null,
  ]);
  if (my !== loadToken) return undefined;
  window.kvLoadTimes.items = Math.round(performance.now() - listStarted);
  items = list;
  host = ctx?.host || null;
  if (!listTab) listTab = ctx?.matches?.length ? 'site' : 'all';
  return renderList();
}

/**
 * #495: opening the popup. The loading state is there at once (popup.html); the last list the worker holds is shown
 * marked "wird aktualisiert" while the fresh state loads; an error ends in a readable state with "Erneut versuchen".
 */
async function load() {
  const my = ++loadToken;
  const loading = showLoading(view, { onRetry: load });
  try {
    const started = performance.now();
    const cached = await call('peek').catch(() => null);
    if (my !== loadToken) return;
    window.kvLoadTimes = { peek: Math.round(performance.now() - started), cached: !!cached };
    if (cached) showCached(cached);
    await reload({ step: cached ? null : loading.step });
  } catch (e) {
    if (my === loadToken) setView(errorView(e.message, load));
  } finally {
    loading.done();
  }
}

function showCached({ state: known, items: list }) {
  st = known;
  setLanguage(st.settings.language);
  items = list;
  renderTop();
  // The tab is chosen with the fresh state (it knows the page's matches); until then the whole list.
  const chosen = listTab;
  listTab = listTab || 'all';
  renderList();
  listTab = chosen;
  view.prepend(refreshingNote());
}

/** The extension works only through the running app. */
function renderOffline() {
  const missing = st.desktop?.reason === 'AppMissing';
  const start = h('button', { class: 'btn primary', onclick: async () => {
    start.disabled = true;
    start.replaceChildren(h('span', { class: 'spinner' }), t('Keevault startet …'));
    // The popup reloads by itself once the app is reachable (state:changed).
    await call('unlock').catch((e) => toast(e.message, 'error'));
  } }, icon('unlock'), t('Keevault starten'));
  setView(h('div', { class: 'center' }, icon('shield', 40), h('h2', {}, missing ? t('Keevault-App fehlt') : t('Keevault-App läuft nicht')),
    h('p', { class: 'muted' }, missing
      ? t('Die Erweiterung arbeitet nur zusammen mit der Desktop-App. Installiere Keevault auf diesem Computer.')
      : t('Die Erweiterung arbeitet nur zusammen mit der Desktop-App. Starte Keevault – danach geht es hier sofort weiter.')),
    missing ? h('a', { class: 'btn primary', href: 'https://keevault.de/download.html', target: '_blank', rel: 'noopener' }, t('Keevault herunterladen')) : start,
    // #495: after starting or installing the app by hand, without closing the popup.
    h('button', { type: 'button', class: 'btn load-retry', onclick: load }, icon('refresh', 15), t('Erneut versuchen'))));
}

function renderLocked(error) {
  // With an app PIN the vault unlocks right here (silent sign-in in the app, no window).
  const pinSet = !st.demo && !!st.desktop?.pinSet;
  const pin = pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN'), 'aria-label': t('PIN') }) : null;
  // #508: unlocking can take a while (silent sign-in, then the vaults): the button says what is going on, the field is
  // locked meanwhile; a wrong PIN or a timeout comes back as a clear message above the field.
  const here = pinSet || st.demo;
  const busy = (label) => button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
  const button = h('button', { class: 'btn primary', 'aria-live': 'polite', onclick: async () => {
    if (pin && !pin.value) return pin.focus();
    button.disabled = true;
    if (pin) pin.disabled = true;
    if (here) busy(t('Entsperre …'));
    unlocking = true;
    try {
      if (pin) await call('unlockPin', { pin: pin.value });
      else await call('unlock');
      unlocking = false;
      if (here) {
        busy(t('Lade Tresore …'));
        await reload();
      }
    } catch (e) {
      unlocking = false;
      renderLocked(unlockError(e));
    }
    return undefined;
  } }, icon('unlock'), here ? t('Entsperren') : t('In der Desktop-App entsperren'));
  pin?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') button.click();
  });
  setView(h('div', { class: 'center' }, icon('lock', 40), h('h2', {}, t('Tresor gesperrt')),
    h('p', { class: 'muted' }, pinSet ? t('PIN eingeben – Keevault entsperrt im Hintergrund, ohne Fenster.') : t('Entsperre Keevault in der Desktop-App – danach geht es hier sofort weiter.')),
    error ? h('div', { class: 'notice error' }, error) : null,
    pin,
    button));
  setTimeout(() => pin?.focus(), 0);
}

function matchesSite(s) {
  return host && s.type === 'login' && itemMatchesHost(s.hosts, host);
}

function filtered() {
  const q = query.trim().toLowerCase();
  let list = items;
  if (listTab === 'site') list = list.filter(matchesSite);
  if (listTab === 'passkeys') list = list.filter((s) => s.rpIds.length);
  if (q) {
    list = list.filter((s) => [s.title, s.username, s.folder, ...s.hosts, ...s.rpIds, containerName(s.containerId)]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  const score = (s) => (listTab === 'site' ? siteScores.get(scoreKey(s)) || 0 : 0);
  return [...list].sort((a, b) => (score(b) - score(a)) || (b.favorite - a.favorite) || a.title.localeCompare(b.title));
}

function renderList() {
  const siteCount = items.filter(matchesSite).length;
  const search = h('input', { type: 'search', placeholder: t('Suchen …'), value: query, oninput: (e) => {
    query = e.target.value;
    renderRows();
  } });
  const tabs = h('div', { class: 'tabs' }, ...[
    ['site', host ? t('Diese Website ({count})', { count: siteCount }) : t('Diese Website')],
    ['all', t('Alle ({count})', { count: items.length })],
    ['passkeys', t('Passkeys')],
  ].map(([key, label]) => h('button', { class: listTab === key ? 'active' : '', onclick: () => {
    listTab = key;
    renderList();
  } }, label)));
  const listEl = h('ul', { class: 'list' });
  // Right-click on the empty part of the list: "Paste" when an entry is marked.
  listEl.addEventListener('contextmenu', (e) => {
    if (!cutEntry || e.target.closest('li.row-item')) return;
    e.preventDefault();
    closeMenu();
    const menu = h('div', { class: 'context-menu', role: 'menu' }, h('button', { type: 'button', onclick: (ev) => { ev.stopPropagation(); closeMenu(); pasteNow(); } }, icon('move', 15), t('1 Eintrag einfügen')));
    document.body.append(menu);
    menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4))}px`;
    openMenu = menu;
  });

  function renderRows() {
    const rows = filtered();
    if (!rows.length) {
      listEl.replaceChildren(h('li', { class: 'empty' }, icon(listTab === 'passkeys' ? 'key' : 'search', 32),
        listTab === 'site' && !query ? t('Keine Einträge für {host}', { host: host || t('diese Seite') }) : t('Keine Treffer')));
      return;
    }
    listEl.replaceChildren(...rows.map((s) => h('li', { class: 'row-item', onclick: () => renderDetail(s), oncontextmenu: (e) => entryMenu(e, s) },
      avatar(s.title, 'avatar', s.icon),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, s.title, s.rpIds.length ? h('span', { class: 'badge passkey', title: t('Passkey') }, icon('key', 11)) : null),
        // #480: the vault's colour as a dot before the line naming it.
        h('div', { class: 'row-sub' }, vaultDot(st.containers.find((c) => c.id === s.containerId)), [s.username, containerName(s.containerId)].filter(Boolean).join(' · '))),
      h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() },
        matchesSite(s) ? iconButton('fill', t('Ausfüllen'), () => fillItem(s)) : null,
        s.username || s.loginLinked ? iconButton('user', t('Benutzername kopieren'), async () => copy(s.loginLinked ? (await usableItem(s.containerId, s.id)).username : s.username, t('Benutzername'))) : null,
        s.type === 'login' ? iconButton('copy', t('Passwort kopieren'), async () => {
          const item = await usableItem(s.containerId, s.id);
          if (item.password) copy(item.password, t('Passwort'));
          else toast(t('Kein Passwort gespeichert'));
        }) : null))));
  }
  renderRows();
  // Exact URL first (keevault.de/admin before keevault.de): needs the entries' full URLs, the list only has hosts.
  const missing = tab?.url ? items.filter((x) => matchesSite(x) && !siteScores.has(scoreKey(x))) : [];
  if (missing.length) {
    Promise.all(missing.map(async (x) => {
      const item = await call('item', { containerId: x.containerId, id: x.id }).catch(() => null);
      siteScores.set(scoreKey(x), item ? urlScore(item.urls, tab.url) : 0);
    })).then(() => { if (listTab === 'site') renderRows(); });
  }

  const problems = st.containers.filter((c) => c.error);
  const locked = st.containers.filter((c) => c.locked && !c.error);
  const status = h('div', { class: 'status' }, icon('vault', 14),
    t('{containers} Tresore · {items} Einträge', { containers: st.containers.length, items: items.length }),
    problems.length ? h('span', { class: 'badge warn', title: problems.map((c) => `${c.name}: ${c.error.message}`).join('\n') }, t('{count} ohne Zugriff', { count: problems.length })) : null,
    h('span', { class: 'spacer' }));

  setView(
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search),
      h('button', { class: 'btn primary', title: t('Neuer Eintrag'), onclick: () => renderEdit(null) }, icon('plus'), t('Neu'))),
    tabs,
    locked.length ? h('div', { class: 'notice info locked-row' }, icon('lock', 14),
      h('span', { class: 'spacer' }, t('Gesperrt: {names}', { names: locked.map((c) => c.name).join(', ') })),
      h('button', { class: 'btn small', onclick: () => call('desktopFocus').catch((e) => toast(e.message, 'error')) }, t('Entsperren'))) : null,
    st.containers.length ? null : h('div', { class: 'notice info' }, t('Noch kein Tresor. Lege in der Desktop-App einen Tresor an.')),
    h('div', { class: 'list-wrap' }, listEl),
    status,
  );
  if (!query) search.focus();
}

async function fillItem(s, force = false, origin = '') {
  try {
    const r = await call('fill', { tabId: tab.id, containerId: s.containerId, id: s.id, force, origin });
    if (r.totpCopied) toast(t('Einmalcode in die Zwischenablage kopiert'));
    setTimeout(() => window.close(), r.totpCopied ? 900 : 0);
  } catch (e) {
    if (e.name === 'MismatchError' && !force) {
      if (await confirmDialog(t('Andere Website'), t('{message}. Trotzdem auf {host} ausfüllen?', { message: e.message, host: pageOrigin(tab?.url, host || t('dieser Seite')) }), { confirmLabel: t('Ausfüllen') })) fillItem(s, true, pageOrigin(tab?.url));
      return;
    }
    toast(e.message, 'error');
  }
}

/** Right-click on an entry: open, edit, fill, copy, delete – instead of the browser's own menu. */
let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// #467: Ctrl+X marks an entry for moving, Ctrl+V (or "Paste" in the list's menu) opens the move dialog for it (the popup
// has no vault tree to paste into, so the target is chosen there, with the same plan for linked assets). Nothing goes
// to the system clipboard. Typing in a field keeps cutting and pasting text.
let cutEntry = null;
const typingNow = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || !!document.activeElement?.isContentEditable || !!window.getSelection()?.toString();
function cutNow(s) {
  if (!st?.canMove || !writableContainers().some((c) => c.id === s.containerId)) return toast(t('Zuerst einen Eintrag auswählen, den du ändern darfst'), 'error');
  cutEntry = { containerId: s.containerId, id: s.id, title: s.title };
  return toast(t('„{title}“ zum Verschieben vorgemerkt', { title: s.title }));
}
function pasteNow() {
  const marked = cutEntry;
  if (!marked) return toast(t('Nichts zum Einfügen vorgemerkt'), 'error');
  cutEntry = null;
  return moveDialog(marked, moveCtx());
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cutEntry && !document.querySelector('dialog[open]')) cutEntry = null;
  if (!e.ctrlKey || e.shiftKey || e.altKey || (e.key.toLowerCase() !== 'x' && e.key.toLowerCase() !== 'v') || typingNow() || document.querySelector('dialog[open]') || !st) return;
  e.preventDefault();
  if (e.key.toLowerCase() === 'v') pasteNow();
  else if (selectedSummary) cutNow(selectedSummary);
  else toast(t('Zuerst einen Eintrag auswählen, den du ändern darfst'), 'error');
});
/** Web link to the entry for colleagues (only Key Vault entries; the vault URL falls back to the container id, its host). */
function itemLinkFor(s) {
  const c = st?.containers.find((x) => x.id === s.containerId);
  return c ? buildItemLink({ vaultUrl: c.vaultUrl || `https://${c.id}/`, name: c.name }, s.id) : null;
}

function entryMenu(e, s) {
  e.preventDefault();
  closeMenu();
  const entry = (iconName, label, fn, cls = '') => h('button', { type: 'button', class: cls, onclick: (ev) => { ev.stopPropagation(); closeMenu(); fn(); } }, icon(iconName, 15), label);
  const load = () => call('item', { containerId: s.containerId, id: s.id, fresh: true });
  const menu = h('div', { class: 'context-menu', role: 'menu' },
    entry('eye', t('Öffnen'), () => renderDetail(s)),
    entry('edit', t('Bearbeiten'), async () => {
      try {
        renderEdit(await load());
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
    matchesSite(s) ? entry('fill', t('Ausfüllen'), () => fillItem(s)) : null,
    s.username || s.loginLinked ? entry('user', t('Benutzername kopieren'), async () => copy(s.loginLinked ? (await usableItem(s.containerId, s.id)).username : s.username, t('Benutzername'))) : null,
    s.type === 'login' ? entry('copy', t('Passwort kopieren'), async () => {
      const item = await usableItem(s.containerId, s.id).catch(() => null);
      if (item?.password) copy(item.password, t('Passwort'));
      else toast(t('Kein Passwort gespeichert'));
    }) : null,
    st.canMove ? entry('move', t('Ausschneiden'), () => cutNow(s)) : null,
    itemLinkFor(s) ? entry('link', t('Link kopieren'), () => {
      copy(itemLinkFor(s), t('Link zum Eintrag'));
    }) : null,
    h('hr'),
    entry('trash', t('Löschen'), async () => {
      if (!(await confirmDialog(t('Eintrag löschen'), t('„{title}“ in den Papierkorb des Tresors verschieben? Wiederherstellen ist in der Desktop-App möglich.', { title: s.title }), { confirmLabel: t('Löschen'), danger: true }))) return;
      try {
        await call('delete', { containerId: s.containerId, id: s.id });
        toast(t('Gelöscht'));
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    }, 'danger'));
  document.body.append(menu);
  // Inside the popup: open where clicked, shifted so it stays fully visible.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

let selectedSummary = null;
async function renderDetail(s, fresh = false) {
  selectedSummary = s;
  setView(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
  let item;
  try {
    item = await call('item', { containerId: s.containerId, id: s.id, fresh });
  } catch (e) {
    toast(e.message, 'error');
    return renderList();
  }
  const canFill = tab && item.type === 'login' && host && itemMatchesHost(itemHosts(item), host);
  // Linked login: shown and copied with the linked entry's values; edited as stored.
  const shown = await resolveLogin(item, (c, i) => call('item', { containerId: c, id: i }));
  // Assets that use this login (#464): the button only when there are some, like in the app.
  const hasAssets = st.canAssets && item.type === 'login' && (await call('linkedEntries', { containerId: item.containerId, id: item.id }).then((e) => e.length > 0, () => false));
  const mayWrite = writableContainers().some((c) => c.id === item.containerId);
  const detail = itemDetail(shown, {
    copy,
    ...hoverCtx(item, hasAssets, mayWrite),
    openUrl: openEntryUrl,
    // Attachments and certificates: saved through the browser's download (base64 → file).
    saveFile: (name, data) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    containerName,
    actions: [
      canFill ? { icon: 'fill', label: t('Ausfüllen'), primary: true, onClick: () => fillItem(s) } : null,
      { icon: 'edit', label: t('Bearbeiten'), onClick: () => renderEdit(item) },
      st.canMove && mayWrite ? { icon: 'move', label: t('Verschieben'), onClick: () => moveDialog(item, moveCtx()) } : null,
      { icon: 'trash', label: t('Löschen'), danger: true, onClick: async () => {
        if (!(await confirmDialog(t('Eintrag löschen'), t('„{title}“ in den Papierkorb des Tresors verschieben? Wiederherstellen ist in der Desktop-App möglich.', { title: item.title }), { confirmLabel: t('Löschen'), danger: true }))) return;
        try {
          await call('delete', { containerId: item.containerId, id: item.id });
          toast(t('Gelöscht'));
          await reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      } },
    ].filter(Boolean),
  });
  setView(backButton(), detail);
  view.classList.add('detail');
  return undefined;
}

/**
 * What the entry view shares with the app (#464): field cards with click, arrow menu and frame, the version history.
 * Also with the app's capabilities: linked assets, moving a passkey (moving the entry is an action of the detail view).
 * Not here: typing into a window – the browser has no counterpart.
 * Copies go through the app (kept out of Windows' clipboard history); only the developer demo uses the browser's clipboard.
 */
function hoverCtx(item, hasAssets, mayWrite) {
  return {
    showLinkedAssets: hasAssets ? (it) => linkedAssetsDialog(it, moveCtx()) : null,
    onMovePasskey: st.canMovePasskey && mayWrite ? (passkey) => movePasskeyDialog(item, passkey, moveCtx()) : null,
    hoverActions: true,
    fieldMenu,
    secureCopy: !st.demo,
    openLabel: t('Öffnen'),
    history: st.canHistory ? { load: () => call('history', { containerId: item.containerId, id: item.id }), open: (v) => showVersion(item, v) } : null,
  };
}

/** What the dialogs of item-move.js need from the popup. */
const moveCtx = () => ({
  writableContainers, containerName, items: () => items, reload,
  open: (summary) => renderDetail(summary),
});

/** The arrow menu of a field row: the same look as the entry's right-click menu, below the arrow. */
function fieldMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'context-menu', role: 'menu' }, ...items.map((m) => (m === '-' ? h('hr') : h('button', {
    type: 'button', role: 'menuitem', class: m.danger ? 'danger' : '',
    onclick: (ev) => { ev.stopPropagation(); closeMenu(); m.onClick(); },
  }, icon(m.icon, 15), m.label))));
  document.body.append(menu);
  const a = anchor.getBoundingClientRect();
  const r = menu.getBoundingClientRect();
  const below = a.bottom + 6 + r.height <= window.innerHeight - 4;
  menu.style.left = `${Math.max(4, Math.min(a.right - r.width, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, below ? a.bottom + 6 : a.top - r.height - 6)}px`;
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

/** One older version, read-only (#450, #464): shown like an entry, passwords stay hidden until shown. */
async function showVersion(item, v) {
  const title = t('Version vom {date}', { date: formatDateTime(v.updated) });
  let old;
  try {
    if (v.enabled === false) throw new Error('disabled');
    old = await call('version', { containerId: item.containerId, id: item.id, version: v.version });
  } catch {
    modal(title, h('p', { class: 'muted' }, t('Diese Version ist nicht mehr lesbar: Ein Schlüsselwechsel hat ältere Versionen gesperrt. Sie bleibt nur für das Protokoll erhalten.')), [{ label: t('Schließen') }]);
    return;
  }
  modal(title, itemDetail(old, { copy, containerName, openUrl: openEntryUrl }), [{ label: t('Schließen') }]);
}

function backButton(onClick = () => renderList()) {
  return h('div', { class: 'back' }, iconButton('back', t('Zurück'), onClick), h('span', { class: 'muted' }, t('Zurück')));
}

/**
 * Reads a QR code from the visible part of the current tab (e.g. the two-factor setup code of a website):
 * screenshot of the tab → jsQR, first at full size, then at half size for very large codes. Returns the text or ''.
 * The image never leaves the popup.
 */
async function scanVisibleTab() {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(t('Bildschirmfoto fehlgeschlagen')));
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  for (const scale of [1, 0.5]) {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    const found = globalThis.jsQR?.(data, width, height, { inversionAttempts: 'attemptBoth' });
    if (found?.data) return found.data;
  }
  return '';
}

async function renderEdit(item) {
  const isNew = !item;
  const writable = writableContainers();
  // New entry from a website: its favicon becomes the icon (from the site itself, no icon service).
  const start = item || { type: 'login', urls: tab?.url && /^https?:/.test(tab.url) ? [new URL(tab.url).origin] : [], title: host || '',
    icon: /^https?:/.test(tab?.url || '') ? await faviconToDataUrl(tab.favIconUrl) : '' };
  // An entry without an icon, opened on one of its sites: its favicon can be taken over (#314).
  const onItsSite = item && !item.icon && /^https?:/.test(tab?.url || '') && itemMatchesHost(itemHosts(item), new URL(tab.url).hostname);
  const form = itemForm(start, {
    isNew,
    siteIcon: onItsSite ? () => faviconToDataUrl(tab.favIconUrl) : null,
    scanQr: scanVisibleTab,
    // Moving a passkey to another entry (#464): only for a saved entry in a vault with write access, and only with an app that can do it.
    onMovePasskey: item && st.canMovePasskey && writable.some((c) => c.id === item.containerId) ? (passkey) => movePasskeyDialog(item, passkey, moveCtx()) : null,
    containers: isNew ? writable : st.containers.map((c) => ({ id: c.id, name: choiceName(c) })),
    containerId: item?.containerId || (writable.some((c) => c.id === st.settings.defaultContainer) ? st.settings.defaultContainer : writable[0]?.id),
    onCancel: () => (item ? renderDetail(item) : renderList()),
    onSave: async (next, containerId) => {
      const saved = await call('save', { containerId, item: next, expectedVersion: item?.version });
      toast(t('Gespeichert'));
      items = await call('items');
      renderDetail(saved);
    },
  });
  setView(backButton(() => (item ? renderDetail(item) : renderList())), h('h2', {}, isNew ? t('Neuer Eintrag') : t('Bearbeiten')), form);
}

function renderGenerator() {
  let current = '';
  const panel = generatorPanel({ ...DEFAULT_OPTIONS }, (pw) => {
    current = pw;
  });
  panel.regenerate();
  setView(backButton(), h('h2', {}, t('Passwortgenerator')), panel,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => copy(current, t('Passwort')) }, icon('copy'), t('Kopieren'))));
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'state:changed') reload();
});

(async () => {
  setLanguage((await getSettings().catch(() => ({}))).language || 'auto');
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await load();
    // Just saved a passkey on a website: continue with that entry in edit mode (title, folder, logo, …).
    const { editAfter } = await chrome.storage.session.get('editAfter').catch(() => ({}));
    if (editAfter && Date.now() - editAfter.at < 60_000 && st?.open) {
      await chrome.storage.session.remove('editAfter');
      const item = await call('item', { containerId: editAfter.containerId, id: editAfter.id, fresh: true }).catch(() => null);
      if (item) renderEdit({ ...item, containerId: editAfter.containerId });
    }
  } catch (e) {
    setView(h('div', { class: 'notice error' }, e.message));
  }
})();
