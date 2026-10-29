// Updates from keevault.de (https://keevault.de/update/, counted there and served from the GitHub release).
// Off by default: only "Check for updates" (settings, tray, version label) looks for a new version. Modes:
//   off  – nothing happens by itself
//   auto – keep up to date: check at start and every 6 hours, download, install when the app quits or is locked
//   ask  – check and download in the background, ask at the next start whether to install
// Only the per-user installation (EXE/NSIS) installs updates itself; MSI and MSIX are updated by IT or the package,
// there the check only reports the new version and links to the download page.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import updaterPkg from 'electron-updater';
import { verifyManifest, parseManifest } from './update-verify.js';

const { autoUpdater } = updaterPkg;
export const UPDATE_MODES = ['off', 'auto', 'ask'];
const FEED = 'https://keevault.de/update';
const INTERVAL = 6 * 60 * 60_000;

/** How this copy was installed: 'nsis' updates itself; 'msi', 'msix' are managed elsewhere; 'dev' never updates. */
export function installKind() {
  if (!app.isPackaged) return 'dev';
  if (process.windowsStore) return 'msix';
  if (process.platform !== 'win32') return 'other';
  return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)) ? 'nsis' : 'msi';
}

/** Compares "1.2.10" with "1.2.9" → 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

export class Updater {
  /**
   * mode(): current setting; onState(state): every change (renderer); ask(question) → Promise<boolean> (dialog);
   * isIdle(): app locked/in the tray – a downloaded update may be installed right away in mode "auto";
   * beforeInstall(): called right before the app quits for the installation; fetch: secureFetch (in memory).
   */
  constructor({ mode, onState, ask, isIdle, beforeInstall, fetch }) {
    Object.assign(this, { mode, onState, ask, isIdle, beforeInstall, fetch });
    this.kind = installKind();
    this.state = { kind: this.kind, status: 'idle', current: app.getVersion(), version: null, progress: 0, error: null, checked: null };
    this.timer = null;
    this.startup = true;
    if (this.kind !== 'nsis') return;
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // One plain download (counted once on the server) instead of many range requests.
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.downloaded(info));
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: e?.message || String(e) }));
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  /** Start-up: in "auto"/"ask" check soon and (auto) regularly; "off" does nothing. */
  start() {
    this.applyMode();
    if (this.mode() !== 'off') setTimeout(() => this.background(), 20_000);
  }

  applyMode() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.kind === 'nsis') autoUpdater.autoInstallOnAppQuit = this.mode() === 'auto';
    if (this.mode() === 'auto') this.timer = setInterval(() => this.background(), INTERVAL);
  }

  /** latest.yml with latest.yml.sig from the server, verified against the embedded key → { version, sha512, url }. */
  async signedManifest() {
    const [manifest, signature] = await Promise.all(['latest.yml', 'latest.yml.sig'].map(async (name) => {
      const res = await this.fetch(`${FEED}/${name}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${name})`);
      return res.text();
    }));
    if (!verifyManifest(manifest, signature)) throw new Error('Update-Manifest nicht verifizierbar – Signatur ungültig.');
    return parseManifest(manifest);
  }

  /** Newest version on the server → { version } (null if none newer). Unsigned or altered manifests are rejected. */
  async latest() {
    const signed = await this.signedManifest();
    if (!signed.version || compareVersions(signed.version, app.getVersion()) <= 0) return null;
    if (this.kind === 'nsis') {
      // electron-updater reads the manifest itself and later checks the download against its hash: that manifest
      // has to be the signed one (same version, same installer hash), otherwise nothing is downloaded.
      const info = (await autoUpdater.checkForUpdates())?.updateInfo;
      const sha512 = info?.files?.[0]?.sha512 || info?.sha512;
      if (!info || info.version !== signed.version || !signed.sha512 || sha512 !== signed.sha512) {
        throw new Error('Update-Manifest stimmt nicht mit der signierten Fassung überein.');
      }
    }
    return { version: signed.version };
  }

  /** Background run (auto/ask): look, download quietly; installing follows in downloaded(). */
  async background() {
    if (this.mode() === 'off' || this.kind === 'dev' || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    try {
      this.set({ status: 'checking', error: null });
      const found = await this.latest();
      this.set({ checked: new Date().toISOString(), version: found?.version || null, status: found ? 'available' : 'none' });
      if (found && this.kind === 'nsis') {
        this.set({ status: 'downloading', progress: 0 });
        await autoUpdater.downloadUpdate();
      }
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    } finally {
      this.startup = false;
    }
  }

  /** Manual check (menu, settings): → state; with a new version the caller offers download + install. */
  async check() {
    if (this.kind === 'dev') throw new Error('Updates gibt es nur in der installierten App.');
    this.set({ status: 'checking', error: null });
    try {
      const found = await this.latest();
      this.set({ checked: new Date().toISOString(), version: found?.version || null, status: this.state.status === 'ready' ? 'ready' : found ? 'available' : 'none' });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
      throw e;
    }
    return this.state;
  }

  /** Manual: download (if needed) and install now – the app restarts. */
  async installNow() {
    if (this.kind !== 'nsis') throw new Error('Diese Installation (MSI/MSIX) wird über das Paket aktualisiert.');
    this.manualInstall = true;
    if (this.state.status === 'ready') return this.install();
    this.set({ status: 'downloading', progress: 0 });
    await autoUpdater.downloadUpdate();
    return undefined;
  }

  async downloaded(info) {
    this.set({ status: 'ready', version: info?.version || this.state.version, progress: 100 });
    if (this.manualInstall) return this.install();
    if (this.mode() === 'auto') {
      // Fully automatic: install once nobody is working in the app (locked or only in the tray), else on quit.
      if (this.isIdle()) return this.install();
      return undefined;
    }
    if (this.mode() === 'ask' && this.startup) {
      // Downloaded in an earlier session (cached) – this is the next start: ask.
      if (await this.ask(this.state.version)) return this.install();
    }
    return undefined;
  }

  install() {
    this.beforeInstall?.();
    // Silent installation of the per-user setup, then start the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
}
