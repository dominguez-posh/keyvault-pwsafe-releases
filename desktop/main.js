// Keevault desktop app (Electron main process). All network and file access and all keys stay here;
// the sandboxed renderer only calls the API below through the preload bridge.

import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, powerMonitor, protocol, net, nativeTheme, session, Tray, Menu, nativeImage, globalShortcut, Notification, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Auth, LockedError, entraSettings } from './auth.js';
import { Config } from './config.js';
import { FileContainers } from './files.js';
import { hashPin, verifyPin, PinGuard, MIN_PIN_LENGTH } from './pin.js';
import { typeText, copySecret, warmUpAutoType, stopAutoType } from './autotype.js';
import { totpCode } from '../extension/core/totp.js';
import { BrowserBridge, launchPath, pipePath, registerNativeHost, unregisterNativeHost } from './bridge.js';
import { Updater, UPDATE_MODES } from './updater.js';
import { secureFetch, purgeDiskCaches } from './secure-net.js';
import { McpService, MCP_TOOLS, mcpHostScript, mcpClientConfig } from './mcp.js';
import { VaultSession, MemoryStore, POLICY_LABELS } from '../extension/core/session.js';
import { buildInvite, parseInvite, ROLES } from '../extension/core/azure.js';
import { vaultHost, KV_SCOPE } from '../extension/core/keyvault.js';
import { SAMPLE_CSV } from '../extension/core/import-sample.js';
import { mapLimit, decodeJwtPayload } from '../extension/core/util.js';
import { passwordReport, hibpParts, hibpCount } from '../extension/core/health.js';
import { OfflineMirror, isNetworkError } from './offline.js';
import { itemMatchesHost } from '../extension/core/match.js';
import { setLanguage, t } from '../extension/core/i18n.js';
import { FILE_EXTENSION } from '../extension/core/filevault.js';
import { createDemoBackend } from '../extension/core/demo.js';
import { BACKUP_EXTENSION, createBackup, generateBackupPassword, openBackup, readBackupHeader } from '../extension/core/backup.js';
import { CERT_MAX_BYTES, limitFolderDepth, requireFolderDepth, normalizeFolder } from '../extension/core/model.js';
import { itemsToCsv } from '../extension/core/export.js';
import { WindowsProvider, ORIGIN as WINDOWS_ORIGIN, providerStatus, registerProvider, rememberDesktopCommand, ensureProvider, machineSetupStatus, runMachineSetup } from './windows-provider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
// Folders the renderer (app://pwsafe/…) and the passkey window (http://localhost/…) may load.
const SERVED = ['desktop/renderer', 'desktop/assets', 'desktop/passkey', 'extension/core', 'extension/styles'];
const RP_ID = 'localhost';
const missingFiles = [];
const smokeTest = process.argv.includes('--smoke-test');
// Smoke runs are headless: an uncaught error must end the run, not open Electron's error dialog on the desktop
// (Electron only shows it when nobody else listens).
if (smokeTest) process.on('uncaughtException', (e) => { console.error(`SMOKE FAIL (main process): ${e?.stack || e}`); process.exit(1); });
const screenshot = process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
// --theme=dark|light: screenshots in a fixed colour scheme (otherwise Windows' app mode decides).
const forcedTheme = process.argv.find((a) => a.startsWith('--theme='))?.slice('--theme='.length);
if (forcedTheme === 'dark' || forcedTheme === 'light') nativeTheme.themeSource = forcedTheme;
const demo = process.argv.includes('--demo') ? createDemoBackend() : null;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// The product was renamed to Keevault; the profile (settings, encrypted token cache, PIN) stays in the folder of the
// old product name so that updates keep it.
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'KeyVault PwSafe'));
// Development runs get their own pipe (bridge.js pipePath) and never register themselves as the browser's native
// host or the Windows passkey command – the installed app keeps both (KVPWSAFE_DEV_INTEGRATION=1 to test them).
const devIsolated = !app.isPackaged && !process.env.KVPWSAFE_DEV_INTEGRATION;
if (!app.isPackaged) process.env.KVPWSAFE_DEV_PIPE = '1';

if (demo) {
  // Separate profile so that the demo never touches real settings, tokens or files.
  app.setPath('userData', path.join(app.getPath('temp'), `kvpwsafe-demo-${process.pid}`));
  process.env.KVPWSAFE_TENANT_ID = 'demo';
  process.env.KVPWSAFE_CLIENT_ID = 'demo';
}

const primaryInstance = smokeTest || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
// Tests use virtual authenticators only: never route WebAuthn to the Windows API (no OS dialogs during tests).
if (smokeTest) app.commandLine.appendSwitch('disable-features', 'WebAuthenticationUseNativeWinApi');
// No HTTP cache on disk at all (the app only loads its own files); Azure traffic runs in memory (secure-net.js).
app.commandLine.appendSwitch('disable-http-cache');
// No crash dumps: a dump of this process could contain decrypted entries. Chromium's crash reporter stays off, old
// dumps go at start (purgeCrashDumps), and Windows Error Reporting excludes the app (excludeFromErrorReporting).
app.commandLine.appendSwitch('disable-crash-reporter');
if (primaryInstance) purgeDiskCaches();

class DemoAuth {
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

let win = null;
let config;
let auth;
let files;
let vault;
let bridge = null;
let opened = false;
let clipboardTimer = null;
let windows = null;

const send = (data) => win?.webContents.send('event', data);
const signedIn = () => !!auth.account;
const actor = () => auth.account?.username || process.env.USERNAME || process.env.USER || '';

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(t('Bitte eine gültige E-Mail-Adresse eingeben'));
  return e;
}

function applyLanguage() {
  // --lang=en: screenshots and smoke runs in a fixed language (the setting wins otherwise).
  const forced = process.argv.find((a) => a.startsWith('--lang='))?.slice('--lang='.length);
  const setting = config.get().language;
  setLanguage(forced || setting, app.getLocale());
}

// Offline read mode: encrypted mirror of the Key Vault answers, replayed without network (offline.js).
let offline = null;
let offlineMode = false;
const offlineMirror = () => (offline ||= new OfflineMirror({
  dir: app.getPath('userData'),
  protect: (buf) => safeStorage.encryptString(Buffer.from(buf).toString('base64')),
  unprotect: (buf) => Buffer.from(safeStorage.decryptString(Buffer.from(buf)), 'base64'),
}));
const mirrorWanted = () => !!config.get().offlineMirror && !!config.get().appPin && !demo;

// ---- Diagnostics: slow or failing requests (> 1 s, status >= 400) and slow token requests go to
// %APPDATA%\KeyVault PwSafe\diagnostics.log – method, host, path, status, duration; never headers, bodies or values.
const SLOW_MS = 1000;
let diagWrites = Promise.resolve();
function diag(line) {
  const file = path.join(app.getPath('userData'), 'diagnostics.log');
  diagWrites = diagWrites.then(async () => {
    try {
      if ((await fs.stat(file).catch(() => null))?.size > 512_000) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Diagnostics never break a request.
    }
  });
}
// A request without an answer would keep a vault "loading" forever: after REQUEST_TIMEOUT_MS it is aborted (the
// Key Vault client retries network errors twice); after PENDING_MS a still open request is logged as PENDING.
const REQUEST_TIMEOUT_MS = 30_000;
const busySince = new Map(); // containerId → start of loading (diagnostics)
const PENDING_MS = 10_000;
async function timedFetch(url, init = {}) {
  const started = Date.now();
  let status = 'ERR';
  let where = String(url);
  try { const u = new URL(url); where = u.host + u.pathname; } catch { /* keep */ }
  const controller = init.signal ? null : new AbortController();
  const timeout = controller && setTimeout(() => controller.abort(new Error(`Zeitüberschreitung nach ${REQUEST_TIMEOUT_MS / 1000} s`)), REQUEST_TIMEOUT_MS);
  const pending = setTimeout(() => diag(`PENDING ${init.method || 'GET'} ${where} >${PENDING_MS}ms`), PENDING_MS);
  try {
    const res = await secureFetch(url, controller ? { ...init, signal: controller.signal } : init);
    status = res.status;
    return res;
  } catch (e) {
    if (controller?.signal.aborted) status = 'TIMEOUT';
    throw e;
  } finally {
    clearTimeout(timeout);
    clearTimeout(pending);
    const ms = Date.now() - started;
    if (ms > SLOW_MS || status === 'ERR' || status === 'TIMEOUT' || status >= 400) diag(`${init.method || 'GET'} ${where} ${status} ${ms}ms`);
  }
}
async function timedToken(scope, opts) {
  const started = Date.now();
  const pending = setTimeout(() => diag(`PENDING TOKEN ${String(scope).replace(/^https:\/\//, '')} tenant=${opts?.tenantId || 'home'} >${PENDING_MS}ms`), PENDING_MS);
  try {
    return await auth.getToken(scope, opts);
  } finally {
    clearTimeout(pending);
    const ms = Date.now() - started;
    if (ms > SLOW_MS) diag(`TOKEN ${String(scope).replace(/^https:\/\//, '')} tenant=${opts?.tenantId || 'home'} force=${!!opts?.forceRefresh} ${ms}ms`);
  }
}

function newSession() {
  vault = new VaultSession({
    getToken: offlineMode ? async () => 'offline' : timedToken,
    store: new MemoryStore(),
    // Chromium network stack: Windows certificate store, system proxy, unaffected by NODE_TLS_REJECT_UNAUTHORIZED.
    // In-memory session: Key Vault responses never reach a disk cache – except the encrypted offline mirror.
    fetch: demo?.fetch || (offlineMode ? offlineMirror().replay : mirrorWanted() ? offlineMirror().record(timedFetch) : timedFetch),
    actor,
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
  });
}

// Manual refreshes in progress (containerId → vault name) and the listing progress behind the reconcile card.
const refreshing = new Map();
const listing = new Map();
let reconcileShown = false;
/** Many nearly empty pages: Key Vault walks over deleted (not yet purged) secrets – the listing gets slow. */
const emptyPagesHint = (pages, secrets) => (pages > Math.ceil(secrets / 25) + 5
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

function changed() {
  send({ type: 'changed' });
  bridge?.broadcast('changed');
  if (config.get().windowsProvider) windows?.scheduleSync();
}

function requireOpen() {
  if (!opened) throw new LockedError();
}

let lastBackup = null;
let pendingRestore = null;

/** Backup and restore: Key Vault container whose subscription the user owns. → container */
async function requireSubscriptionOwner(containerId) {
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Backups gibt es nur für Tresore in Azure Key Vault'));
  const azure = vault.azureFor(c);
  const resourceId = c.resourceId || (await azure.findVault(c.vaultUrl).catch(() => null))?.resourceId;
  const subscriptionId = /\/subscriptions\/([^/]+)/i.exec(resourceId || '')?.[1];
  if (!subscriptionId) throw new Error(t('Die Subscription dieses Tresors ist nicht bekannt.'));
  if (!(await azure.subscriptionOwner(subscriptionId).catch(() => false))) {
    throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
  }
  return c;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function backupSheetHtml(b) {
  const row = (label, value) => `<tr><th>${escHtml(label)}</th><td>${escHtml(value)}</td></tr>`;
  return `<!doctype html><html lang="de"><meta charset="utf-8"><title>${escHtml(t('Keevault – Backup-Passwort'))}</title>
<style>body{font:14px/1.5 "Segoe UI",Arial,sans-serif;margin:40px;color:#000}h1{font-size:22px;margin:0 0 4px}
table{border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:4px 16px 4px 0;vertical-align:top}
.pw{font:bold 26px/1.4 Consolas,monospace;letter-spacing:2px;border:2px solid #000;padding:14px 18px;margin:18px 0;display:inline-block}
.warn{border:2px solid #000;padding:12px 16px;margin-top:18px}.warn b{display:block;margin-bottom:6px}</style>
<h1>${escHtml(t('Keevault – Backup-Passwort'))}</h1>
<p>${escHtml(t('Dieses Blatt gehört zu genau einem Backup. Ohne das Passwort lässt sich das Backup nicht wiederherstellen.'))}</p>
<table>${row(t('Tresor'), `${b.name} (${b.vault})`)}${row(t('Backup-Datei'), b.file)}${row(t('Erstellt'), new Date(b.created).toLocaleString())}${row(t('Erstellt von'), b.by)}${row(t('Einträge (Secrets)'), b.count)}</table>
<div class="pw">${escHtml(b.password)}</div>
<div class="warn"><b>${escHtml(t('Wichtig – bitte sicher aufbewahren'))}</b>
${escHtml(t('Das Passwort wird nur dieses eine Mal angezeigt und ist nirgends gespeichert – auch nicht beim Hersteller. Geht es verloren, ist das Backup unbrauchbar.'))}<br>
${escHtml(t('Wer Backup-Datei und Passwort hat, kann alle Passwörter dieses Tresors lesen. Bewahre dieses Blatt getrennt von der Datei an einem sicheren Ort auf, z. B. im Tresor oder Bankschließfach.'))}<br>
${escHtml(t('Für die sichere Aufbewahrung von Backup-Datei und Passwort ist der Kunde selbst verantwortlich.'))}</div>
</html>`;
}

/** Prints HTML through the system print dialog (printer or "Microsoft Print to PDF"). */
async function printHtml(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve, reject) => w.webContents.print({ printBackground: false }, (ok, reason) => (ok || reason === 'cancelled' ? resolve() : reject(new Error(reason)))));
  } finally {
    w.destroy();
  }
}

const pinGuard = new PinGuard(); // counter restored from the settings once config exists (app ready)

/** Unlocking needs a freshly verified PIN once one is set. */
function requirePin() {
  if (config.get().appPin && !pinGuard.consume()) {
    const e = new Error(t('Bitte zuerst die PIN eingeben'));
    e.name = 'PinRequired';
    throw e;
  }
}

// With a PIN the vault data stays in memory while locked (RAM only, never the disk): unlocking shows the entries
// at once and signs in silently from the encrypted token cache instead of opening a new Microsoft window.
let keptVault = false;
let keptAccount = null;

async function lockNow() {
  mcp?.revoke();
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
  opened = false;
  selectedKey = null;
  lastBackup = null;
  pendingRestore = null;
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
async function refreshAll({ quick = false } = {}) {
  await files.load();
  if (!signedIn()) return null;
  const options = { configured: configuredContainers(), hidden: config.get().hiddenContainers };
  const { discoverError } = await vault.refreshContainers(quick ? { ...options, tenants: false, access: false } : options);
  if (mirrorWanted()) offlineMirror().setContainers(await vault.containers());
  // Index secrets first (a few GETs however big the vault); the full listing reconciles in the background.
  await vault.refreshIndexFast();
  completeInBackground(vault, quick ? options : null);
  rememberTenants().catch(() => {});
  return discoverError;
}

/** Periodic reconcile while unlocked: the listing checks the index secrets and repairs drift. */
const RECONCILE_MS = 30 * 60_000;
let reconcileTimer = null;
function scheduleReconcile() {
  clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => {
    if (opened && !offlineMode && !demo && signedIn()) vault.refreshIndex().then(() => changed()).catch(() => {});
  }, RECONCILE_MS);
}

function completeInBackground(session, options) {
  (async () => {
    if (options) await session.refreshContainers(options);
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

/**
 * Vault settings: Key Vault administrators may do everything; everyone else only what an admin enabled
 * (Key Vault vaults only – file vaults have their own roles). → container
 */
async function requireFeature(containerId, feature) {
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault' || c.access?.admin) return c;
  const p = await vault.policy(containerId);
  if (!p?.features[feature]) {
    throw new Error(t('Diese Funktion hat ein Admin des Tresors nicht freigeschaltet: {feature}', { feature: t(POLICY_LABELS[feature]) }));
  }
  return c;
}

async function containerResource(containerId) {
  const c = await vault.container(containerId);
  if (c.resourceId) return c.resourceId;
  const found = await vault.azureFor(c).findVault(c.vaultUrl);
  if (!found) throw new Error(t('Der Key Vault ist in Azure Resource Manager nicht sichtbar (Rolle „Leser“ auf dem Key Vault fehlt).'));
  return found.resourceId;
}

let psClipboardBlocked = false;

/**
 * Installed app on Windows: exclude Keevault.exe from Windows Error Reporting once per version, so a crash never
 * leaves (or uploads) a memory dump with decrypted entries. Runs quietly in the background.
 */
function excludeFromErrorReporting() {
  if (process.platform !== 'win32' || !app.isPackaged || config.get().werExcluded === app.getVersion()) return;
  const exe = helperExe();
  if (!exe) return;
  const child = spawn(exe, ['--wer-exclude', path.basename(process.execPath)], { windowsHide: true, stdio: 'ignore' });
  child.on('exit', (code) => { if (code === 0) config.update({ werExcluded: app.getVersion() }); });
  child.on('error', () => {});
}

/** Keevault-Update.exe next to the app (resources) or from the Windows build (development). */
function helperExe() {
  const candidates = [path.join(process.resourcesPath || '', 'Keevault-Update.exe'), path.join(appRoot, 'windows', 'out', 'Keevault-Update.exe')];
  return candidates.find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Clipboard with history/cloud markers through the own helper (stdin, no command line, no window). */
function copyViaHelperExe(text) {
  const exe = helperExe();
  if (!exe) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(exe, ['--clipboard'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 4000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.end(Buffer.from(text, 'utf8'));
  });
}

/**
 * Copies a value. On Windows with the markers that keep it out of the clipboard history (Win+V) and the
 * cloud clipboard – a copied password must not end up in a history or on other devices.
 */
async function copyToClipboard(text) {
  if (process.platform === 'win32' && !smokeTest && !demo) {
    // The helper is a PowerShell process; endpoint protection may block or stall it (Sophos, 2026-10-31) – then
    // copy plainly after 1.5 s instead of hanging without any feedback.
    // Order: the PowerShell helper (warm, fast); if it is blocked (endpoint protection, Constrained Language Mode),
    // Keevault-Update.exe --clipboard (windows/Setup/Clip.cs) sets the same markers. Only if both fail the text goes
    // to the clipboard without them – noted in the diagnostics log.
    let ok = !psClipboardBlocked && await Promise.race([copySecret(text).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1500))]);
    if (!ok && !psClipboardBlocked) {
      psClipboardBlocked = true;
      diag('COPY PowerShell helper unavailable – using Keevault-Update.exe');
    }
    if (!ok) ok = await copyViaHelperExe(text);
    if (!ok) {
      diag('COPY no helper – plain clipboard (without history/cloud markers)');
      clipboard.writeText(text);
    }
  } else {
    clipboard.writeText(text);
  }
  if (clipboard.readText() !== text) throw new Error(t('Die Zwischenablage ist nicht verfügbar.'));
  clearTimeout(clipboardTimer);
  const seconds = Number(config.get().clipboardSeconds) || 0;
  if (seconds > 0) {
    clipboardTimer = setTimeout(() => {
      if (clipboard.readText() === text) clipboard.clear();
    }, seconds * 1000);
  }
}

// ---------------------------------------------------------------- passkey window (WebAuthn with PRF)

let passkeySession = null;

function servedFile(rel) {
  const file = path.normalize(path.join(appRoot, rel));
  return SERVED.some((dir) => file.startsWith(path.join(appRoot, dir) + path.sep)) ? file : null;
}

async function serve(rel) {
  const file = servedFile(rel);
  if (!file) {
    missingFiles.push(rel);
    return new Response('Not found', { status: 404 });
  }
  try {
    return await net.fetch(pathToFileURL(file).toString());
  } catch {
    missingFiles.push(rel);
    return new Response('Not found', { status: 404 });
  }
}

// One reusable window: real authenticators do not care, and the window opens faster the second time.
let passkeyWindow = null;
let ceremony = null; // { id, request, resolve, reject, timer }
let quitting = false;
let updater = null;
const autoTypeCalls = [];
let selectedKey = null;
let windowStateBeforeRequest = null;

/** After a Windows passkey request: back to the tray (or minimized) if the window was not open before. */
function restoreAfterWindowsRequest() {
  if (!win) return;
  win.setAlwaysOnTop(false);
  const before = windowStateBeforeRequest;
  windowStateBeforeRequest = null;
  if (smokeTest) return;
  if (before === 'hidden') win.hide();
  else if (before === 'minimized') win.minimize();
}
let shortcutsActive = '';

/** Value of the selected entry for auto-type ('u' user name, 'p' password, 'o' one-time code). */
async function autoTypeValue(key, what) {
  const i = key.indexOf('/');
  const item = await vault.getItem(key.slice(0, i), key.slice(i + 1));
  const value = what === 'u' ? item.username : what === 'p' ? item.password : item.totp ? (await totpCode(item.totp))?.code : '';
  if (!value) throw new Error({ u: t('Kein Benutzername hinterlegt'), p: t('Kein Passwort hinterlegt'), o: t('Kein Einmalcode (TOTP) hinterlegt') }[what] || t('Nicht gefunden'));
  return value;
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Keevault', body, silent: true }).show();
}

/** Global auto-type: types into whatever window has the focus, for the entry selected in the app. */
async function globalAutoType(what) {
  try {
    if (!opened) throw new Error(t('Keevault ist gesperrt'));
    if (!selectedKey) throw new Error(t('Zuerst in Keevault einen Eintrag auswählen'));
    const value = await autoTypeValue(selectedKey, what);
    if (smokeTest) {
      autoTypeCalls.push(`global:${what}`);
      return;
    }
    await typeText(value);
  } catch (e) {
    notify(e.message);
  }
}

/** Global shortcuts only while unlocked (a locked app must not take keys away from other programs). */
function applyShortcuts() {
  const modifier = opened ? config.get().autoTypeKeys : '';
  if (modifier === shortcutsActive) return;
  globalShortcut.unregisterAll();
  shortcutsActive = '';
  if (!modifier) return;
  const failed = [];
  for (const k of ['U', 'P', 'O']) {
    if (!globalShortcut.register(`${modifier}+${k}`, () => globalAutoType(k.toLowerCase()))) failed.push(k);
  }
  shortcutsActive = modifier;
  if (failed.length) notify(t('Tastenkürzel {keys} sind bereits von einem anderen Programm belegt', { keys: failed.map((k) => `${modifier.replace('CommandOrControl', 'Strg').replace('Shift', 'Umschalt')}+${k}`).join(', ') }));
}
app.on('before-quit', () => {
  quitting = true;
  stopAutoType();
  globalShortcut.unregisterAll();
});

function finishCeremony(result) {
  const c = ceremony;
  if (!c) return;
  ceremony = null;
  clearTimeout(c.timer);
  if (passkeyWindow && !passkeyWindow.isDestroyed()) passkeyWindow.hide();
  if (result?.ok) c.resolve(result.result);
  else c.reject(new Error(result?.error || t('Passkey-Vorgang abgebrochen oder abgelaufen')));
}

function ensurePasskeyWindow() {
  if (passkeyWindow && !passkeyWindow.isDestroyed()) return passkeyWindow;
  if (!passkeySession) {
    passkeySession = session.fromPartition('kvpwsafe-passkey');
    passkeySession.protocol.handle('http', (req) => {
      const url = new URL(req.url);
      if (url.host !== 'localhost') return new Response('Not found', { status: 404 });
      return serve(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    });
    passkeySession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
  passkeyWindow = new BrowserWindow({
    parent: (!smokeTest && win) || undefined,
    modal: !smokeTest && !!win,
    width: 460,
    height: 330,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: t('Passkey'),
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#f5f6f8',
    webPreferences: { session: passkeySession, preload: path.join(here, 'passkey', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  passkeyWindow.removeMenu();
  passkeyWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    finishCeremony({ ok: false });
  });
  return passkeyWindow;
}

function passkeyCeremony(request) {
  if (ceremony) finishCeremony({ ok: false });
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const language = config.get().language === 'auto' ? app.getLocale() : config.get().language;
    // Tests: short WebAuthn timeout, so that a misrouted request can never leave an OS dialog open.
    ceremony = { id, request: { ...request, language, timeoutMs: smokeTest ? 8000 : 120_000 }, resolve, reject };
    if (smokeTest) {
      ceremony.timer = setTimeout(async () => {
        const text = await passkeyWindow?.webContents.executeJavaScript('document.body.innerText').catch((e) => e.message);
        finishCeremony({ ok: false, error: `smoke test: passkey timeout (${String(text).replace(/\s+/g, ' ').trim()})` });
      }, 30_000);
    }
    const w = ensurePasskeyWindow();
    w.setTitle(t('Passkey'));
    // Query instead of fragment: every ceremony must be a fresh document in the reused window.
    w.loadURL(`http://localhost/desktop/passkey/passkey.html?id=${id}`);
    if (!smokeTest) {
      w.show();
      w.focus();
    }
  });
}

ipcMain.handle('passkey:request', (event, id) => {
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return null;
  return ceremony.request;
});

ipcMain.handle('passkey:done', (event, id, result) => {
  if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] passkey:done sameSession=${event.sender.session === passkeySession} sameId=${ceremony?.id === id} ok=${result?.ok}`);
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return;
  finishCeremony(result);
});

/** attachment: 'platform' (Windows Hello) | 'cross-platform' (security key, phone) | undefined (any) */
async function registerPasskey(containerName, label, exclude = [], attachment) {
  const r = await passkeyCeremony({ mode: 'register', containerName, userName: `${label} · ${containerName}`, displayName: label, exclude, attachment, autoStart: !smokeTest });
  return { ...r, label: attachment === 'platform' ? `${label} · Windows Hello` : label };
}

// ---------------------------------------------------------------- browser bridge

async function approveBrowser(origin) {
  const s = config.get();
  if (origin.startsWith('mcp:')) return approveAgent(origin.slice(4));
  // The Windows provider only relays requests signed by Windows; every operation is confirmed in the app.
  if (origin === WINDOWS_ORIGIN) return !!s.windowsProvider;
  if (s.approvedBrowsers.includes(origin)) return true;
  if (!win) return false;
  win.show();
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('Erlauben'), t('Ablehnen')],
    defaultId: 0,
    cancelId: 1,
    message: t('Die Browser-Erweiterung möchte auf deine Datei-Tresore zugreifen.'),
    detail: t('{origin}\n\nErlaube das nur, wenn du die Erweiterung Keevault gerade nutzt.', { origin }),
  });
  if (r.response !== 0) return false;
  config.update({ approvedBrowsers: [...s.approvedBrowsers, origin] });
  return true;
}

// The extension works through the desktop app for every container (Key Vault and file): sign-in, tenants and
// keys stay here, the extension needs no configuration of its own.
const forBrowser = (c) => ({
  id: c.id, name: c.name, source: c.kind, sources: ['file'], locked: !!c.locked, protected: !!c.protected,
  error: c.error ? { status: c.error.status || 0, message: c.error.message } : null, access: c.access || null,
});
const browserContainers = async () => (opened ? (await vault.containers()).map(forBrowser) : []);

const INDEX_MAX_AGE = 5 * 60_000;
const SNAPSHOT_PAGE = 500;
let staleRefresh = null;

/** Vaults loaded longer ago than INDEX_MAX_AGE: reload them in the background and report the change. */
async function refreshStaleForBrowser() {
  if (staleRefresh || !opened) return;
  const index = await vault.index();
  if (!Object.values(index).some((e) => Date.now() - (e.loadedAt || 0) > INDEX_MAX_AGE)) return;
  staleRefresh = vault.summaries({ maxAgeMs: INDEX_MAX_AGE }).then(changed, () => {}).finally(() => { staleRefresh = null; });
}

const browserHandlers = {
  hello: async () => ({ version: app.getVersion(), opened, pinSet: !!config.get().appPin, containers: await browserContainers() }),
  // Everything the extension lists in one answer, straight from the cache (never waits for Azure when there is a
  // cache); outdated vaults are reloaded afterwards and announced with "changed".
  snapshot: async () => {
    const pinSet = !!config.get().appPin;
    if (!opened) return { version: app.getVersion(), opened: false, pinSet, containers: [], summaries: [] };
    const summaries = await vault.summaries({ maxAgeMs: Infinity });
    refreshStaleForBrowser().catch(() => {});
    // Native messaging allows 1 MB per message: big lists go in pages (summariesPage).
    const out = { version: app.getVersion(), opened: true, pinSet, containers: await browserContainers(), summaries: summaries.slice(0, SNAPSHOT_PAGE) };
    if (summaries.length > SNAPSHOT_PAGE) out.more = { total: summaries.length, pageSize: SNAPSHOT_PAGE };
    return out;
  },
  summariesPage: async ({ page, pageSize }) => {
    requireOpen();
    const size = Math.min(Number(pageSize) || SNAPSHOT_PAGE, SNAPSHOT_PAGE);
    const all = await vault.summaries({ maxAgeMs: Infinity });
    return all.slice(Number(page) * size, (Number(page) + 1) * size);
  },
  // Unlock from the browser with the app PIN: silent sign-in, no window (only once a PIN is set – without one
  // the app window stays the place to unlock, so nothing on the machine can open the vault without a secret).
  unlockPin: async ({ pin }) => {
    if (opened) return true;
    if (!config.get().appPin) throw new Error(t('Ohne PIN bitte in der Desktop-App entsperren'));
    await api.verifyPin(String(pin || ''));
    await api.unlock({ entra: true, background: true });
    return true;
  },
  containers: () => browserContainers(),
  summaries: async () => (opened ? vault.summaries() : []),
  refresh: async () => {
    requireOpen();
    await vault.summaries({ maxAgeMs: 0 });
    changed();
    return true;
  },
  // itemId – "id" is the request number of the bridge protocol.
  item: ({ containerId, itemId }) => {
    requireOpen();
    return vault.getItem(containerId, itemId, { fresh: true });
  },
  // Changes from the browser show up in the app (and other browsers) at once.
  save: async ({ containerId, item, expectedVersion }) => {
    requireOpen();
    const saved = await vault.saveItem(containerId, item, { expectedVersion });
    changed();
    return saved;
  },
  delete: async ({ containerId, itemId }) => {
    requireOpen();
    const result = await vault.deleteItem(containerId, itemId);
    changed();
    return result;
  },
  lock: async () => {
    await lockNow();
    return true;
  },
  passkeyCandidates: async ({ rpId }) => (opened ? vault.passkeyCandidates(rpId) : []),
  matches: async ({ host }) => (opened ? (await vault.summaries()).filter((s) => s.type === 'login' && itemMatchesHost(s.hosts, host)) : []),
  focus: async () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
    return true;
  },
};

const windowsHandlers = {
  hello: async () => ({ version: app.getVersion() }),
  'win:status': async () => windows.status(),
  'win:makeCredential': (msg) => windows.request('create', msg),
  'win:getAssertion': (msg) => windows.request('get', msg),
  'win:cancel': async ({ transactionId }) => windows.cancel(transactionId),
};

// Browsers and the Windows provider share the pipe but get separate command sets.
// ---------------------------------------------------------------- AI agents (MCP, see mcp.js)

let mcp = null;
const mcpScriptPath = () => path.join(app.getPath('userData'), 'mcp', 'keevault-mcp.cjs');

/** Each agent (MCP client name) is allowed once; off unless switched on (or forbidden by policy). */
async function approveAgent(agent) {
  const s = config.get();
  if (!s.mcpEnabled || demo) return false;
  if (s.approvedAgents.includes(agent)) {
    const until = s.agentRules?.[agent]?.until;
    if (!until || Date.parse(until) > Date.now()) return true;
    // The approval ran out: ask again.
    config.update({ approvedAgents: s.approvedAgents.filter((x) => x !== agent) });
  }
  const answer = await askInApp({
    kind: 'agent-connect',
    agent,
    title: t('„{agent}“ möchte sich verbinden', { agent }),
    lead: t('Ein KI-Agent möchte Keevault nutzen. Erlaube das nur für Agenten, die du selbst eingerichtet hast.'),
    choices: [
      { value: 'write', label: t('Lesen und Schreiben'), hint: t('Suchen, Passwörter mit deiner Freigabe lesen, Einträge mit Bestätigung anlegen und ändern.') },
      { value: 'read', label: t('Nur lesen'), hint: t('Suchen und Passwörter mit deiner Freigabe lesen – keine Änderungen.') },
    ],
    note: t('Löschen ist nie möglich. Rechte und Gültigkeit änderst du jederzeit in den Einstellungen.'),
    allow: t('Verbinden'),
    cancel: 'deny',
  });
  if (answer === 'deny') return false;
  config.update({
    approvedAgents: [...config.get().approvedAgents, agent],
    agentRules: { ...config.get().agentRules, [agent]: { write: answer === 'write', until: null } },
  });
  return true;
}

async function confirmAgentRead({ agent, title, vault: vaultName }) {
  return askInApp({
    kind: 'agent-read',
    agent,
    title: t('„{agent}“ möchte ein Passwort lesen', { agent }),
    entry: title,
    vault: vaultName,
    choices: [
      { value: 'once', label: t('Nur dieses Mal'), hint: t('Beim nächsten Passwort fragt Keevault wieder.') },
      { value: 'session', label: t('Für diese Sitzung'), hint: t('Bis der Agent beendet wird, höchstens 8 Stunden.') },
      { value: 'minutes:60', label: t('Für 1 Stunde'), hint: t('Ohne Rückfrage – auch wenn der Agent zwischendurch neu startet.') },
      { value: 'minutes:240', label: t('Für 4 Stunden'), hint: t('Ohne Rückfrage – auch wenn der Agent zwischendurch neu startet.') },
    ],
    note: t('Sperren von Keevault beendet jede Freigabe.'),
    allow: t('Erlauben'),
    cancel: 'deny',
  });
}

async function confirmAgentWrite({ agent, action, title, vault: vaultName, fields }) {
  return (await askInApp({
    kind: 'agent-write',
    agent,
    title: action === 'create' ? t('„{agent}“ möchte einen Eintrag anlegen', { agent }) : t('„{agent}“ möchte einen Eintrag ändern', { agent }),
    entry: title,
    vault: vaultName,
    fields,
    allow: action === 'create' ? t('Anlegen') : t('Ändern'),
    cancel: 'deny',
  })) === 'allow';
}

// ---- Questions to the user from background requests (AI agents): a dialog in the app's own style, window in front.
const questions = new Map(); // id → resolve
let questionSeq = 0;

/**
 * spec: { kind, agent, title, lead?, entry?, vault?, fields?, choices?: [{ value, label, hint }], note?, allow, cancel }
 * → the chosen choice (or 'allow' without choices), or `cancel`. The window comes to the front and stays on top
 * while the question is open (agents wait for it). Without a ready window the native dialog asks instead.
 */
async function askInApp(spec) {
  showWindow();
  if (!win || win.webContents.isLoading()) {
    const options = spec.choices ? spec.choices.map((c) => ({ value: c.value, label: c.label })) : [{ value: 'allow', label: spec.allow }];
    const r = await dialog.showMessageBox(win || null, {
      type: 'question', buttons: [...options.map((o) => o.label), t('Ablehnen')], cancelId: options.length, noLink: true,
      message: spec.title, detail: [spec.lead, spec.entry && `${spec.entry} · ${spec.vault}`, spec.fields?.join(', '), spec.note].filter(Boolean).join('\n\n'),
    });
    return options[r.response]?.value ?? spec.cancel;
  }
  const id = ++questionSeq;
  win.setAlwaysOnTop(true, 'floating');
  win.flashFrame(true);
  try {
    return await new Promise((resolve) => {
      questions.set(id, resolve);
      send({ type: 'question', id, ...spec });
      // Nobody answers within 5 minutes: treated as the cancel choice (the agent gets a refusal, not a hang).
      setTimeout(() => {
        if (questions.delete(id)) {
          send({ type: 'questionClose', id });
          resolve(spec.cancel);
        }
      }, 5 * 60_000);
    });
  } finally {
    if (!questions.size && win) {
      win.setAlwaysOnTop(false);
      win.flashFrame(false);
    }
  }
}

/** Log of agent calls (no secret values) in the profile; rotates at 1 MB. */
async function auditAgent(entry) {
  const file = path.join(app.getPath('userData'), 'mcp-audit.log');
  try {
    if ((await fs.stat(file).catch(() => null))?.size > 1_000_000) await fs.rename(file, `${file}.1`);
    await fs.appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Logging must never break the call.
  }
}

const mcpHandlers = {
  hello: async (_msg, client) => {
    client.agent = client.origin.slice(4);
    mcp.connect(client);
    return { version: app.getVersion() };
  },
  'mcp:call': ({ tool, args }, client) => mcp.call(client, tool, args),
};

const bridgeHandlers = new Proxy({}, {
  get: (_target, cmd) => (msg, client) => {
    const set = client?.origin === WINDOWS_ORIGIN ? windowsHandlers : client?.origin?.startsWith('mcp:') ? mcpHandlers : browserHandlers;
    if (!Object.hasOwn(set, cmd)) throw new Error(`Unknown command ${String(cmd)}`);
    return set[cmd](msg, client);
  },
});

/**
 * Installed app, every start: provider for this user. Missing device-wide parts (certificate trust, extension
 * policy) are reported once per version with the option to set them up with administrator rights.
 */
async function setupWindowsProvider() {
  if (!config.get().windowsProvider && !config.get().browserIntegration) return;
  let status = config.get().windowsProvider ? await ensureProvider(`${app.getVersion()}.0`) : null;
  const machine = await machineSetupStatus();
  const missing = [
    status?.installError || (config.get().windowsProvider && !machine.certTrusted)
      ? t('Passkey-Anbieter: Windows vertraut dem Zertifikat des Pakets noch nicht.') : null,
    config.get().browserIntegration && !machine.edgePolicy ? t('Browser-Erweiterung: Die Richtlinie zur Installation in Edge/Chrome fehlt.') : null,
  ].filter(Boolean);
  if (missing.length && config.get().machineSetupHint !== app.getVersion()) {
    config.update({ machineSetupHint: app.getVersion() });
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('Mit Administratorrechten einrichten'), t('Später')],
      defaultId: 0,
      cancelId: 1,
      message: t('Für Keevault fehlt noch eine Einrichtung auf diesem Gerät.'),
      detail: `${missing.join('\n')}\n\n${t('Das richtet eure IT einmal pro Gerät ein (Intune-Skript „Keevault-Geraet-Einrichten.ps1“) – oder du machst es jetzt mit Administratorrechten. Alles andere funktioniert schon.')}`,
    });
    if (r.response === 0) {
      await api.runMachineSetup().catch((e) => dialog.showErrorBox(t('Einrichtung fehlgeschlagen'), e.message));
      if (config.get().windowsProvider) status = await ensureProvider(`${app.getVersion()}.0`);
    }
  }
  if (!status) return;
  if (!status.registered || status.enabled || config.get().windowsProviderHint) return;
  config.update({ windowsProviderHint: true });
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: [t('Windows-Einstellungen öffnen'), t('Später')],
    defaultId: 0,
    cancelId: 1,
    message: t('Keevault ist als Passkey-Anbieter eingerichtet.'),
    detail: t('Schalte ihn einmal in Windows ein: Einstellungen → Konten → Passkeys → Erweiterte Optionen → „Keevault“. Danach steht er auch in anderen Browsern und Apps zur Verfügung.'),
  });
  if (r.response === 0) shell.openExternal('ms-settings:savedpasskeys');
}

/**
 * View settings: zoom of the window content and the transparency of the whole window (programs behind it shine through).
 */
function applyView() {
  if (!win || win.isDestroyed()) return;
  const v = config.get();
  win.webContents.setZoomFactor(Math.min(1.5, Math.max(0.8, Number(v.zoom) || 1)));
  // Transparency: the whole window becomes see-through, the programs behind it shine through (light 90 %, strong 75 %).
  win.setOpacity(v.transparency === 'strong' ? 0.75 : v.transparency === 'light' ? 0.9 : 1);
}

/** Window buttons over the hidden title bar: the ground colour of the app (extension/styles/app.css --bg). */
function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#18191d' : '#f5f6f8', symbolColor: dark ? '#eceef2' : '#1b1d22', height: 52 };
}

/** Windows login item of the installed app (tray only, --background); development and MSIX stay untouched. */
function applyStartWithWindows() {
  if (!app.isPackaged || process.platform !== 'win32' || process.windowsStore || demo) return;
  app.setLoginItemSettings({ openAtLogin: !!config.get().startWithWindows, args: ['--background'] });
}

async function applyBrowserIntegration() {
  const s = config.get();
  if (!demo && !devIsolated) {
    if (s.browserIntegration) {
      // Installed app on Windows: started through the shell (kvpwsafe:// link) instead of as a child of the
      // browser's native-messaging host – endpoint protection (e.g. Sophos "Lockdown") blocks programs started
      // from the browser's process chain. MSIX and development keep the direct start.
      const viaShell = app.isPackaged && process.platform === 'win32' && !process.windowsStore;
      const launch = viaShell
        ? { cmd: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), args: ['kvpwsafe://open'] }
        : { cmd: launchPath(), args: app.isPackaged ? [] : [appRoot] };
      await registerNativeHost({ userData: app.getPath('userData'), extensionIds: s.extensionIds, launch });
    } else await unregisterNativeHost();
    if (s.windowsProvider) await rememberDesktopCommand(launchPath(), app.isPackaged ? '' : `"${appRoot}"`).catch(() => {});
  }
  if (s.mcpEnabled && !demo) {
    await fs.mkdir(path.dirname(mcpScriptPath()), { recursive: true });
    await fs.writeFile(mcpScriptPath(), mcpHostScript(pipePath(app.getPath('userData')), app.getVersion()));
  }
  if ((s.browserIntegration || s.windowsProvider || s.mcpEnabled) && !demo) {
    if (!bridge) {
      bridge = new BrowserBridge({ userData: app.getPath('userData'), handlers: bridgeHandlers, approve: approveBrowser });
      await bridge.start();
    }
  } else {
    bridge?.stop();
    bridge = null;
  }
}

// ---------------------------------------------------------------- API for the renderer

async function protectionCtx(containerId) {
  const c = await vault.container(containerId);
  const info = await vault.protectionInfo(containerId, RP_ID);
  return { c, info };
}

/** ARM/Graph for a subscription's tenant: own tenant directly, customer tenants with the guest account. */
const azureForSubscription = (tenantId) => (!tenantId || tenantId === auth.account?.tenantId ? vault.azure : vault.azureFor({ tenantId }));

const api = {
  async state() {
    const settings = config.get();
    const containers = opened ? await vault.containers() : (await files.containers()).map((c) => ({ ...c, kind: 'file' }));
    const index = opened && signedIn() ? await vault.index() : {};
    const out = [];
    for (const c of containers) {
      let count = index[c.id]?.items.length ?? null;
      if (c.kind === 'file' && !c.locked && !c.error) count = (await files.summaries(c.id)).length;
      // Vault settings decide which functions non-admins see (null: file vault or not readable).
      const policy = opened && c.kind === 'keyvault' && !c.error ? (await vault.policy(c.id).catch(() => null))?.features ?? null : null;
      out.push({ ...c, count, policy, error: c.error || index[c.id]?.error || null });
    }
    return {
      ownApp: entraSettings(settings).ownApp,
      signedIn: signedIn(),
      opened,
      hasFiles: settings.fileContainers.length > 0,
      pinSet: !!settings.appPin,
      offline: offlineMode,
      offlineAt: offlineMode ? offline?.at || null : null,
      signInMode: auth.useBroker?.() ? 'windows' : 'browser',
      requirePin: !!settings.requirePin,
      account: auth.account ? { name: auth.account.name, username: auth.account.username, tenantId: auth.account.tenantId } : null,
      containers: out,
      settings,
      version: app.getVersion(),
      updateKind: updater?.kind || 'dev',
      passkeyAvailable: process.platform === 'win32' || !!demo,
      platform: process.platform,
    };
  },
  updateSettings: async (patch) => {
    const before = config.get();
    const s = config.update(patch);
    applyLanguage();
    if (before.autoTypeKeys !== s.autoTypeKeys) applyShortcuts();
    if (before.startWithWindows !== s.startWithWindows) applyStartWithWindows();
    if (before.zoom !== s.zoom || before.transparency !== s.transparency) applyView();
    if (before.updateMode !== s.updateMode) {
      if (!UPDATE_MODES.includes(s.updateMode)) config.update({ updateMode: 'off' });
      updater?.applyMode();
      if (config.get().updateMode !== 'off') updater?.background();
    }
    if (before.browserIntegration !== s.browserIntegration || before.windowsProvider !== s.windowsProvider
      || JSON.stringify(before.extensionIds) !== JSON.stringify(s.extensionIds) || before.mcpEnabled !== s.mcpEnabled) await applyBrowserIntegration();
    if (before.mcpEnabled && !s.mcpEnabled) mcp?.revoke();
    return s;
  },
  /** entra: also sign in to Microsoft Entra ID (Key Vault containers). */
  async verifyPin(pin) {
    const record = config.get().appPin;
    if (!record) return true;
    const wait = pinGuard.waitSeconds();
    if (wait) throw new Error(t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
    if (await verifyPin(pin, record)) {
      pinGuard.success();
      if (config.get().pinGuard) config.update({ pinGuard: null });
      if (mirrorWanted()) await offlineMirror().unlockKey(pin).catch(() => {});
      return true;
    }
    pinGuard.failure();
    config.update({ pinGuard: pinGuard.toJSON() });
    throw new Error(pinGuard.waitSeconds() ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds: pinGuard.waitSeconds() }) : t('Falsche PIN'));
  },
  /** { current?, next } – next null removes the PIN (not when the organization requires one). */
  async setPin({ current, next }) {
    requireOpen();
    const s = config.get();
    if (s.appPin) await api.verifyPin(current);
    pinGuard.consume();
    // A mirror that cannot be re-keyed would stay readable with the old PIN: better none at all.
    if (s.offlineMirror && next) await offlineMirror().rekey(current, next).catch(() => offlineMirror().remove().catch(() => {}));
    if (!next) await offlineMirror().remove().catch(() => {});
    if (next == null) {
      if (s.requirePin) throw new Error(t('Eure Organisation verlangt eine PIN'));
      config.update({ appPin: null });
      return api.state();
    }
    if (String(next).length < MIN_PIN_LENGTH) throw new Error(t('Die PIN braucht mindestens {n} Zeichen', { n: MIN_PIN_LENGTH }));
    config.update({ appPin: await hashPin(next) });
    return api.state();
  },
  /** background: unlocked from the browser extension (PIN) – the window stays where it is. */
  async unlock({ entra = true, background = false } = {}) {
    requirePin();
    if (entra) {
      // With a PIN the silent sign-in from the encrypted token cache is enough; the Microsoft window only
      // appears when the tenant demands it (e.g. expired MFA). An unlock prompt enforced by policy stays.
      const silent = !!config.get().appPin && !config.get().enforced.includes('unlockPrompt');
      const canOffline = mirrorWanted() && offlineMirror().ready && (await offlineMirror().exists());
      if (canOffline && !net.isOnline()) return api.unlockOffline();
      try {
        await auth.unlock(silent ? 'none' : config.get().unlockPrompt);
      } catch (e) {
        if (canOffline && isNetworkError(e)) return api.unlockOffline();
        throw e;
      }
      if (!config.get().entraUsed) config.update({ entraUsed: true });
      if (!background) {
        win?.show();
        win?.focus();
      }
    }
    // Same account and kept data: show the state from memory at once, refresh in the background (concurrent
    // edits in the vault stay safe – every save checks the entry's version and reports a conflict).
    const kept = keptVault && entra && (auth.account?.homeAccountId || null) === keptAccount;
    keptVault = false;
    if (!kept) newSession();
    opened = true;
    if (!smokeTest && !demo) warmUpAutoType();
    applyShortcuts();
    if (kept) {
      refreshAll({ quick: true }).then(() => { if (opened) changed(); }).catch(() => {});
      changed();
      return api.state();
    }
    const discoverError = await refreshAll({ quick: true });
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Read-only session from the encrypted mirror (no network): the last state the app has seen. */
  async unlockOffline() {
    const mirror = offlineMirror();
    const info = await mirror.load();
    offlineMode = true;
    keptVault = false;
    newSession();
    opened = true;
    applyShortcuts();
    await vault.refreshContainers({ configured: mirror.containers.map((c) => ({ ...c, source: 'manual' })), discover: false, access: false });
    await vault.refreshIndex().catch(() => {});
    changed();
    return { ...(await api.state()), offlineAt: info.at };
  },
  async signIn() {
    await auth.unlock(config.get().unlockPrompt);
    win?.show();
    win?.focus();
    const discoverError = await refreshAll({ quick: true });
    changed();
    return { ...(await api.state()), discoverError };
  },
  lock: () => lockNow(),
  async signOut() {
    await lockNow();
    // Signing out ends the kept session: another account must never see the previous account's data.
    await vault.clear();
    newSession();
    keptVault = false;
    await offlineMirror().remove().catch(() => {});
    await auth.signOut();
  },
  /** Reloads one container (file from disk, Key Vault from the service). */
  async refreshContainer(containerId) {
    requireOpen();
    const c = await vault.container(containerId);
    if (c.kind === 'file') {
      send({ type: 'busy', containerId, busy: true });
      try {
        await files.get(containerId).load();
      } finally {
        send({ type: 'busy', containerId, busy: false });
      }
    } else {
      // Fast first: the index secrets (a few GETs, however many secrets the vault holds) – the list is current
      // right away. The full listing (pages of 25, slow with thousands of secrets) and the permissions follow in
      // the background, with a progress card; nothing waits for them.
      const id = `refresh:${containerId}`;
      const run = { name: c.name, started: Date.now(), pages: 0, secrets: 0 };
      send({ type: 'progress', id, label: t('„{name}“ wird abgeglichen …', { name: c.name }), step: 'fast', detail: t('Schnell-Index wird geladen …') });
      await vault.refreshIndexFast([containerId]);
      changed();
      refreshing.set(containerId, run);
      send({ type: 'progress', id, step: 'list', detail: t('Secrets werden aufgelistet …') });
      const session = vault;
      (async () => {
        try {
          await session.refreshIndex([containerId]);
          const listed = Date.now();
          // Diagnostics: many pages with few secrets point to a vault full of deleted or disabled secrets.
          if (listed - run.started > 3000) diag(`LIST ${containerId} pages=${run.pages} secrets=${run.secrets} ${listed - run.started}ms`);
          send({ type: 'progress', id, step: 'access', detail: t('Zugriffsrechte werden geprüft …'), total: 0 });
          await session.refreshAccess().catch(() => {});
          const entries = (await session.index())[containerId]?.items?.length ?? 0;
          send({ type: 'progress', id, step: 'done', detail: t('Fertig – {n} Einträge', { n: entries }) });
        } finally {
          refreshing.delete(containerId);
          send({ type: 'progress', id, end: true });
        }
        if (session === vault && opened) changed();
      })().catch(() => {});
    }
    changed();
    return api.state();
  },
  async refresh() {
    requireOpen();
    const discoverError = await refreshAll();
    return { ...(await api.state()), discoverError };
  },
  async items() {
    requireOpen();
    refreshStaleForBrowser().catch(() => {});
    return vault.summaries({ maxAgeMs: Infinity });
  },
  item: (containerId, id, fresh) => vault.getItem(containerId, id, { fresh }),
  save: async (containerId, item, expectedVersion) => {
    const saved = await vault.saveItem(containerId, item, { expectedVersion });
    config.update({ defaultContainer: containerId });
    return saved;
  },
  delete: (containerId, id) => vault.deleteItem(containerId, id),
  move: (fromId, toId, id) => vault.moveItem(fromId, toId, id),
  history: (containerId, id) => vault.history(containerId, id),
  version: (containerId, id, version) => vault.getVersion(containerId, id, version),
  restoreVersion: (containerId, id, version) => vault.restoreVersion(containerId, id, version),
  trash: (containerId) => vault.trash(containerId),
  restore: (containerId, id) => vault.restore(containerId, id),
  async purge(containerId, id) {
    await requireFeature(containerId, 'purge');
    return vault.purge(containerId, id);
  },

  // Key Vault containers
  async addContainer(input, name) {
    const invite = parseInvite(input);
    const id = vaultHost(invite.vaultUrl);
    const s = config.get();
    const containers = s.containers.filter((c) => vaultHost(c.vaultUrl) !== id);
    containers.push({ name: name || invite.name || id.split('.')[0], vaultUrl: invite.vaultUrl });
    config.update({ containers, hiddenContainers: s.hiddenContainers.filter((x) => x !== id) });
    if (opened) await refreshAll();
    return id;
  },
  async removeContainer(id) {
    const c = await vault.container(id).catch(() => null);
    if (c?.kind === 'file') {
      files.remove(id);
      return;
    }
    const s = config.get();
    config.update({
      containers: s.containers.filter((x) => vaultHost(x.vaultUrl) !== id),
      hiddenContainers: [...new Set([...s.hiddenContainers, id])],
    });
    if (opened) await refreshAll();
  },
  async invite(containerId) {
    return buildInvite(await vault.container(containerId));
  },
  members: async (containerId) => (await vault.azureForId(containerId)).listMembers(await containerResource(containerId)),
  /** Info dialog: Azure facts of the vault plus who administers it. */
  vaultInfo: async (containerId) => {
    requireOpen();
    const azure = await vault.azureForId(containerId);
    const resourceId = await containerResource(containerId);
    const [details, members] = await Promise.all([azure.vaultDetails(resourceId), azure.listMembers(resourceId).catch(() => [])]);
    return { ...details, admins: members.filter((m) => m.level === 'manage').map((m) => ({ displayName: m.displayName, detail: m.detail || '' })) };
  },
  addMember: async (containerId, principal, level) => (await vault.azureForId(containerId)).addMember(await containerResource(containerId), principal, level),
  removeMember: async (containerId, principalId) => (await vault.azureForId(containerId)).removeMember(await containerResource(containerId), principalId),
  /** People picker in the directory of the container's tenant (guests included). */
  searchPrincipals: async (query, containerId) => (containerId ? await vault.azureForId(containerId) : vault.azure).searchPrincipals(query),
  machineSetupStatus: () => machineSetupStatus(),
  /** Elevated device setup (UAC), then retry the per-user provider installation. */
  async runMachineSetup() {
    const code = await runMachineSetup();
    if (code) throw new Error(t('Die Einrichtung meldet Fehler (Code {code}) – Details im Protokoll setup.log unter ProgramData › Keevault', { code }));
    const status = config.get().windowsProvider ? await ensureProvider(`${app.getVersion()}.0`) : null;
    return { status, machine: await machineSetupStatus() };
  },
  vaultTenantCheck: async (containerId) => vault.azure.vaultTenantCheck(await containerResource(containerId)),
  async fixVaultTenant(containerId) {
    const resourceId = await containerResource(containerId);
    const check = await vault.azure.vaultTenantCheck(resourceId);
    if (!check.mismatch) return api.state();
    await vault.azure.setVaultTenant(resourceId, check.subscriptionTenant);
    await vault.learnTenant(containerId, check.subscriptionTenant);
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Diagnosis: the identity Key Vault sees (claims of the token for the vault's tenant). */
  async vaultIdentity(containerId) {
    const c = await vault.container(containerId);
    const claims = decodeJwtPayload(await auth.getToken(KV_SCOPE, c.tenantId ? { tenantId: c.tenantId } : {}));
    const name = claims.upn || claims.unique_name || claims.email || claims.preferred_username || '';
    return {
      tenantId: claims.tid,
      objectId: claims.oid,
      name,
      // acct 1 = guest; external identities also carry an idp claim pointing to their home tenant.
      guest: claims.acct === 1 || /#EXT#/i.test(name) || (!!claims.idp && !String(claims.idp).toLowerCase().includes(String(claims.tid).toLowerCase())),
      homeTenant: claims.idp?.match(/[0-9a-f-]{36}/)?.[0] || claims.tid,
    };
  },
  /** Owner of a vault without a data role (e.g. Owner on the subscription): grant yourself access. */
  /** Vault settings for the dialog: { admin, canBecomeAdmin, features, updated, updatedBy } */
  async policyState(containerId) {
    const c = await vault.container(containerId);
    const p = await vault.policy(containerId);
    return { admin: !!c.access?.admin, canBecomeAdmin: !c.access?.admin && !!c.access?.manage, ...p };
  },
  async setPolicy(containerId, features) {
    const c = await vault.container(containerId);
    if (!c.access?.admin) throw new Error(t('Nur Key Vault-Administratoren können die Tresor-Einstellungen ändern.'));
    const r = await vault.setPolicy(containerId, features);
    changed();
    return r;
  },
  /** Whoever may assign roles (Manage) can make themselves Key Vault Administrator. */
  async makeMeAdmin(containerId) {
    const azure = await vault.azureForId(containerId);
    await azure.assignRole(await containerResource(containerId), (await azure.me()).id, 'User', ROLES.kvAdministrator);
    await new Promise((r) => setTimeout(r, demo ? 0 : 8000));
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** CSV export of a vault's entries – only when an admin enabled it in the vault settings. */
  async exportItems(containerId) {
    requireOpen();
    const c = await requireFeature(containerId, 'export');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Einträge exportieren'),
      defaultPath: `${String(c.name || 'Tresor').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    const list = (await vault.summaries()).filter((s) => s.containerId === containerId);
    let done = 0;
    const items = await mapLimit(list, 4, async (s) => {
      const item = await vault.getItem(containerId, s.id, { fresh: true });
      send({ type: 'progress', done: ++done, total: list.length });
      return item;
    });
    await fs.writeFile(filePath, itemsToCsv(items), 'utf8');
    return { filePath, count: items.length };
  },
  async grantMyself(containerId, level = 'write') {
    const azure = await vault.azureForId(containerId);
    await azure.addMember(await containerResource(containerId), await azure.me(), level);
    // Azure RBAC takes a moment to apply.
    await new Promise((r) => setTimeout(r, demo ? 0 : 8000));
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Invites an external person as guest into the container's tenant and grants the chosen level. */
  async inviteGuest(containerId, email, level) {
    const azure = await vault.azureForId(containerId);
    const guest = await azure.inviteGuest(cleanEmail(email));
    const r = await azure.addMember(await containerResource(containerId), guest, level);
    return { ...r, guest };
  },
  tenants: () => vault.azure.listTenants(),
  async signInTenant(tenantId) {
    await auth.signInTenant(tenantId, KV_SCOPE);
    win?.show();
    win?.focus();
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /**
   * Key Vaults for the picker, from the own tenant and every guest tenant. Default: only vaults set up as
   * password containers on which the user has data access; all: every visible vault (no access check).
   */
  async vaults({ all = false } = {}) {
    const known = new Set((await vault.containers()).map((c) => c.id));
    const home = auth.account?.tenantId;
    const found = new Map();
    const collect = async (azure, tenantId) => {
      for (const v of await azure.listVaults()) {
        const id = vaultHost(v.vaultUrl);
        if (!found.has(id)) found.set(id, { ...v, tenantId: v.tenantId || tenantId, added: known.has(id) });
      }
    };
    await collect(vault.azure, home);
    const tenants = await vault.azure.listTenants().catch(() => []);
    await mapLimit(tenants.filter((x) => x.tenantId !== home), 3, (x) => collect(vault.azureFor({ tenantId: x.tenantId, silentOnly: true }), x.tenantId).catch(() => {}));
    let list = [...found.values()];
    if (!all) {
      // Only vaults with a readable container marker (pws-container): proves set-up + data access in one go.
      await mapLimit(list, 8, async (v) => {
        v.meta = v.added ? { name: v.name } : await vault.probeVault(v);
      });
      list = list.filter((v) => v.meta).map(({ meta, ...v }) => ({ ...v, name: meta.name || v.name, container: true }));
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  },
  /** Switches the directory (tenant) of the signed-in account; '' = the account's home directory. */
  async switchTenant(tenantId) {
    config.update({ tenantId });
    if (!signedIn()) return api.state();
    await auth.switchTenant();
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /**
   * Subscriptions for new containers: those of the signed-in tenant and of every tenant where the account is a
   * guest. via: 'home' (own tenant), 'guest' (customer tenant with guest account) or 'lighthouse' (only
   * visible through Azure Lighthouse – no data roles, no guests possible there).
   */
  async subscriptions() {
    const home = auth.account?.tenantId;
    const out = new Map();
    for (const s of await vault.azure.listSubscriptions()) {
      if (s.state !== 'Enabled') continue;
      // Lighthouse: the subscription belongs to the customer's tenant but is reached with tokens of the home tenant –
      // so ARM calls (resource groups, locations) use the home tenant; customerTenantId only for display.
      const lighthouse = !!s.tenantId && s.tenantId !== home;
      out.set(s.subscriptionId, { id: s.subscriptionId, name: s.displayName, tenantId: home, customerTenantId: lighthouse ? s.tenantId : null, via: lighthouse ? 'lighthouse' : 'home' });
    }
    const tenants = await vault.azure.listTenants().catch(() => []);
    await mapLimit(tenants.filter((x) => x.tenantId !== home), 3, async (x) => {
      try {
        for (const s of await vault.azureFor({ tenantId: x.tenantId, silentOnly: true }).listSubscriptions()) {
          if (s.state === 'Enabled') out.set(s.subscriptionId, { id: s.subscriptionId, name: s.displayName, tenantId: x.tenantId, via: 'guest', tenantName: x.name });
        }
      } catch {
        // No silent token for that tenant: its subscriptions stay as seen from home (if at all).
      }
    });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
  resourceGroups: async (subscriptionId, tenantId) => (await azureForSubscription(tenantId).listResourceGroups(subscriptionId))
    .map((g) => ({ name: g.name, location: g.location }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  locations: (subscriptionId, tenantId) => azureForSubscription(tenantId).listLocations(subscriptionId),
  /** Rights in a resource group: may a new vault be created / roles be assigned there? */
  groupPermissions: (subscriptionId, tenantId, resourceGroup) => azureForSubscription(tenantId).groupPermissions(subscriptionId, resourceGroup),
  /** Vaults of a resource group with their state (readable, already a container, empty). */
  async groupVaults(subscriptionId, tenantId, resourceGroup) {
    const vaults = await azureForSubscription(tenantId).listVaultsInGroup(subscriptionId, resourceGroup);
    const known = new Set((await vault.containers()).map((c) => c.id));
    return mapLimit(vaults, 6, async (v) => ({ ...v, added: known.has(vaultHost(v.vaultUrl)), ...(await vault.inspectVault({ ...v, tenantId: v.tenantId || tenantId })) }));
  },
  /**
   * Uses an existing, empty vault as container: marks it (pws-container), names it and grants access.
   * opts: { subscriptionId, tenantId, via, vaultUrl, resourceId, displayName, members, guests }
   */
  async adoptVault(opts) {
    if (!signedIn()) throw new LockedError();
    if (opts.via === 'lighthouse') throw new Error(t('Über Azure Lighthouse lässt sich hier kein nutzbarer Tresor anlegen (siehe Hinweis).'));
    const tenantId = opts.tenantId || auth.account.tenantId;
    const azure = azureForSubscription(tenantId);
    const state = await vault.inspectVault({ vaultUrl: opts.vaultUrl, tenantId });
    if (!state.readable) throw new Error(t('Auf diesen Key Vault hast du keinen Datenzugriff ({message})', { message: state.error || '403' }));
    if (!state.empty && !state.marked) throw new Error(t('Der Key Vault ist nicht leer – bitte einen leeren wählen oder einen neuen anlegen'));
    await vault.initVault({ vaultUrl: opts.vaultUrl, tenantId, name: opts.displayName });
    const warnings = [];
    await azure.setVaultDisplayName(opts.resourceId, opts.displayName).catch(() => {});
    for (const m of opts.members || []) {
      await azure.addMember(opts.resourceId, m.principal, m.level).catch((e) => warnings.push(t('{who}: {message}', { who: m.principal.displayName, message: e.message })));
    }
    for (const g of opts.guests || []) {
      try {
        await azure.addMember(opts.resourceId, await azure.inviteGuest(cleanEmail(g.email)), g.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: g.email, message: e.message }));
      }
    }
    const s = config.get();
    const id = vaultHost(opts.vaultUrl);
    config.update({ containers: [...s.containers.filter((c) => vaultHost(c.vaultUrl) !== id), { name: opts.displayName, vaultUrl: opts.vaultUrl, tenantId }] });
    await refreshAll();
    return { id, warnings };
  },
  /** People picker in a given tenant (new container in a customer tenant). */
  searchPrincipalsIn: (query, tenantId) => azureForSubscription(tenantId).searchPrincipals(query),
  /**
   * opts: { subscriptionId, tenantId, via, resourceGroup, location, name, displayName, purgeProtection,
   *   members: [{ principal, level }], guests: [{ email, level }] }
   */
  async createContainer(opts) {
    if (!signedIn()) throw new LockedError();
    if (opts.via === 'lighthouse') {
      throw new Error(t('Diese Subscription siehst du nur über Azure Lighthouse. Ein Key Vault, auf den ihr zugreifen könnt, muss im Kunden-Tenant angelegt werden: Lass dich dort als Gast einladen und gib deinem Gastkonto Besitzer (oder Mitwirkender + Benutzerzugriffsadministrator) auf der Ressourcengruppe.'));
    }
    // The vault must trust the tenant the subscription belongs to; in a customer tenant we act as guest.
    const sub = await azureForSubscription(opts.tenantId).arm('GET', `/subscriptions/${opts.subscriptionId}`, '2022-12-01');
    const tenantId = sub?.tenantId || opts.tenantId || auth.account.tenantId;
    const foreign = tenantId !== auth.account.tenantId;
    const azure = azureForSubscription(tenantId);
    const creatorObjectId = foreign ? (await azure.me()).id : auth.account.localAccountId;
    const result = await azure.createContainer({ ...opts, tenantId, creatorObjectId });
    const warnings = [...result.warnings];
    for (const m of opts.members || []) {
      try {
        await azure.addMember(result.container.resourceId, m.principal, m.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: m.principal.displayName, message: e.message }));
      }
    }
    for (const g of opts.guests || []) {
      try {
        await azure.addMember(result.container.resourceId, await azure.inviteGuest(cleanEmail(g.email)), g.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: g.email, message: e.message }));
      }
    }
    const s = config.get();
    config.update({ containers: [...s.containers, { name: result.container.name, vaultUrl: result.container.vaultUrl, ...(foreign ? { tenantId } : {}) }] });
    // New role assignments take a few minutes: mark the vault as container (pws-container) in the background.
    (async () => {
      for (let i = 0; i < 20; i++) {
        try {
          await vault.initVault({ vaultUrl: result.container.vaultUrl, tenantId, name: result.container.name });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    })();
    await refreshAll();
    const id = vaultHost(result.container.vaultUrl);
    if (foreign) await vault.learnTenant(id, tenantId);
    return { id, warnings };
  },

  // File containers
  async chooseNewFile(name) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Neuen Datei-Tresor speichern'),
      defaultPath: `${String(name || 'Keevault').replace(/[^\w.-]+/g, '_')}.${FILE_EXTENSION}`,
      filters: [{ name: 'Keevault', extensions: [FILE_EXTENSION] }],
    });
    return canceled ? null : filePath;
  },
  /** { path, name, password?, passkeyLabel? } → { id, recoveryKey } */
  async createFile({ path: filePath, name, password, passkeyLabel }) {
    const passkey = passkeyLabel ? await registerPasskey(name, passkeyLabel) : null;
    const r = await files.create(filePath, name, { password, passkey }, actor());
    opened = true;
    return r;
  },
  async openFile() {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('Datei-Tresor öffnen'),
      filters: [{ name: 'Keevault', extensions: [FILE_EXTENSION] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    return files.open(filePaths[0]);
  },
  renameFile: (id, name) => files.rename(id, name),
  /**
   * Renames a container: file → inside the file (everyone sees it); Key Vault → tag on the vault if the rights
   * allow (everyone sees it), in any case for this app.
   */
  async renameContainer(containerId, name) {
    await requireFeature(containerId, 'rename');
    const clean = String(name || '').trim();
    if (!clean) throw new Error(t('Bitte einen Namen eingeben'));
    const c = await vault.container(containerId);
    let warning = null;
    if (c.kind === 'file') {
      await files.rename(containerId, clean);
    } else {
      try {
        await vault.azureFor(c).setVaultDisplayName(await containerResource(containerId), clean);
      } catch (e) {
        warning = t('Nur für dich umbenannt – für alle bräuchte es Schreibrechte auf der Key-Vault-Ressource ({message})', { message: e.message });
      }
      const s = config.get();
      const others = s.containers.filter((x) => vaultHost(x.vaultUrl) !== containerId);
      const own = s.containers.find((x) => vaultHost(x.vaultUrl) === containerId);
      config.update({ containers: [...others, { ...(own || {}), name: clean, vaultUrl: c.vaultUrl, ...(c.tenantId ? { tenantId: c.tenantId } : {}) }] });
      await refreshAll();
    }
    changed();
    return { warning };
  },
  showFile: async (id) => {
    const c = (await files.containers()).find((x) => x.id === id);
    if (c) shell.showItemInFolder(c.path);
  },

  // Protection (Key Vault containers optional, file containers always)
  protectionInfo: (containerId) => vault.protectionInfo(containerId, RP_ID),
  unlockContainer: async (containerId, params) => {
    const r = await vault.unlockContainer(containerId, params);
    changed();
    return r;
  },
  async unlockContainerPasskey(containerId) {
    const { c, info } = await protectionCtx(containerId);
    if (!info.passkeys.length) throw new Error(t('Für diese App ist kein Passkey registriert'));
    const prf = await passkeyCeremony({ mode: 'evaluate', containerName: c.name, passkeys: info.passkeys, autoStart: !smokeTest });
    const r = await vault.unlockContainer(containerId, { credentialId: prf.credentialId, prfOutput: prf.prfOutput });
    changed();
    return r;
  },
  async enableProtection(containerId, { password, passkeyLabel }) {
    await requireFeature(containerId, 'protection');
    const c = await vault.container(containerId);
    const passkey = passkeyLabel ? await registerPasskey(c.name, passkeyLabel) : null;
    const r = await vault.enableProtection(containerId, { password, passkey }, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  updateProtection: (containerId, op) => vault.updateProtection(containerId, op),
  async addContainerPasskey(containerId, label) {
    const { c, info } = await protectionCtx(containerId);
    const passkey = await registerPasskey(c.name, label, info.passkeys.map((p) => p.credentialId));
    return vault.updateProtection(containerId, { type: 'addPasskey', passkey });
  },
  disableProtection: async (containerId) => {
    await requireFeature(containerId, 'protection');
    const r = await vault.disableProtection(containerId, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  lockContainer: async (containerId) => {
    await vault.lockContainer(containerId);
    changed();
  },

  // Secured files (passkey only, members with roles)
  /** { path, name, email, attachment } → { id } */
  async createSecureFile({ path: filePath, name, email, attachment }) {
    const passkey = await registerPasskey(name, cleanEmail(email), [], attachment);
    const r = await files.createSecure(filePath, name, { email: cleanEmail(email), passkey });
    config.update({ fileEmail: cleanEmail(email) });
    opened = true;
    changed();
    return r;
  },
  async requestFileAccess(containerId, { email, attachment }) {
    const c = await vault.container(containerId);
    const passkey = await registerPasskey(c.name, cleanEmail(email), [], attachment);
    config.update({ fileEmail: cleanEmail(email) });
    return files.requestAccess(containerId, { email: cleanEmail(email), passkey });
  },
  fileMembers: (containerId) => files.members(containerId, RP_ID),
  async fileMemberOp(containerId, op) {
    if (op.type === 'addCredential') {
      const c = await vault.container(containerId);
      const info = await files.protectionInfo(containerId, RP_ID);
      const me = (await files.members(containerId, RP_ID)).members.find((m) => m.me);
      const passkey = await registerPasskey(c.name, me.email, info.passkeys.map((p) => p.credentialId), op.attachment);
      return files.memberOp(containerId, { type: 'addCredential', passkey });
    }
    return files.memberOp(containerId, op);
  },
  async migrateFile(containerId, { email, attachment }) {
    const c = await vault.container(containerId);
    const passkey = await registerPasskey(c.name, cleanEmail(email), [], attachment);
    config.update({ fileEmail: cleanEmail(email) });
    return files.migrate(containerId, { email: cleanEmail(email), passkey });
  },
  async changelog(containerId, itemId) {
    const c = await vault.container(containerId);
    return c.kind === 'file' ? files.changelog(containerId, itemId) : [];
  },
  folders: (containerId) => vault.folders(containerId),
  licenseState: (containerId) => vault.licenseState(containerId),
  async setLicense(containerId, key) {
    const r = await vault.setContainerLicense(containerId, key);
    changed();
    return r;
  },
  async duplicate(containerId, id) {
    requireOpen();
    const r = await vault.duplicateItem(containerId, id);
    changed();
    return r;
  },
  // Encrypted backups: only for owners of the vault's subscription. The password is generated here, handed to the
  // renderer once for display/printing and forgotten when the dialog closes.
  backupAllowed: async (containerId) => {
    try {
      await requireSubscriptionOwner(containerId);
      return { allowed: true };
    } catch (e) {
      return { allowed: false, reason: e.message };
    }
  },
  async createBackup(containerId) {
    requireOpen();
    const c = await requireSubscriptionOwner(containerId);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Backup speichern'),
      defaultPath: `${String(c.name || 'Tresor').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXTENSION}`,
      filters: [{ name: t('Keevault-Backup'), extensions: [BACKUP_EXTENSION] }],
    });
    if (canceled || !filePath) return null;
    const data = await vault.backupSecrets(containerId, (done, total) => send({ type: 'progress', done, total }));
    const password = generateBackupPassword();
    const content = await createBackup({ ...data, password, createdBy: actor() });
    await fs.writeFile(filePath, content, 'utf8');
    lastBackup = { password, vault: c.id, name: c.name, file: path.basename(filePath), created: JSON.parse(content).created, count: data.secrets.length, by: actor() };
    return { ...lastBackup, filePath };
  },
  async printBackupSheet() {
    if (!lastBackup) throw new Error(t('Das Passwort wurde bereits verworfen'));
    await printHtml(backupSheetHtml(lastBackup));
    return true;
  },
  forgetBackupPassword() {
    lastBackup = null;
    return true;
  },
  async chooseBackupFile(containerId) {
    requireOpen();
    await requireSubscriptionOwner(containerId);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('Backup öffnen'),
      filters: [{ name: t('Keevault-Backup'), extensions: [BACKUP_EXTENSION] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const text = await fs.readFile(filePaths[0], 'utf8');
    const header = readBackupHeader(text);
    pendingRestore = { containerId, text };
    return { ...header, file: path.basename(filePaths[0]) };
  },
  async restoreBackup(containerId, password) {
    requireOpen();
    await requireSubscriptionOwner(containerId);
    if (!pendingRestore || pendingRestore.containerId !== containerId) throw new Error(t('Bitte die Backup-Datei erneut auswählen'));
    const { header, secrets } = await openBackup(pendingRestore.text, password);
    const r = await vault.restoreSecrets(containerId, { vault: header.vault, secrets, isProtected: header.protected }, (done, total) => send({ type: 'progress', done, total }));
    pendingRestore = null;
    changed();
    return r;
  },
  containerLogo: (containerId) => vault.containerLogo(containerId),
  async setContainerLogo(containerId, dataUrl) {
    await requireFeature(containerId, 'logo');
    await vault.setContainerLogo(containerId, dataUrl);
    changed();
  },
  async addFolder(containerId, folderPath) {
    await requireFeature(containerId, 'folders');
    await vault.addFolder(containerId, folderPath);
    changed();
  },
  async removeFolder(containerId, folderPath) {
    await requireFeature(containerId, 'folders');
    await vault.removeFolder(containerId, folderPath);
    changed();
  },
  /**
   * Renames a folder incl. subfolders and moves its entries along. to = '' moves everything one level up
   * (used when deleting a folder that still has content). Returns { moved, errors }.
   */
  async renameFolder(containerId, from, to) {
    requireOpen();
    await requireFeature(containerId, 'folders');
    const clean = (p) => String(p || '').split('/').map((x) => x.trim()).filter(Boolean).join('/');
    const src = clean(from);
    const dst = clean(to);
    if (!src) throw new Error(t('Bitte einen Ordnernamen eingeben'));
    if (dst === src) return { moved: 0, errors: [] };
    if (dst.startsWith(`${src}/`)) throw new Error(t('Ein Ordner kann nicht in sich selbst verschoben werden'));
    const map = (p) => (p === src ? dst : p.startsWith(`${src}/`) ? clean(`${dst}/${p.slice(src.length + 1)}`) : p);
    // Nothing may end up deeper than the allowed folder levels – checked before anything changes.
    const inTree = (p) => p === src || p.startsWith(`${src}/`);
    const treePaths = [...(await vault.folders(containerId)), ...(await vault.summaries()).filter((s) => s.containerId === containerId).map((s) => s.folder || '')];
    for (const p of treePaths.filter(inTree)) requireFolderDepth(map(p));
    // Explicit (possibly empty) folders: add the new paths, then drop the old tree.
    for (const f of await vault.folders(containerId)) {
      if ((f === src || f.startsWith(`${src}/`)) && map(f)) await vault.addFolder(containerId, map(f));
    }
    await vault.removeFolder(containerId, src);
    const errors = [];
    let moved = 0;
    const affected = (await vault.summaries()).filter((s) => s.containerId === containerId && (s.folder === src || (s.folder || '').startsWith(`${src}/`)));
    await mapLimit(affected, 4, async (s) => {
      try {
        const item = await vault.getItem(containerId, s.id, { fresh: true });
        await vault.saveItem(containerId, { ...item, folder: map(item.folder || '') }, { expectedVersion: item.version });
        moved++;
      } catch (e) {
        errors.push(`${s.title}: ${e.message}`);
      }
    });
    changed();
    return { moved, errors };
  },

  copy: (text) => copyToClipboard(String(text)),
  /**
   * Auto-type for Strg+Umschalt+U/P/O: minimizes the app so that the previous window gets the focus back and
   * types user name, password or current one-time code there – no clipboard involved.
   */
  /** Types a freshly generated password into the previous window (generator dialog). */
  async typeGenerated(text) {
    if (!text) return false;
    if (smokeTest) {
      autoTypeCalls.push('generated');
      return true;
    }
    win?.minimize();
    await new Promise((r) => setTimeout(r, 400));
    await typeText(String(text));
    return true;
  },
  /** The renderer reports the selected entry; global auto-type uses it. */
  selectItem: (key) => {
    selectedKey = key || null;
  },
  async autoType(containerId, itemId, what) {
    requireOpen();
    const value = await autoTypeValue(`${containerId}/${itemId}`, what);
    // Tests: never type into the desktop of whoever runs them – only record the call.
    if (smokeTest) {
      autoTypeCalls.push(what);
      return true;
    }
    win?.minimize();
    await new Promise((r) => setTimeout(r, 400));
    await typeText(value);
    return true;
  },
  openExternal: (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  },
  // No export: entries never leave the app as a plain file (only encrypted owner backups, see createBackup). The only file the
  // app writes on request is the built-in import sample – never content passed in by the renderer.
  /** The certificate file of one entry, on explicit request (Save as…) – the file itself is what the entry holds. */
  async saveCertificate(name, data) {
    requireOpen();
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length || bytes.length > CERT_MAX_BYTES) throw new Error(t('Ungültige Zertifikatsdatei'));
    const safeName = String(name || 'zertifikat.pfx').replace(/[\\/:*?"<>|]+/g, '_');
    const ext = (safeName.match(/\.([a-z0-9]+)$/i) || [])[1];
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Zertifikat speichern'),
      defaultPath: safeName,
      filters: ext ? [{ name: t('Zertifikat'), extensions: [ext] }] : [],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, bytes);
    return filePath;
  },
  async saveSampleCsv() {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'kvpwsafe-import-sample.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, SAMPLE_CSV, 'utf8');
    return filePath;
  },
  async importItems(containerId, items) {
    requireOpen();
    await requireFeature(containerId, 'import');
    // At most three folder levels: deeper source folders are cut ("A/B/C/D" → "A/B/C").
    items = items.map((i) => ({ ...i, folder: limitFolderDepth(i.folder) }));
    const errors = [];
    let done = 0;
    await mapLimit(items, 4, async (item) => {
      try {
        await vault.saveItem(containerId, { ...item, id: '' });
      } catch (e) {
        errors.push(`${item.title}: ${e.message}`);
      }
      send({ type: 'progress', done: ++done, total: items.length });
    });
    changed();
    return { imported: items.length - errors.length, errors };
  },
  // Windows passkey provider
  windowsRequests: () => windows.list(),
  windowsDecision: async (id, decision) => {
    await windows.decide(id, decision);
    if (!windows.pending.size) restoreAfterWindowsRequest();
  },
  windowsProviderStatus: () => providerStatus(),
  async windowsProviderRegister() {
    const r = await registerProvider();
    await windows.sync().catch(() => {});
    return r;
  },
  openWindowsPasskeySettings: () => shell.openExternal('ms-settings:savedpasskeys'),
  updateState: () => updater?.state || null,
  checkForUpdates: () => updater.check(),
  installUpdate: () => updater.installNow(),
  mcpInfo: () => ({
    enabled: !!config.get().mcpEnabled,
    tools: MCP_TOOLS.map((x) => x.title),
    agents: config.get().approvedAgents,
    rules: config.get().agentRules || {},
    sessions: mcp?.activeSessions() || [],
    ...mcpClientConfig({ command: launchPath(), script: mcpScriptPath() }),
  }),
  mcpRemoveAgent: (agent) => {
    const rules = { ...config.get().agentRules };
    delete rules[agent];
    config.update({ approvedAgents: config.get().approvedAgents.filter((x) => x !== agent), agentRules: rules });
    mcp?.revoke(agent);
    return true;
  },
  /** Rights of an agent: write yes/no, approval for `days` days (0 = until removed). */
  /** Answer to a question from askInApp (agent approvals). */
  answerQuestion: (id, value) => {
    const resolve = questions.get(id);
    if (!resolve) return false;
    questions.delete(id);
    resolve(String(value));
    return true;
  },
  mcpAgentRule: (agent, { write, days }) => {
    const current = config.get().agentRules?.[agent] || { write: true, until: null };
    const rule = {
      write: typeof write === 'boolean' ? write : current.write,
      until: days === undefined ? current.until : (Number(days) > 0 ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null),
    };
    config.update({ agentRules: { ...config.get().agentRules, [agent]: rule } });
    if (rule.write === false) mcp?.revoke(agent);
    return rule;
  },
  /** Password health over the given vaults (all open ones when empty); hibp: also ask Have I Been Pwned. */
  async healthReport({ containerIds = [], hibp = false } = {}) {
    requireOpen();
    const wanted = (await vault.summaries()).filter((s) => (!containerIds.length || containerIds.includes(s.containerId)) && s.type !== 'note');
    const items = [];
    let skipped = 0;
    let done = 0;
    await mapLimit(wanted, 6, async (s) => {
      try {
        items.push(await vault.getItem(s.containerId, s.id));
      } catch {
        skipped++; // locked (protected) vault or transient error
      }
      send({ type: 'progress', id: 'healthReport', done: ++done, total: wanted.length });
    });
    if (hibp) {
      const ranges = new Map(); // prefix → response text (several passwords can share a prefix)
      await mapLimit(items.filter((i) => i.password), 4, async (i) => {
        const { prefix, suffix } = await hibpParts(i.password);
        if (!ranges.has(prefix)) {
          ranges.set(prefix, secureFetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Keevault' } })
            .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HIBP HTTP ${res.status}`)))));
        }
        i.pwnedCount = hibpCount(await ranges.get(prefix), suffix);
      });
    }
    return { ...passwordReport(items), skipped, hibp };
  },
  /** Who may do what in the Key Vault vaults (role assignments incl. inherited ones) – for audits. */
  async accessReport() {
    requireOpen();
    const rows = [];
    const containers = (await vault.containers()).filter((c) => c.kind === 'keyvault' && !c.error);
    let done = 0;
    await mapLimit(containers, 3, async (c) => {
      send({ type: 'progress', id: 'accessReport', done, total: containers.length });
      try {
        const members = await (await vault.azureForId(c.id)).listMembers(await containerResource(c.id));
        for (const m of members) {
          rows.push({
            vault: c.name, vaultUrl: c.vaultUrl, principal: m.displayName, detail: m.detail || '', type: m.principalType || '', level: m.level,
            roles: m.assignments.map((a) => a.label + (a.inherited ? ` (${t('vererbt')})` : '')),
          });
        }
      } catch (e) {
        rows.push({ vault: c.name, vaultUrl: c.vaultUrl, error: e.message });
      }
      send({ type: 'progress', id: 'accessReport', done: ++done, total: containers.length });
    });
    rows.sort((a, b) => a.vault.localeCompare(b.vault) || (a.principal || '').localeCompare(b.principal || ''));
    return { created: new Date().toISOString(), by: actor(), rows };
  },
  /** Diagnostics log in the profile (no secret values): renderer errors, passkey failures. Rotates at 1 MB. */
  async log({ level = 'error', message = '', detail = '' }) {
    const file = path.join(app.getPath('userData'), 'keevault.log');
    try {
      if ((await fs.stat(file).catch(() => null))?.size > 1_000_000) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, `${new Date().toISOString()} ${level} ${String(message).slice(0, 500)}${detail ? ` | ${String(detail).slice(0, 1500)}` : ''}
`);
    } catch {
      // Logging must never fail the app.
    }
    return true;
  },
  /** Saves a text file (CSV) where the user chooses. */
  async saveTextFile({ name, text }) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '_')) });
    if (canceled || !filePath) return false;
    await fs.writeFile(filePath, String(text), 'utf8');
    return true;
  },
  /** Renders a report page off-screen and saves it as PDF. */
  async saveReportPdf({ name, html }) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '_')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (canceled || !filePath) return false;
    const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    try {
      await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html))}`);
      await fs.writeFile(filePath, await page.webContents.printToPDF({ printBackground: true, landscape: true }));
    } finally {
      page.destroy();
    }
    return true;
  },

};

ipcMain.handle('api', async (event, method, args) => {
  if (!event.senderFrame?.url.startsWith('app://pwsafe/')) return { ok: false, error: { message: 'Nicht erlaubt' } };
  const fn = Object.hasOwn(api, method) ? api[method] : null;
  if (!fn) return { ok: false, error: { message: `Unknown function ${method}` } };
  try {
    return { ok: true, result: await fn(...(Array.isArray(args) ? args : [])) };
  } catch (e) {
    if (e instanceof LockedError && method !== 'unlock') await lockNow();
    return { ok: false, error: { name: e.name, message: e.message, status: e.status } };
  }
});

function handleLink(url) {
  if (!/^kvpwsafe:\/\//i.test(url || '')) return;
  // kvpwsafe://open: started by the browser extension through the Windows shell – just be there, no dialog.
  if (/^kvpwsafe:\/\/open\/?$/i.test(url)) return;
  win?.show();
  win?.focus();
  send({ type: 'link', url });
}

let tray = null;

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Icon next to the clock: the app (passkeys via Windows and the browser) keeps running without a window. */
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(here, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Keevault');
  const menu = () => Menu.buildFromTemplate([
    { label: t('Öffnen'), click: showWindow },
    { label: t('Passwort-Generator'), click: () => {
      showWindow();
      send({ type: 'generator' });
    } },
    { label: t('Passwort-Check'), enabled: opened, click: () => {
      showWindow();
      send({ type: 'health' });
    } },
    { label: t('Zugriffsbericht'), enabled: opened, click: () => {
      showWindow();
      send({ type: 'access' });
    } },
    { label: t('Sperren'), enabled: opened, click: () => lockNow() },
    { label: t('Nach Updates suchen …'), click: () => {
      showWindow();
      send({ type: 'checkUpdates' });
    } },
    { type: 'separator' },
    { label: t('Beenden'), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    title: 'Keevault',
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    // Windows: no title bar – the app's ground colour runs up to the top edge with the logo top left; minimise,
    // maximise and close stay native as an overlay top right (colours follow light/dark).
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  if (process.platform === 'win32') {
    const recolor = () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarColors()); };
    nativeTheme.on('updated', recolor);
    win.once('closed', () => nativeTheme.off('updated', recolor));
  }
  win.loadURL('app://pwsafe/desktop/renderer/index.html');
  win.webContents.on('did-finish-load', applyView);
  win.once('ready-to-show', () => {
    // Started with Windows (setting "Start with Windows"): only in the tray, the window opens on demand.
    if (!smokeTest && !process.argv.includes('--background')) win.show();
  });
  // First start after an update from the update window (windows/Setup): the success animation with the new version.
  if (process.argv.some((x) => x.startsWith('--updated-from='))) {
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      if (win?.isVisible()) send({ type: 'passkeyFlash', text: t('Aktualisiert auf {version}', { version: app.getVersion() }) });
    }, 900));
  }
  // Closing hides the window; the app stays in the notification area until "Beenden".
  win.on('close', (e) => {
    if (quitting || smokeTest || !tray) return;
    e.preventDefault();
    win.hide();
    if (!config.get().trayHintShown) {
      config.update({ trayHintShown: true });
      tray.displayBalloon({ title: 'Keevault', content: t('Läuft im Infobereich weiter – Passkeys funktionieren auch ohne Fenster. Beenden über das Symbol neben der Uhr.') });
    }
  });
  win.on('closed', () => {
    win = null;
  });
  const link = process.argv.find((a) => a.startsWith('kvpwsafe://'));
  if (link) win.webContents.once('did-finish-load', () => handleLink(link));
}

app.on('second-instance', (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  handleLink(argv.find((a) => a.startsWith('kvpwsafe://')));
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleLink(url);
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  config = new Config();
  pinGuard.restore(config.get().pinGuard);
  applyLanguage();
  auth = demo ? new DemoAuth() : new Auth({
    cachePath: path.join(app.getPath('userData'), 'msal-cache.bin'),
    getConfig: () => config.get(),
    getWindowHandle: () => {
      // The Windows sign-in dialog needs a visible parent window.
      if (!win) createWindow();
      if (!win.isVisible()) win.show();
      return win.getNativeWindowHandle();
    },
  });
  files = new FileContainers({
    paths: () => config.get().fileContainers,
    setPaths: (paths) => config.update({ fileContainers: paths }),
    pins: () => config.get().fileIds,
    setPins: (fileIds) => config.update({ fileIds }),
    onChange: () => changed(),
  });
  await files.load();
  newSession();
  windows = new WindowsProvider({
    vault: () => vault,
    isOpen: () => opened,
    actor,
    show: () => {
      if (!win) return;
      // Remember how the window was before the passkey request, to restore that afterwards.
      if (windowStateBeforeRequest == null) windowStateBeforeRequest = !win.isVisible() ? 'hidden' : win.isMinimized() ? 'minimized' : 'shown';
      if (win.isMinimized()) win.restore();
      win.show();
      win.setAlwaysOnTop(true);
      win.focus();
    },
    notify: () => {
      send({ type: 'windows-request' });
      if (!windows?.pending.size) restoreAfterWindowsRequest();
    },
  });
  if (app.isPackaged) app.setAsDefaultProtocolClient('kvpwsafe');
  applyBrowserIntegration().catch(() => {});
  if (app.isPackaged && !demo && !smokeTest) setupWindowsProvider().catch(() => {});

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'pwsafe') return new Response('Not found', { status: 404 });
    return serve(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  });

  // Auto-lock after system-wide inactivity, on screen lock and on suspend.
  setInterval(() => {
    const minutes = Number(config.get().autoLockMinutes) || 0;
    if (opened && minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lockNow();
  }, 30_000);
  // Pending index writes (debounced) go out before the app quits.
  let flushedBeforeQuit = false;
  app.on('before-quit', (e) => {
    if (flushedBeforeQuit || !opened || offlineMode || demo) return;
    e.preventDefault();
    flushedBeforeQuit = true;
    vault.flushFastIndex().catch(() => {}).finally(() => app.quit());
  });
  powerMonitor.on('lock-screen', () => lockNow());
  powerMonitor.on('suspend', () => lockNow());

  createWindow();
  if (!smokeTest) createTray();
  mcp = new McpService({
    vault: () => (opened ? vault : null),
    confirmRead: confirmAgentRead,
    confirmWrite: confirmAgentWrite,
    policy: (agent) => config.get().agentRules?.[agent] || { write: true },
    scope: () => {
      const s = config.get();
      const scopes = (Array.isArray(s.mcpScopes) ? s.mcpScopes : []).filter((x) => x && typeof x.vaultId === 'string')
        .map((x) => ({ vaultId: x.vaultId, folder: normalizeFolder(x.folder || '') }));
      return { all: s.mcpScope === 'all', scopes };
    },
    audit: auditAgent,
  });
  updater = new Updater({
    mode: () => (smokeTest ? 'off' : config.get().updateMode),
    selfUpdate: () => config.get().selfUpdate !== false,
    onState: (state) => send({ type: 'update', state }),
    // New version at start (mode "ask"): the renderer shows the update dialog with the release notes.
    offer: (state) => {
      if (smokeTest) return;
      showWindow();
      send({ type: 'updateOffer', state });
    },
    // Nobody working in the app: locked, or only in the tray.
    isIdle: () => !opened || !win?.isVisible(),
    beforeInstall: () => { quitting = true; },
    // The update window appears centered on the app window (DIP, like WPF).
    windowCenter: () => {
      if (!win || win.isDestroyed() || !win.isVisible()) return null;
      const b = win.getBounds();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
    fetch: secureFetch,
  });
  updater.start();
  applyStartWithWindows();
  excludeFromErrorReporting();
  if (smokeTest) runSmokeTest();
});

app.on('window-all-closed', () => {
  // With the tray icon the app keeps running; without (tests) it ends with its window.
  if (tray && !quitting) return;
  files?.close();
  bridge?.stop();
  app.quit();
});

// ---------------------------------------------------------------- smoke test (CI and development)

async function virtualAuthenticator(contents) {
  const dbg = contents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
  await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
}

function runSmokeTest() {
  const errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed: ${code} ${desc}`));
  // The passkey window gets a virtual authenticator (with PRF); every ceremony is started automatically.
  app.on('browser-window-created', (_e, w) => {
    let attached = false;
    w.webContents.on('did-finish-load', async () => {
      if (!w.webContents.getURL().startsWith('http://localhost/')) return;
      try {
        if (!attached) {
          attached = true;
          await virtualAuthenticator(w.webContents);
          if (process.env.KVPWSAFE_SMOKE_DEBUG) {
            console.log('[smoke] virtual authenticator attached');
            w.webContents.on('console-message', (e) => console.log(`[passkey window] ${e.message}`));
          }
        }
        if (process.env.KVPWSAFE_SMOKE_DEBUG) {
          await w.webContents.executeJavaScript(`for (const m of ['create', 'get']) {
            const orig = navigator.credentials[m].bind(navigator.credentials);
            navigator.credentials[m] = (o) => { console.warn('[page] ' + m + ' called'); return orig(o).then((r) => { console.warn('[page] ' + m + ' ok ' + JSON.stringify(r.getClientExtensionResults())); return r; }, (e) => { console.warn('[page] ' + m + ' failed ' + e.name + ' ' + e.message); throw e; }); };
          }; true`);
        }
        // The page fetches its request asynchronously; wait for the start button.
        await w.webContents.executeJavaScript(`new Promise((resolve) => {
          const timer = setInterval(() => {
            const b = document.querySelector('.actions .btn.primary');
            if (b) { clearInterval(timer); b.click(); resolve(true); }
          }, 100);
          setTimeout(() => { clearInterval(timer); resolve(false); }, 8000);
        })`).then((clicked) => {
          if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] passkey start clicked: ${clicked}`);
        });
      } catch (e) {
        errors.push(`passkey window: ${e.message}`);
      }
    });
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error') errors.push(`passkey window: ${e.message}`);
    });
  });
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch((e) => errors.push(String(e)));
    const ready = await js('document.body.dataset.ready || ""');
    if (ready !== '1') errors.push('renderer did not signal ready');
    if (demo) {
      // Key Vault demo containers.
      await js('document.querySelector(".card .btn.primary")?.click()');
      await sleep(1200);
      await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team"))?.click()');
      await sleep(600);
      await js('document.querySelector(".row-item")?.click()');
      await sleep(900);
      if (!(await js('document.querySelectorAll(".row-item").length') > 0)) errors.push('demo: no items rendered');
      // Shortcuts through Chromium's real input path (not synthetic DOM events).
      await js('document.querySelector(".row-item:not(.folder-row)")?.click(); window.__keys = []; document.addEventListener("keydown", (e) => window.__keys.push([e.key, e.code, e.ctrlKey, e.shiftKey].join("/")), true)');
      await sleep(400);
      win.focus();
      for (const keyCode of ['U', 'P']) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] });
        await sleep(500);
      }
      const selected = await js('document.querySelector(".row-item.active") ? "yes" : "no"');
      if (selected === 'yes') {
        await globalAutoType('o').catch(() => {});
        await globalAutoType('u');
        if (!autoTypeCalls.includes('global:u')) errors.push('global auto-type: no call');
        autoTypeCalls.splice(autoTypeCalls.indexOf('global:u'), 1);
      }
      if (autoTypeCalls.join() !== 'u,p') {
        errors.push(`auto-type shortcuts: ${autoTypeCalls.join() || 'no call'} (keys seen: ${await js('JSON.stringify(window.__keys)')}, selected: ${await js('document.querySelector(".row-item.active") ? "yes" : "no"')})`);
      }
      // File container protected by a passkey (virtual authenticator) and a master password.
      const file = path.join(app.getPath('userData'), 'demo.kvpws');
      try {
        const created = await api.createFile({ path: file, name: 'Demo-Datei', password: 'demo-passwort', passkeyLabel: 'Smoke' });
        if (!/^RK-/.test(created.recoveryKey)) errors.push('file: no recovery key');
        await api.save(created.id, { title: 'Datei-Eintrag', username: 'u', password: 'p', urls: ['https://example.com'] });
        await api.lockContainer(created.id);
        await api.unlockContainerPasskey(created.id);
        if ((await files.summaries(created.id)).length !== 1) errors.push('file: entry missing after passkey unlock');
        await api.lockContainer(created.id);
        await api.unlockContainer(created.id, { password: 'demo-passwort' });
        const kvId = (await vault.containers()).find((c) => c.kind === 'keyvault')?.id;
        const r = await api.enableProtection(kvId, { password: 'kv-passwort-1' });
        if (!r.recoveryKey || r.failed.length) errors.push(`kv protection: ${r.failed.join(', ')}`);
        await api.lockContainer(kvId);
        await api.unlockContainerPasskey(kvId).then(() => errors.push('kv: unexpected passkey unlock'), () => {});
        await api.unlockContainer(kvId, { password: 'kv-passwort-1' });
        await api.lockContainer(kvId);
      } catch (e) {
        errors.push(`protection flow: ${e.message}`);
      }
      // Browser extension through the desktop app: every container (Key Vault too), entries readable.
      try {
        const hello = await browserHandlers.hello();
        if (!hello.opened || !hello.containers.some((c) => c.source === 'keyvault')) errors.push('bridge: key vault containers missing');
        const list = await browserHandlers.summaries();
        const kvEntry = list.find((s) => hello.containers.some((c) => c.id === s.containerId && c.source === 'keyvault'));
        if (!kvEntry) errors.push('bridge: no key vault entries');
        else if (!(await browserHandlers.item({ containerId: kvEntry.containerId, itemId: kvEntry.id })).title) errors.push('bridge: item not readable');
      } catch (e) {
        errors.push(`bridge flow: ${e.message}`);
      }
      // Vault settings: a non-admin may only use what an admin enabled; folders at most three levels.
      try {
        const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        const stored = await vault.store.get('containers');
        const entry = stored.find((c) => c.id === kvc.id);
        const asAdmin = entry.access;
        const setAdmin = async (admin) => {
          entry.access = { ...asAdmin, admin };
          await vault.store.set('containers', stored);
        };
        await setAdmin(false);
        const blocked = await api.renameContainer(kvc.id, 'Nicht erlaubt').then(() => false, (e) => /nicht freigeschaltet|not enabled/.test(e.message));
        if (!blocked) errors.push('vault settings: rename not blocked for non-admin');
        if (await api.setPolicy(kvc.id, { rename: true }).then(() => true, () => false)) errors.push('vault settings: non-admin could change the settings');
        await setAdmin(true);
        await api.setPolicy(kvc.id, { rename: true });
        await setAdmin(false);
        await api.renameContainer(kvc.id, kvc.name);
        if (await api.addFolder(kvc.id, 'Gesperrt').then(() => true, () => false)) errors.push('vault settings: folders not blocked for non-admin');
        await setAdmin(true);
        await api.setPolicy(kvc.id, {});
        if (await api.addFolder(kvc.id, 'A/B/C/D').then(() => true, () => false)) errors.push('folders: a fourth level was accepted');
      } catch (e) {
        errors.push(`vault settings: ${e.message}`);
      }
      // Licensing: request code per vault, free limit shown.
      try {
        const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        const ls = await api.licenseState(kvc.id);
        if (!/^KVP-/.test(ls.code) || ls.limit !== 10 || ls.licensed) errors.push('license: unexpected state');
      } catch (e) {
        errors.push(`license flow: ${e.message}`);
      }
      // Rename: Key Vault container (locally if the vault tag cannot be written).
      try {
        const kv = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        await api.renameContainer(kv.id, 'Team Umbenannt');
        if ((await vault.container(kv.id)).name !== 'Team Umbenannt') errors.push('rename: key vault name unchanged');
        // Back to the original name: screenshots and the views after this show the demo as it is.
        await api.renameContainer(kv.id, kv.name);
      } catch (e) {
        errors.push(`rename flow: ${e.message}`);
      }
      // App PIN: unlocking needs it once set; wrong PIN is refused.
      try {
        await api.setPin({ next: '2580' });
        await lockNow();
        await api.unlock({ entra: true }).then(() => errors.push('pin: unlock without PIN'), () => {});
        await api.verifyPin('0000').then(() => errors.push('pin: wrong PIN accepted'), () => {});
        await api.verifyPin('2580');
        await api.unlock({ entra: true });
        if (!opened) errors.push('pin: unlock with PIN failed');
        await api.setPin({ current: '2580', next: null });
        if (config.get().appPin) errors.push('pin: not removed');
      } catch (e) {
        errors.push(`pin flow: ${e.message}`);
      }
      // Secured file (passkey only): admin creates, folders, change log, access request + approval.
      try {
        const secured = path.join(app.getPath('userData'), 'team.kvpws');
        const { id } = await api.createSecureFile({ path: secured, name: 'Team-Datei', email: 'Alex@Contoso.com', attachment: 'cross-platform' });
        await api.addFolder(id, 'Kunden/Contoso');
        await api.save(id, { title: 'Contoso VPN', username: 'vpn', password: 'p1', folder: 'Kunden/Contoso' });
        await api.lockContainer(id);
        const unlocked = await api.unlockContainerPasskey(id);
        if (unlocked.pending || unlocked.role !== 'admin') errors.push('secured: admin unlock failed');
        if ((await files.summaries(id)).length !== 1) errors.push('secured: entry missing after unlock');
        if (!(await api.folders(id)).includes('Kunden/Contoso')) errors.push('secured: folder missing');
        // Logo and entry icon (1×1 PNG).
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        await api.setContainerLogo(id, png);
        if ((await api.containerLogo(id)) !== png) errors.push('secured: logo not stored');
        const first = (await files.summaries(id))[0];
        await api.save(id, { ...(await files.getItem(id, first.id)), icon: png });
        if ((await files.summaries(id))[0].icon !== png) errors.push('secured: entry icon missing in list');
        await api.fileMemberOp(id, { type: 'sharing', enabled: true });
        const req = await api.requestFileAccess(id, { email: 'sam@contoso.com', attachment: 'cross-platform' });
        const sam = (await api.fileMembers(id)).members.find((m) => m.email === 'sam@contoso.com');
        if (sam?.status !== 'pending' || sam.safetyCode !== req.safetyCode) errors.push('secured: request not pending');
        await api.fileMemberOp(id, { type: 'approve', memberId: sam.id, role: 'editor' });
        const log = await api.changelog(id);
        for (const action of ['file-create', 'folder-create', 'item-create', 'sharing-on', 'member-approve']) {
          if (!log.some((e) => e.action === action && e.trusted)) errors.push(`secured: log misses ${action}`);
        }
        if ((await fs.readFile(secured, 'utf8')).includes('Contoso')) errors.push('secured: plaintext in file');
        // Folders: rename moves entries and subfolders along; deleting a non-empty folder moves its content up.
        await api.renameFolder(id, 'Kunden', 'Partner');
        const movedItem = (await files.summaries(id)).find((s) => s.title === 'Contoso VPN');
        if (movedItem?.folder !== 'Partner/Contoso' || !(await api.folders(id)).includes('Partner/Contoso')) errors.push('folders: rename did not move entries/subfolders');
        await api.renameFolder(id, 'Partner', '');
        if ((await files.summaries(id)).find((s) => s.title === 'Contoso VPN')?.folder !== 'Contoso') errors.push('folders: delete did not move content up');
      } catch (e) {
        errors.push(`secured flow: ${e.message}`);
      }
      // Windows passkey provider: simulated CTAP requests as the packaged provider would relay them.
      try {
        const { encode, decode } = await import('../extension/core/cbor.js');
        const { sha256, utf8 } = await import('../extension/core/util.js');
        const createReq = encode(new Map([
          [1, await sha256(utf8('{"type":"webauthn.create"}'))],
          [2, new Map([['id', 'example.com'], ['name', 'Example']])],
          [3, new Map([['id', new Uint8Array([7, 7, 7])], ['name', 'win@example.com']])],
          [4, [new Map([['alg', -7], ['type', 'public-key']])]],
        ]));
        const created = windows.request('create', { request: Buffer.from(createReq).toString('base64'), transactionId: 'smoke-create' });
        await sleep(800);
        if (!(await js('!!document.querySelector("dialog[open] .unlock-head")'))) errors.push('windows: confirmation dialog missing');
        const target = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.locked);
        await api.windowsDecision('smoke-create', { containerId: target.id, title: 'Windows-Test' });
        const made = decode(Buffer.from((await created).response, 'base64'));
        if (made.get(1) !== 'none' || made.get(2).length < 100) errors.push('windows: bad makeCredential response');
        const getReq = encode(new Map([[1, 'example.com'], [2, await sha256(utf8('{"type":"webauthn.get"}'))]]));
        const got = windows.request('get', { request: Buffer.from(getReq).toString('base64'), transactionId: 'smoke-get' });
        await sleep(500);
        const pending = await windows.list();
        const c = pending.find((p) => p.id === 'smoke-get')?.candidates[0];
        if (!c) errors.push('windows: passkey not offered');
        else {
          await api.windowsDecision('smoke-get', c);
          const assertion = decode(Buffer.from((await got).response, 'base64'));
          if (!assertion.get(3) || assertion.get(4).get('name') !== 'win@example.com') errors.push('windows: bad getAssertion response');
        }
        const view = process.argv.find((a) => a.startsWith('--view='))?.slice('--view='.length);
        if (view === 'windows') {
          windows.request('get', { request: Buffer.from(getReq).toString('base64'), transactionId: 'smoke-view' }).catch(() => {});
          await sleep(800);
        }
      } catch (e) {
        errors.push(`windows flow: ${e.message}`);
      }
      await js('window.dispatchEvent(new Event("kvpwsafe-refresh"))');
      await sleep(900);
      const view = process.argv.find((a) => a.startsWith('--view='))?.slice('--view='.length);
      if (view === 'edit') await js('document.querySelector(".detail-pane .btn.primary")?.click()');
      if (view === 'detail') await js('document.querySelector(".list-pane .row-item:not(.folder-row)")?.click()');
      if (view === 'newcard' || view === 'newcert') {
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js(`document.querySelector('.context-menu [data-action="${view === 'newcard' ? 'new-card' : 'new-certificate'}"]')?.click()`);
      }
      if (view === 'cardcert') {
        // Create a credit card and a certificate through the form, then check their detail views.
        const create = async (action, fill, expect) => {
          await js('document.querySelector(".top-actions .btn.primary")?.click()');
          await sleep(300);
          await js(`document.querySelector('.context-menu [data-action="${action}"]')?.click()`);
          await sleep(400);
          await js(fill);
          await sleep(300);
          await js('document.querySelector(".item-form")?.requestSubmit()');
          await sleep(1500);
          const text = await js('document.querySelector(".detail-pane")?.innerText || ""');
          for (const e of expect) if (!text.includes(e)) errors.push(`${action}: "${e}" missing in detail view`);
        };
        await create('new-card', `(() => { const f = document.querySelector(".item-form");
          f.title.value = "Firmen-Visa"; f.cardHolder.value = "Alex Demo"; f.cardNumber.value = "4111 1111 1111 1111";
          f.cardExpiry.value = "12/28"; f.cardCvc.value = "123"; f.cardPin.value = "9876"; return true; })()`, ['Kartennummer', '•••• •••• •••• 1111', 'Alex Demo', '12/28']);
        await create('new-certificate', `(() => { const f = document.querySelector(".item-form");
          f.title.value = "VPN-Zertifikat"; f.certPassword.value = "geheim";
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(2048).fill(7)], "vpn.pfx"));
          const input = f.querySelector('input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change'));
          return true; })()`, ['Zertifikat', 'vpn.pfx', '2 KB', 'Zertifikats-Passwort']);
      }
      // Resizable panes: two drag handles, widths applied as CSS variables.
      const panes = await js('(() => { const s = document.querySelector(".shell"); return JSON.stringify({ handles: document.querySelectorAll(".shell > .splitter").length, sidebar: s?.style.getPropertyValue("--sidebar-w"), list: s?.style.getPropertyValue("--list-w") }); })()');
      if (!/"handles":2,"sidebar":"\d+px","list":"\d+px"/.test(panes)) errors.push(`resizable panes: ${panes}`);
      if (view === 'small') {
        win.setSize(1000, 560);
        await sleep(300);
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(500);
        const r = await js('(() => { const p = document.querySelector(".detail-pane"); p.scrollTop = p.scrollHeight; const b = [...p.querySelectorAll("button")].find((x) => /Speichern|Save/.test(x.textContent)); const rb = b?.getBoundingClientRect(); return JSON.stringify({ scrolls: p.scrollHeight > p.clientHeight, visible: !!rb && rb.bottom <= window.innerHeight && rb.top >= 0, inner: window.innerHeight, shell: document.querySelector(".shell")?.getBoundingClientRect().height, pane: p.clientHeight, scrollH: p.scrollHeight, btn: !!b, btnBottom: rb?.bottom, editor: !!p.querySelector(".editor") }); })()');
        if (!/"visible":true/.test(r)) errors.push(`small window: save button not reachable ${r}`);
      }
      const menuAction = async (action) => {
        await js('document.querySelector(".sidebar .nav-row.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 }))');
        await sleep(200);
        await js(`document.querySelector('.context-menu [data-action="${action}"]')?.click()`);
      };
      if (view === 'share') await menuAction('share');
      if (view === 'menu') await js('document.querySelector(".sidebar .nav-row.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 }))');
      if (view === 'locked') await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.querySelector(".icon-lock"))?.click()');
      if (view === 'import') await menuAction('import');
      if (view === 'license') await menuAction('license');
      if (['members', 'changelog', 'folders'].includes(view)) {
        await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click()');
        await sleep(600);
        if (view === 'members') await menuAction('members');
        if (view === 'changelog') await menuAction('changelog');
      }
      if (view?.startsWith('settings')) await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=settings]")?.click()');
      // Settings tab: settings-mcp (AI agents) or settings-<n> (n-th tab, 0-based).
      if (view === 'settings-mcp' || /^settings-\d$/.test(view || '')) {
        await new Promise((r) => setTimeout(r, 600));
        const pick = view === 'settings-mcp' ? '[...tabs].find((x) => /KI-Agenten|AI agents/.test(x.textContent))' : `tabs[${view.slice(-1)}]`;
        const tab = await js(`(() => { const tabs = document.querySelectorAll(".modal .tabs button"); const b = ${pick}; if (b) b.click(); return b ? "clicked" : "no tab"; })()`);
        if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] ${view} tab: ${tab}`);
      }
      if (view === 'create') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('document.querySelectorAll("dialog[open] .option-card")[3]?.click()');
      }
      if (view === 'newfile') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('[...document.querySelectorAll("dialog[open] .option-card")].find((b) => /Datei-Tresor|file vault/i.test(b.textContent))?.click()');
      }
      if (view === 'backup') await menuAction('backup');
      if (view === 'vault-settings') await menuAction('vault-settings');
      if (view === 'restore') await menuAction('restore');
      // Success animation after a Windows passkey request (screenshot only).
      if (view === 'passkey-success') send({ type: 'passkeyFlash', text: t('Angemeldet') });
      // Update offer with the real changelog: everything since 0.7.12 (screenshot only).
      if (view === 'update-offer') {
        const { recentSections } = await import('../scripts/release-notes.mjs');
        const notes = recentSections(await fs.readFile(path.join(appRoot, 'CHANGELOG.md'), 'utf8'), app.getVersion());
        send({ type: 'updateOffer', state: { kind: 'nsis', status: 'available', version: app.getVersion(), current: '0.7.12', notes } });
      }
      // Agent question in the app's style (screenshot only; answered with the cancel choice when the test ends).
      if (view === 'agent-read') confirmAgentRead({ agent: 'claude-code', title: 'Strato SFTP keevault.de', vault: 'kv-team' }).catch(() => {});
      if (view === 'agent-write') confirmAgentWrite({ agent: 'claude-code', action: 'update', title: 'GitHub', vault: 'kv-team', fields: Object.keys({ password: 1, notes: 1 }) }).catch(() => {});
      if (view === 'agent-connect') askInApp({ kind: 'agent-connect', agent: 'claude-code', title: t('„{agent}“ möchte sich verbinden', { agent: 'claude-code' }),
        lead: t('Ein KI-Agent möchte Keevault nutzen. Erlaube das nur für Agenten, die du selbst eingerichtet hast.'),
        choices: [{ value: 'write', label: t('Lesen und Schreiben'), hint: t('Suchen, Passwörter mit deiner Freigabe lesen, Einträge mit Bestätigung anlegen und ändern.') },
          { value: 'read', label: t('Nur lesen'), hint: t('Suchen und Passwörter mit deiner Freigabe lesen – keine Änderungen.') }],
        note: t('Löschen ist nie möglich. Rechte und Gültigkeit änderst du jederzeit in den Einstellungen.'), allow: t('Verbinden'), cancel: 'deny' }).catch(() => {});
      if (view === 'progress') {
        // Progress card bottom right as during a background reconcile (screenshot only).
        send({ type: 'progress', id: 'reconcile', label: t('Tresore werden abgeglichen …'), step: 'fast', detail: t('Schnell-Index wird geladen …') });
        await sleep(300);
        send({ type: 'progress', id: 'reconcile', step: 'list', detail: t('{vaults} Tresore · Seite {page}, {n} Secrets gefunden', { vaults: 3, page: 82, n: 1234 }),
          hint: emptyPagesHint(82, 28), done: 1234, total: 2000 });
        await js('document.querySelector(".progress-toast")?.classList.add("expanded")');
        // … and the spinning refresh icon of the vault being reconciled.
        send({ type: 'busy', containerId: (await vault.containers())[0]?.id, busy: true });
        await sleep(600);
      }
      if (view === 'health') await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=health]")?.click()');
      if (view === 'access') await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=access]")?.click()');
      if (view === 'mainmenu') await js('document.querySelector(".menu-btn")?.click()');
      if (view === 'multi') {
        await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => /Alle Einträge|All entries|All items/.test(n.textContent))?.click()');
        await sleep(400);
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(200);
        await js('document.querySelectorAll(".list li.row-item[data-key]")[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))');
        await sleep(400);
        const r = await js('JSON.stringify({ multi: document.querySelectorAll(".list li.row-item.multi").length, pane: document.querySelector(".multi-selection h2")?.textContent || "" })');
        if (!/"multi":3/.test(r)) errors.push(`multi-select: expected 3 selected rows, got ${r}`);
      }
      if (view === 'expiry') {
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(400);
        await js('(() => { const d = document.querySelector(".editor input[name=expires]"); if (d) { d.value = "2026-11-10"; d.dispatchEvent(new Event("input", { bubbles: true })); } })()');
      }
      if (view === 'fields') {
        // New login with the additional-field menu open and two typed fields (screenshot only).
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(400);
        await js('(() => { const b = [...document.querySelectorAll(".editor button")].find((x) => /Feld hinzufügen|Add field/.test(x.textContent)); b?.click(); [...document.querySelectorAll(".field-menu button")].find((x) => /Wiederherstellungscodes|Recovery codes/.test(x.textContent))?.click(); b?.click(); [...document.querySelectorAll(".field-menu button")].find((x) => /Anhang|Attachment/.test(x.textContent))?.click(); b?.click(); document.querySelector(".custom-field")?.scrollIntoView(); })()');
      }
      if (view === 'detail') {
        // First entry opened in the detail pane (screenshot only).
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(500);
      }
      if (view === 'help') await js('document.querySelector(".help-btn")?.click()');
      if (view === 'searchall') {
        // Search scope: "o" in the team vault finds only its entries, switched to "All" also the personal ones.
        const typeInto = (v) => js(`(() => { const s = document.getElementById("search"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await typeInto('o');
        await sleep(300);
        const vaultOnly = Number(await js('document.querySelectorAll(".list li.row-item[data-key]").length'));
        await js('document.querySelector(".search-scope button:last-child")?.click()');
        await sleep(300);
        await typeInto('o');
        await sleep(300);
        const all = Number(await js('document.querySelectorAll(".list li.row-item[data-key]").length'));
        if (!(all > vaultOnly)) errors.push(`searchall: expected more hits in all vaults (${vaultOnly} vs ${all})`);
        // The lock and menu buttons in the top strip take clicks.
        await js('document.querySelector(".menu-btn")?.click()');
        await sleep(200);
        if (await js('String(!!document.querySelector(".main-menu"))') !== 'true') errors.push('searchall: menu button did not open the menu');
        const hit = await js('(() => { const b = document.querySelector(".brand .icon-btn"); const r = b.getBoundingClientRect(); return String(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".icon-btn") === b); })()');
        if (hit !== 'true') errors.push('searchall: lock button is covered');
        await js('document.querySelector(".main-menu")?.remove()');
      }
      if (view === 'itemlink') {
        // "Copy link" round trip: the web link of a team entry opens exactly that entry (screenshot/smoke only).
        const c = (await vault.containers()).find((x) => /kv-pws-demo-team/.test(x.vaultUrl || ''));
        const entry = c && (await vault.index())[c.id]?.items?.find((x) => x.title === 'Grafana');
        if (!entry) errors.push('itemlink: demo entry missing');
        else {
          send({ type: 'link', url: `https://keevault.de/open#v=${new URL(c.vaultUrl).host}&i=${entry.id}` });
          await sleep(900);
          const shown = await js('document.querySelector(".detail-pane .item-head h2")?.textContent || ""');
          if (!shown.includes('Grafana')) errors.push(`itemlink: expected Grafana in the detail pane, got "${shown}"`);
        }
      }
      if (view === 'add') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('document.querySelectorAll("dialog[open] .option-card")[2]?.click()');
      }
      if (view) await sleep(1200);
      // Layout check (development): KVPWSAFE_MEASURE="<selector>[,<selector>…]" prints each match's box.
      if (process.env.KVPWSAFE_MEASURE) {
        const sel = JSON.stringify(process.env.KVPWSAFE_MEASURE);
        console.log(await js(`JSON.stringify(${sel}.split(',').flatMap((q) => [...document.querySelectorAll(q)].slice(0, 6).map((e) => { const r = e.getBoundingClientRect(); return [q, (e.textContent || '').trim().slice(0, 18), Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })))`));
      }
    }
    for (const f of missingFiles) errors.push(`missing file: ${f}`);
    if (screenshot) {
      if (!process.argv.includes('--view=small')) win.setSize(1200, 780);
      const image = await win.webContents.capturePage();
      await fs.writeFile(screenshot, image.toPNG());
    }
    console.log(errors.length ? `SMOKE FAIL\n${errors.join('\n')}` : 'SMOKE OK');
    app.exit(errors.length ? 1 : 0);
  }, 1500));
}
