import { h, icon, iconButton, setChildren, toast, avatar, confirmDialog } from '../core/dom.js';
import { itemDetail, itemForm, generatorPanel } from '../core/ui-item.js';
import { DEFAULT_OPTIONS } from '../core/generator.js';
import { itemMatchesHost, urlScore } from '../core/match.js';
import { faviconToDataUrl } from '../core/image.js';
import { itemHosts } from '../core/model.js';
import { setLanguage, t } from '../core/i18n.js';
import { call, copy } from '../lib/api.js';

const view = document.getElementById('view');
const topActions = document.getElementById('top-actions');

let st = null;
let tab = null;
let host = null;
let items = [];
let listTab = null;
let query = '';
// How well each entry of this website fits the page path (urlScore) – loaded for the few matching entries only.
const siteScores = new Map();
const scoreKey = (s) => `${s.containerId}/${s.id}`;

const containerName = (id) => st?.containers.find((c) => c.id === id)?.name || '';
const writableContainers = () => st.containers.filter((c) => c.access?.write !== false && !c.error && !c.locked).map((c) => ({ id: c.id, name: c.name }));

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

async function reload() {
  st = await call('state');
  setLanguage(st.settings.language);
  renderTop();
  if (!st.open) return st.demo || st.desktop?.connected ? renderLocked() : renderOffline();
  const [list, ctx] = await Promise.all([
    call('items').catch((e) => {
      toast(e.message, 'error');
      return [];
    }),
    tab?.id ? call('tabContext', { tabId: tab.id }).catch(() => null) : null,
  ]);
  items = list;
  host = ctx?.host || null;
  if (!listTab) listTab = ctx?.matches?.length ? 'site' : 'all';
  return renderList();
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
    missing ? h('a', { class: 'btn primary', href: 'https://keevault.de/download.html', target: '_blank', rel: 'noopener' }, t('Keevault herunterladen')) : start));
}

function renderLocked(error) {
  // With an app PIN the vault unlocks right here (silent sign-in in the app, no window).
  const pinSet = !st.demo && !!st.desktop?.pinSet;
  const pin = pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN'), 'aria-label': t('PIN') }) : null;
  const button = h('button', { class: 'btn primary', onclick: async () => {
    button.disabled = true;
    try {
      if (pin) await call('unlockPin', { pin: pin.value });
      else await call('unlock');
      if (st.demo) await reload();
    } catch (e) {
      renderLocked(e.message);
    }
  } }, icon('unlock'), pinSet || st.demo ? t('Entsperren') : t('In der Desktop-App entsperren'));
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
        h('div', { class: 'row-sub' }, [s.username, containerName(s.containerId)].filter(Boolean).join(' · '))),
      h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() },
        matchesSite(s) ? iconButton('fill', t('Ausfüllen'), () => fillItem(s)) : null,
        s.username ? iconButton('user', t('Benutzername kopieren'), () => copy(s.username, t('Benutzername'))) : null,
        s.type === 'login' ? iconButton('copy', t('Passwort kopieren'), async () => {
          const item = await call('item', { containerId: s.containerId, id: s.id });
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

async function fillItem(s, force = false) {
  try {
    const r = await call('fill', { tabId: tab.id, containerId: s.containerId, id: s.id, force });
    if (r.totpCopied) toast(t('Einmalcode in die Zwischenablage kopiert'));
    setTimeout(() => window.close(), r.totpCopied ? 900 : 0);
  } catch (e) {
    if (e.name === 'MismatchError' && !force) {
      if (await confirmDialog(t('Andere Website'), t('{message}. Trotzdem auf {host} ausfüllen?', { message: e.message, host: host || t('dieser Seite') }), { confirmLabel: t('Ausfüllen') })) fillItem(s, true);
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
    s.username ? entry('user', t('Benutzername kopieren'), () => copy(s.username, t('Benutzername'))) : null,
    s.type === 'login' ? entry('copy', t('Passwort kopieren'), async () => {
      const item = await load().catch(() => null);
      if (item?.password) copy(item.password, t('Passwort'));
      else toast(t('Kein Passwort gespeichert'));
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

async function renderDetail(s, fresh = false) {
  setView(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
  let item;
  try {
    item = await call('item', { containerId: s.containerId, id: s.id, fresh });
  } catch (e) {
    toast(e.message, 'error');
    return renderList();
  }
  const canFill = tab && item.type === 'login' && host && itemMatchesHost(itemHosts(item), host);
  const detail = itemDetail(item, {
    copy,
    openUrl: (url) => chrome.tabs.create({ url }),
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
  const form = itemForm(start, {
    isNew,
    scanQr: scanVisibleTab,
    containers: isNew ? writable : st.containers.map((c) => ({ id: c.id, name: c.name })),
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
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await reload();
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
