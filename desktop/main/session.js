// The vault session: who is signed in, language, creating the session, lock, refresh of the vault list and
// filling it in the background, offline mirror, change notifications to the window.

import { app, powerMonitor, safeStorage } from 'electron';
import { LockedError } from '../auth.js';
import { VaultSession, MemoryStore } from '../../extension/core/session.js';
import { vaultHost } from '../../extension/core/keyvault.js';
import { OfflineMirror } from '../offline.js';
import { setLanguage, t } from '../../extension/core/i18n.js';
import { demo, smokeTest } from './boot.js';
import { auth, bridge, config, files, mcp, opened, setOpened, setVault, setWindowLocked, vault, win, windowLocked, windows } from './state.js';
import { cancelQuestions } from './agents.js';
import { lastBackup, pendingRestore, setLastBackup, setPendingRestore } from './backup.js';
import { busySince, diag, timedFetch, timedToken } from './diag.js';
import { scheduleSettingsSync } from './settings-sync.js';
import { applyShortcuts, selectedKey, setSelectedKey } from './typing.js';
import { viewerId } from './private.js';
import { clearCopyRules } from './vault-rules.js';
import { pinGuard } from './guards.js';

export class DemoAuth {
  account = null;
  async unlock() {
    this.account = demo.account;
    return this.account;
  }
  async switchTenant() {
    return this.account;
  }
  async getToken() {
    if (!this.account) throw new LockedError();
    return 'demo-token';
  }
  lock() {
    this.account = null;
  }
  async signOut() {
    this.account = null;
  }
}

// #507: while the window is locked alone, nothing about the vaults reaches it (loading, progress with counts or names).
const QUIET_WHILE_WINDOW_LOCKED = new Set(['busy', 'progress', 'mcpTrusted']);
export const send = (data) => (windowLocked && QUIET_WHILE_WINDOW_LOCKED.has(data?.type) ? undefined : win?.webContents.send('event', data));
export const signedIn = () => !!auth.account;
export const actor = () => auth.account?.username || process.env.USERNAME || process.env.USER || '';

export function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(t('Bitte eine gültige E-Mail-Adresse eingeben'));
  return e;
}

/** --lang=… fixes the language for screenshots; smoke runs without it are German on every machine (the checks click
 * German labels; GitHub's runners are English). The window gets it too (state().settings.language). */
export const forcedLanguage = () => process.argv.find((x) => x.startsWith('--lang='))?.slice('--lang='.length) || (smokeTest ? 'de' : '');

export function applyLanguage() {
  // --lang=en: screenshots and smoke runs in a fixed language (the setting wins otherwise).
  const forced = forcedLanguage();
  const setting = config.get().language;
  setLanguage(forced || setting, app.getLocale());
}

// Offline read mode: encrypted mirror of the Key Vault answers, replayed without network (offline.js).
export let offline = null;
export let offlineMode = false;
export const offlineMirror = () => (offline ||= new OfflineMirror({
  dir: app.getPath('userData'),
  protect: (buf) => safeStorage.encryptStringAsync(Buffer.from(buf).toString('base64')),
  unprotect: async (buf) => Buffer.from((await safeStorage.decryptStringAsync(Buffer.from(buf))).result, 'base64'),
}));
export const mirrorWanted = () => !!config.get().offlineMirror && !!config.get().appPin && !demo;

export function newSession() {
  setVault(new VaultSession({
    getToken: offlineMode ? async () => 'offline' : timedToken,
    store: new MemoryStore(),
    // Chromium network stack: Windows certificate store, system proxy, unaffected by NODE_TLS_REJECT_UNAUTHORIZED.
    // In-memory session: Key Vault responses never reach a disk cache – except the encrypted offline mirror.
    fetch: demo?.fetch || (offlineMode ? offlineMirror().replay : mirrorWanted() ? offlineMirror().record(timedFetch) : timedFetch),
    actor,
    // #476: "Nur für mich" entries of other people stay out of every list (window, extension, MCP, bridge).
    viewer: viewerId,
    adapters: { file: files },
    // Vaults of other tenants (customers, guest access) are found and opened with tokens for their tenant.
    multiTenant: true,
    // The sidebar spins the refresh icon of the vault that is being loaded or reconciled right now.
    onBusy: (containerId, busy) => {
      send({ type: 'busy', containerId, busy });
      // Diagnostics: how long a vault was loading or reconciling (only when it took noticeably long).
      if (busy) busySince.set(containerId, Date.now());
      else if (busySince.has(containerId)) {
        const ms = Date.now() - busySince.get(containerId);
        busySince.delete(containerId);
        if (ms > 5000) diag(`BUSY ${containerId} ${ms}ms`);
      }
    },
    // Listing progress (pages of 25) → progress card: per vault for a manual refresh, summed for the reconcile.
    onProgress: reportListing,
  }));
}

// Manual refreshes in progress (containerId → vault name) and the listing progress behind the reconcile card.
export const refreshing = new Map();
const listing = new Map();
let reconcileShown = false;
/** Many nearly empty pages: Key Vault walks over deleted (not yet purged) secrets – the listing gets slow. */
export const emptyPagesHint = (pages, secrets) => (pages > Math.ceil(secrets / 25) + 5
  ? t('Viele leere Seiten: Im Tresor liegen gelöschte Secrets, die noch nicht endgültig entfernt sind. Endgültig löschen macht den Abgleich schneller.')
  : '');

/** Step line of the progress card while a vault is listed: page and secrets so far. */
const listingDetail = (pages, secrets) => t('Secrets werden aufgelistet – Seite {page}, {n} gefunden', { page: pages, n: secrets });

function reportListing(containerId, done, total, pages = 0) {
  if (refreshing.has(containerId)) {
    // The listing also returns secrets that are no entries (index, settings, disabled ones): when it outgrows the
    // known size, a running bar instead of one stuck at 100 %.
    const r = refreshing.get(containerId);
    r.pages = pages;
    r.secrets = done;
    send({ type: 'progress', id: `refresh:${containerId}`, step: 'list', detail: listingDetail(pages, done), hint: emptyPagesHint(pages, done), ...(done >= total ? { total: 0 } : { done, total }) });
    return;
  }
  listing.set(containerId, { done, total, pages });
  if (!reconcileShown) return;
  let d = 0;
  let n = 0;
  for (const x of listing.values()) {
    d += x.done;
    n += x.total;
  }
  // The listing also returns secrets that are no entries, so it can outgrow the known size: then a running count
  // ("… 1250 gelesen") instead of a full bar that looks finished while the reconcile still runs.
  const allPages = [...listing.values()].reduce((sum, x) => sum + (x.pages || 0), 0);
  const detail = t('{vaults} Tresore · Seite {page}, {n} Secrets gefunden', { vaults: listing.size, page: allPages, n: d });
  const hint = [...listing.values()].some((x) => emptyPagesHint(x.pages || 0, x.done)) ? emptyPagesHint(allPages, 0) : '';
  if (d >= n) send({ type: 'progress', id: 'reconcile', step: 'list', detail, hint, total: 0 });
  else if (n > 0) send({ type: 'progress', id: 'reconcile', step: 'list', detail, hint, done: d, total: n });
}

export function changed() {
  send({ type: 'changed' });
  bridge?.broadcast('changed');
  if (config.get().windowsProvider) windows?.scheduleSync();
  // A personal vault opened or changed: settings may have come from another device.
  scheduleSettingsSync();
}

// With a PIN the vault data stays in memory while locked (RAM only, never the disk): unlocking shows the entries
// at once and signs in silently from the encrypted token cache instead of opening a new Microsoft window.
export let keptVault = false;
export let keptAccount = null;

/** Windows is locked (idle state "locked"; smoke tests set KVPWSAFE_TEST_WINDOWS_LOCKED): lock the app too. */
export function lockIfWindowsLocked() {
  const locked = smokeTest && process.env.KVPWSAFE_TEST_WINDOWS_LOCKED ? process.env.KVPWSAFE_TEST_WINDOWS_LOCKED === '1' : powerMonitor.getSystemIdleState(1) === 'locked';
  if (opened && locked) return lockNow().then(() => true);
  return Promise.resolve(false);
}

export async function lockNow() {
  pinGuard.consume(); // a PIN entered before locking must not open the app afterwards
  mcp?.revoke();
  cancelQuestions();
  clearCopyRules(); // #480
  if (!opened && !auth.account) return;
  clearInterval(reconcileTimer);
  if (opened && !offlineMode) await vault.flushFastIndex().catch(() => {});
  const keep = !!config.get().appPin && opened && !offlineMode;
  keptAccount = auth.account?.homeAccountId || null;
  offlineMode = false;
  auth.lock();
  files.lockAll();
  if (keep) {
    await vault.lockKeys();
    keptVault = true;
  } else {
    await vault?.clear();
    newSession();
    keptVault = false;
  }
  setOpened(false);
  setWindowLocked(false); // #507: locking ends the session for the window and the extension alike
  setSelectedKey(null);
  setLastBackup(null);
  setPendingRestore(null);
  applyShortcuts();
  send({ type: 'locked' });
  bridge?.broadcast('changed');
}

function configuredContainers() {
  const s = config.get();
  return [
    ...s.policyContainers.map((c) => ({ ...c, source: 'policy' })),
    ...s.containers.map((c) => ({ ...c, source: 'manual' })),
  ];
}

/**
 * quick (after unlocking): home tenant and entries first, so the app is usable at once; vaults of other tenants and
 * the role check per vault follow in the background and show up by themselves ("changed").
 */
export async function refreshAll({ quick = false } = {}) {
  await files.load();
  if (!signedIn()) return null;
  // Marked Key Vaults connect by themselves only when the user turned that on (demo and smoke: always).
  const discover = !!(config.get().autoDiscover || demo || smokeTest);
  const options = { configured: configuredContainers(), hidden: config.get().hiddenContainers, discover };
  const listed = vaultListRun();
  try {
    const { discoverError } = await vault.refreshContainers(quick ? { ...options, tenants: false, access: false } : options);
    if (!quick) listed();
    if (mirrorWanted()) offlineMirror().setContainers(await vault.containers());
    // Index secrets first (a few GETs however big the vault); the full listing reconciles in the background.
    await vault.refreshIndexFast();
    completeInBackground(vault, quick ? options : null, listed);
    rememberTenants().catch(() => {});
    return discoverError;
  } catch (e) {
    listed();
    throw e;
  }
}

/**
 * The vault list is being searched (#511 review): from the start of a refresh until all tenants are through (after
 * unlocking that is in the background). Meanwhile the vaults the user sees may lack some of theirs.
 * → done(), to call once when it is through (more calls do nothing).
 */
let vaultListRuns = 0;
export function vaultListRun() {
  vaultListRuns++;
  let open = true;
  return () => {
    if (open) vaultListRuns--;
    open = false;
  };
}
/** No vault search running: the vaults the user sees are all there are. */
export const vaultListComplete = () => vaultListRuns === 0;

/** Periodic reconcile while unlocked: the listing checks the index secrets and repairs drift. */
const RECONCILE_MS = 30 * 60_000;
let reconcileTimer = null;
function scheduleReconcile() {
  clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => {
    if (opened && !offlineMode && !demo && signedIn()) vault.refreshIndex().then(() => changed()).catch(() => {});
  }, RECONCILE_MS);
}

function completeInBackground(session, options, listed = () => {}) {
  (async () => {
    try {
      if (options) await session.refreshContainers(options);
    } finally {
      listed();
    }
    // Vaults without a resource ID (added by hand or by policy) get their role only here – without it the
    // admin functions (folders, settings) stay hidden.
    await session.refreshAccess().catch(() => {});
    const index = await session.index();
    const missing = (await session.containers()).filter((c) => c.kind === 'keyvault' && !index[c.id]).map((c) => c.id);
    if (missing.length) await session.refreshIndexFast(missing);
    // Locked or signed out meanwhile: the result belongs to an old session.
    if (session === vault && opened) changed();
    // Reconcile: the full listing (slow for big vaults) checks and repairs the index secrets; the window shows
    // it as a small progress card, nothing is blocked meanwhile.
    if (offlineMode) return;
    const shown = session === vault && opened;
    if (shown) send({ type: 'progress', id: 'reconcile', label: t('Tresore werden abgeglichen …'), step: 'list', detail: t('Secrets werden aufgelistet …') });
    listing.clear();
    reconcileShown = shown;
    const started = Date.now();
    try {
      await session.refreshIndex();
      for (const [id, x] of listing) if (Date.now() - started > 3000) diag(`LIST ${id} pages=${x.pages} secrets=${x.done} (reconcile, all vaults ${Date.now() - started}ms)`);
      if (shown) send({ type: 'progress', id: 'reconcile', step: 'done', detail: t('Fertig – {n} Einträge', { n: Object.values(await session.index()).reduce((sum, e) => sum + (e?.items?.length || 0), 0) }) });
    } finally {
      reconcileShown = false;
      if (shown) send({ type: 'progress', id: 'reconcile', end: true });
    }
    if (session === vault && opened) changed();
    scheduleReconcile();
  })().catch(() => {});
}

/** Tenants learned for hand-added vaults go into the settings, so the next start asks the right tenant at once. */
async function rememberTenants() {
  const s = config.get();
  const known = new Map((await vault.containers()).filter((c) => c.kind === 'keyvault' && c.tenantId).map((c) => [c.id, c.tenantId]));
  let changed = false;
  const containers = s.containers.map((c) => {
    const tenantId = known.get(vaultHost(c.vaultUrl));
    if (!tenantId || c.tenantId === tenantId) return c;
    changed = true;
    return { ...c, tenantId };
  });
  if (changed) config.update({ containers });
}

export async function containerResource(containerId) {
  const c = await vault.container(containerId);
  if (c.resourceId) return c.resourceId;
  const found = await vault.azureFor(c).findVault(c.vaultUrl);
  if (!found) throw new Error(t('Der Key Vault ist in Azure Resource Manager nicht sichtbar (Rolle „Leser“ auf dem Key Vault fehlt).'));
  return found.resourceId;
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setKeptVault(value) { keptVault = value; return value; }
export function setOfflineMode(value) { offlineMode = value; return value; }
