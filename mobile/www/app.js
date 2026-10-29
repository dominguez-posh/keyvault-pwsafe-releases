// Keevault mobile (Capacitor shell around the shared core): sign in with the device code, PIN lock, vault lists
// through the index secrets, entry detail and editor from core/ui-item.js. No server of our own in between –
// the phone talks to Entra ID and the Key Vaults directly, like the desktop app.

import { Clipboard } from '@capacitor/clipboard';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import { VaultSession, MemoryStore } from '../../extension/core/session.js';
import { h, icon, iconButton, toast, modal, confirmDialog, setChildren, avatar } from '../../extension/core/dom.js';
import { itemDetail, itemForm } from '../../extension/core/ui-item.js';
import { t, setLanguage } from '../../extension/core/i18n.js';
import { expiryState } from '../../extension/core/health.js';
import { Auth, ARM_SCOPE } from './auth.js';

const VERSION = '0.1.0';
const LOCK_AFTER_MS = 5 * 60_000;
setLanguage('auto', navigator.language);

const root = document.getElementById('app');
const auth = new Auth();
let session = null;
let containers = [];
let items = [];
let folders = new Map(); // containerId → folders (lazy)
const ui = { screen: 'loading', containerId: null, query: '', sheet: null };
let hiddenAt = 0;
let pin = null; // only while setting up / changing; never stored

const call = async (fn, onError = (e) => toast(e.message, 'error')) => {
  try {
    return await fn();
  } catch (e) {
    if (e.name === 'LockedError') return lock();
    onError(e);
    return undefined;
  }
};
const copy = async (value, label = t('Wert')) => {
  await Clipboard.write({ string: String(value) });
  toast(t('{label} kopiert', { label }));
};
const openUrl = (url) => Browser.open({ url });
const containerName = (id) => containers.find((c) => c.id === id)?.name || id;
const writable = (c) => c && c.access?.write !== false && !c.error && !c.locked;

function newSession() {
  session = new VaultSession({
    getToken: (scope, opts) => auth.getToken(scope, opts),
    store: new MemoryStore(),
    fetch: (url, init) => fetch(url, init),
    actor: () => auth.account?.username || '',
    multiTenant: true,
  });
}

// ---------------------------------------------------------------- screens

function render() {
  // "code" (device code) is drawn by startSignIn itself.
  const screens = { loading, signin, code: () => {}, pin: pinScreen, setpin: setPinScreen, main };
  screens[ui.screen]();
}

function loading() {
  setChildren(root, h('div', { class: 'screen' }, h('span', { class: 'spinner' })));
}

function signin(error) {
  setChildren(root, h('div', { class: 'screen' },
    h('img', { src: 'logo.png', alt: '', width: 72, height: 72 }),
    h('h2', {}, 'Keevault'),
    h('p', { class: 'muted' }, t('Dein Azure Key Vault als Passwortmanager – auf dem Smartphone. Melde dich mit deinem Arbeitskonto an.')),
    error ? h('div', { class: 'notice error' }, error) : null,
    h('button', { class: 'btn primary', onclick: startSignIn }, icon('unlock'), t('Mit Microsoft anmelden')),
    h('p', { class: 'muted small' }, t('Die Anmeldung läuft über einen Gerätecode: Du bekommst einen Code, öffnest die Microsoft-Anmeldeseite und gibst ihn dort ein.'))));
}

async function startSignIn() {
  let info;
  try {
    info = await auth.startDeviceCode();
  } catch (e) {
    return signin(e.message);
  }
  let cancelled = false;
  ui.screen = 'code';
  setChildren(root, h('div', { class: 'screen' },
    h('h2', {}, t('Code eingeben')),
    h('p', { class: 'muted' }, t('Öffne die Microsoft-Anmeldeseite und gib diesen Code ein:')),
    h('div', { class: 'code' }, info.userCode),
    h('div', { class: 'inline' },
      h('button', { class: 'btn', onclick: () => copy(info.userCode, t('Code')) }, icon('copy'), t('Code kopieren')),
      h('button', { class: 'btn primary', onclick: () => Browser.open({ url: info.verificationUri }) }, icon('link'), t('Anmeldeseite öffnen'))),
    h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' ', t('Warte auf die Anmeldung …')),
    h('button', { class: 'linklike', onclick: () => { cancelled = true; ui.screen = 'signin'; render(); } }, t('Abbrechen'))));
  try {
    await auth.waitForDeviceCode({ cancelled: () => cancelled });
  } catch (e) {
    if (!cancelled) {
      ui.screen = 'signin';
      signin(e.message);
    }
    return;
  }
  ui.screen = 'setpin';
  render();
}

function setPinScreen() {
  const input = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN') });
  const again = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN wiederholen') });
  const go = async () => {
    if (input.value.length < 4) return toast(t('Die PIN braucht mindestens {n} Zeichen', { n: 4 }), 'error');
    if (input.value !== again.value) return toast(t('Die PINs stimmen nicht überein'), 'error');
    await call(async () => {
      await auth.setPin(input.value);
      pin = null;
      await openMain();
    });
    return undefined;
  };
  again.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  setChildren(root, h('div', { class: 'screen' },
    icon('key', 40),
    h('h2', {}, t('PIN festlegen')),
    h('p', { class: 'muted' }, t('Die PIN schützt die gespeicherte Anmeldung auf diesem Gerät (verschlüsselt) und wird beim Öffnen der App abgefragt. Passwörter werden nie auf dem Gerät gespeichert.')),
    input, again,
    h('button', { class: 'btn primary', onclick: go }, t('Weiter')),
    h('button', { class: 'linklike', onclick: () => openMain() }, t('Ohne PIN (bei jedem Start neu anmelden)'))));
  setTimeout(() => input.focus(), 50);
}

function pinScreen(error) {
  const input = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN') });
  const go = async () => {
    try {
      await auth.restore(input.value);
    } catch (e) {
      return pinScreen(e.message);
    }
    return openMain();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  setChildren(root, h('div', { class: 'screen' },
    icon('lock', 40),
    h('h2', {}, t('Tresor gesperrt')),
    error ? h('div', { class: 'notice error' }, error) : null,
    input,
    h('button', { class: 'btn primary', onclick: go }, icon('unlock'), t('Entsperren')),
    h('button', { class: 'linklike', onclick: async () => {
      if (!(await confirmDialog(t('Anderes Konto'), t('Gespeicherte Anmeldung und PIN von diesem Gerät entfernen?'), { confirmLabel: t('Entfernen'), danger: true }))) return;
      await auth.signOut();
      ui.screen = 'signin';
      render();
    } }, t('Anderes Konto'))));
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------- main

async function openMain() {
  ui.screen = 'main';
  newSession();
  loading();
  await call(async () => {
    await session.refreshContainers({ configured: [], hidden: [], discover: true, tenants: false, access: false });
    await session.refreshIndexFast();
    await reload();
    // Other tenants, rights and the full reconcile follow in the background.
    (async () => {
      await session.refreshContainers({ configured: [], hidden: [], discover: true });
      await session.refreshAccess().catch(() => {});
      await session.refreshIndexFast();
      await reload();
      await session.refreshIndex();
      await reload();
    })().catch(() => {});
  }, (e) => {
    setChildren(root, h('div', { class: 'screen' }, h('div', { class: 'notice error' }, e.message), h('button', { class: 'btn', onclick: openMain }, t('Erneut versuchen'))));
  });
}

async function reload() {
  if (ui.screen !== 'main') return;
  containers = (await session.containers()).map((c) => ({ ...c, locked: !!c.locked }));
  items = await session.summaries({ maxAgeMs: Infinity });
  main();
}

function visible() {
  let list = ui.containerId ? items.filter((i) => i.containerId === ui.containerId) : items;
  const q = ui.query.trim().toLowerCase();
  if (q) list = list.filter((i) => [i.title, i.username, i.folder, ...i.hosts].some((x) => (x || '').toLowerCase().includes(q)));
  return list.sort((a, b) => a.title.localeCompare(b.title));
}

function main() {
  if (ui.screen !== 'main') return;
  const search = h('input', { type: 'search', placeholder: t('Suchen (Titel, Benutzer, Website, Ordner)'), value: ui.query, oninput: (e) => {
    ui.query = e.target.value;
    renderRows();
  } });
  const chips = h('div', { class: 'chips' },
    h('button', { class: ui.containerId ? '' : 'active', onclick: () => { ui.containerId = null; main(); } }, icon('shield', 14), t('Alle Einträge')),
    ...containers.map((c) => h('button', { class: ui.containerId === c.id ? 'active' : '', onclick: () => { ui.containerId = c.id; main(); } },
      c.error ? icon('x', 14) : c.locked ? icon('lock', 14) : icon('vault', 14), c.name)));
  const rowsEl = h('ul', { class: 'list' });
  let chunkObserver = null;
  const row = (i) => h('li', { class: 'row-item', onclick: () => openItem(i) },
    avatar(i.title, 'avatar', i.icon || ''),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, i.title, i.favorite ? icon('star', 12) : null, i.hasTotp ? h('span', { class: 'badge' }, 'TOTP') : null,
        expiryState(i.expires) === 'expired' ? h('span', { class: 'badge danger' }, t('abgelaufen')) : expiryState(i.expires) === 'soon' ? h('span', { class: 'badge warn' }, t('läuft ab')) : null),
      h('div', { class: 'row-sub' }, [i.username || i.hosts[0], i.folder, ui.containerId ? null : containerName(i.containerId)].filter(Boolean).join(' · '))));
  function renderRows() {
    chunkObserver?.disconnect();
    const list = visible();
    if (!list.length) {
      setChildren(rowsEl, h('li', { class: 'empty' }, icon('search', 32), ui.query ? t('Keine Treffer') : t('Keine Einträge')));
      return;
    }
    const CHUNK = 80;
    let shown = Math.min(CHUNK, list.length);
    setChildren(rowsEl, ...list.slice(0, shown).map(row));
    if (shown >= list.length) return;
    const more = h('li', { class: 'row-more' }, h('span', { class: 'spinner' }));
    rowsEl.append(more);
    chunkObserver = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      const next = list.slice(shown, shown + CHUNK);
      shown += next.length;
      more.before(...next.map(row));
      if (shown >= list.length) {
        more.remove();
        chunkObserver.disconnect();
      }
    }, { rootMargin: '500px' });
    chunkObserver.observe(more);
  }
  renderRows();
  const current = containers.find((c) => c.id === ui.containerId);
  setChildren(root,
    h('div', { class: 'topbar' },
      h('img', { src: 'logo.png', alt: '', width: 28, height: 28 }),
      h('h1', {}, current ? current.name : 'Keevault'),
      iconButton('refresh', t('Aktualisieren'), () => call(async () => {
        await session.refreshIndex(ui.containerId ? [ui.containerId] : undefined);
        await reload();
        toast(t('Aktualisiert'));
      })),
      iconButton('settings', t('Einstellungen'), settingsSheet)),
    chips,
    h('div', { class: 'searchbar' }, search),
    current?.error ? h('div', { class: 'notice error', style: { margin: '10px 14px' } }, current.error.message) : null,
    current?.locked ? h('div', { class: 'notice info', style: { margin: '10px 14px' } }, t('Dieser Tresor ist zusätzlich geschützt – entsperre ihn in der Desktop-App (Passkey/Masterpasswort auf dem Smartphone folgt).')) : null,
    rowsEl,
    containers.some(writable) ? h('button', { class: 'fab', title: t('Neuer Eintrag'), onclick: () => editor(null) }, icon('plus')) : null);
}

// ---------------------------------------------------------------- sheets (detail, editor, settings)

function sheet(title, body, { onClose } = {}) {
  ui.sheet?.remove();
  const el = h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, iconButton('x', t('Schließen'), () => close()), h('h2', {}, title)),
    h('div', { class: 'sheet-body' }, body));
  const close = () => {
    el.remove();
    if (ui.sheet === el) ui.sheet = null;
    onClose?.();
  };
  ui.sheet = el;
  el.close = close;
  document.body.append(el);
  return { el, close };
}

async function openItem(summary) {
  const body = h('div', {}, h('p', {}, h('span', { class: 'spinner' })));
  const { close } = sheet(summary.title, body);
  await call(async () => {
    const item = await session.getItem(summary.containerId, summary.id, { fresh: true });
    const c = containers.find((x) => x.id === item.containerId);
    setChildren(body, itemDetail(item, {
      copy, openUrl, containerName,
      actions: [
        writable(c) ? { icon: 'edit', label: t('Bearbeiten'), primary: true, onClick: () => { close(); editor(item); } } : null,
        writable(c) ? { icon: 'trash', label: t('Löschen'), danger: true, onClick: async () => {
          if (!(await confirmDialog(t('Eintrag löschen'), t('„{title}“ in den Papierkorb verschieben? Wiederherstellen ist bis zum Ablauf der Aufbewahrungsfrist möglich.', { title: item.title }), { confirmLabel: t('Löschen'), danger: true }))) return;
          await call(async () => {
            await session.deleteItem(item.containerId, item.id);
            close();
            toast(t('In den Papierkorb verschoben'));
            await reload();
          });
        } } : null,
      ].filter(Boolean),
    }));
  }, (e) => setChildren(body, h('div', { class: 'notice error' }, e.message)));
}

async function editor(item) {
  const targets = containers.filter(writable).map((c) => ({ id: c.id, name: c.name }));
  if (!targets.length) return toast(t('Kein Tresor mit Schreibrechten'), 'error');
  const target = item?.containerId || (targets.some((c) => c.id === ui.containerId) ? ui.containerId : targets[0].id);
  if (!folders.has(target)) folders.set(target, await session.folders(target).catch(() => []));
  const { close } = sheet(item ? t('Eintrag bearbeiten') : t('Neuer Eintrag'), itemForm(item || { type: 'login' }, {
    containers: targets,
    defaultContainer: target,
    folders: [...new Set([...(folders.get(target) || []), ...items.filter((i) => i.containerId === target).map((i) => i.folder).filter(Boolean)])].sort(),
    folderFree: true,
    typeFixed: false,
    onCancel: () => close(),
    onSave: async (next, containerId) => {
      await session.saveItem(containerId, { ...(item || {}), ...next, containerId }, item ? { expectedVersion: item.version } : {});
      close();
      toast(t('Gespeichert'));
      await reload();
    },
  }));
  return undefined;
}

function settingsSheet() {
  const list = h('ul', { class: 'settings-list' },
    h('li', {}, icon('user'), h('span', {}, h('b', {}, auth.account?.name || ''), h('div', { class: 'muted small' }, auth.account?.username || ''))),
    h('li', { onclick: async () => {
      const current = h('input', { type: 'password', inputmode: 'numeric', placeholder: t('Aktuelle PIN') });
      const next = h('input', { type: 'password', inputmode: 'numeric', placeholder: t('Neue PIN') });
      modal(t('PIN ändern'), h('div', {}, h('div', { class: 'field' }, current), h('div', { class: 'field' }, next)), [
        { label: t('Abbrechen') },
        { label: t('Speichern'), primary: true, onClick: async () => {
          try {
            if (await Auth.hasPin()) await auth.restore(current.value);
            await auth.setPin(next.value);
            toast(t('PIN gespeichert'));
          } catch (e) {
            toast(e.message, 'error');
            return false;
          }
          return true;
        } },
      ]);
    } }, icon('key'), h('span', {}, t('PIN festlegen oder ändern'))),
    h('li', { onclick: () => { lock(); ui.sheet?.close(); } }, icon('lock'), h('span', {}, t('Sperren'))),
    h('li', { onclick: async () => {
      if (!(await confirmDialog(t('Abmelden'), t('Gespeicherte Anmeldung und PIN von diesem Gerät entfernen?'), { confirmLabel: t('Abmelden'), danger: true }))) return;
      await auth.signOut();
      session = null;
      ui.sheet?.close();
      ui.screen = 'signin';
      render();
    } }, icon('x'), h('span', {}, t('Abmelden'))),
    h('li', {}, icon('info'), h('span', {}, `Keevault Mobile ${VERSION} · ${t('Vorschau')}`, h('div', { class: 'muted small' }, t('Passwörter bleiben nur im Arbeitsspeicher; die Anmeldung liegt PIN-verschlüsselt auf dem Gerät.')))));
  sheet(t('Einstellungen'), list);
}

function lock() {
  if (ui.screen !== 'main') return;
  ui.sheet?.close();
  auth.lock();
  session = null;
  items = [];
  containers = [];
  ui.screen = 'pin';
  render();
}

// ---------------------------------------------------------------- app lifecycle

App.addListener('appStateChange', ({ isActive }) => {
  if (!isActive) {
    hiddenAt = Date.now();
    return;
  }
  if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS && ui.screen === 'main') lock();
});
App.addListener('backButton', () => {
  if (ui.sheet) ui.sheet.close();
  else if (ui.containerId) {
    ui.containerId = null;
    main();
  } else App.minimizeApp();
});

(async () => {
  if (await Auth.hasSaved()) {
    ui.screen = 'pin';
  } else {
    ui.screen = 'signin';
  }
  render();
})();
