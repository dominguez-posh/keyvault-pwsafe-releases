// Updates from keevault.de (https://keevault.de/update/, counted there and served from the GitHub release).
// Modes (setting updateMode, policy UpdateMode):
//   off  – nothing happens by itself; only "Check for updates" (settings, tray, version label) looks
//   auto – keep up to date: check at start and every 6 hours, download, install when the app quits or is locked
//   ask  – default: check at start; a new version is offered right away in the app (release notes from the signed
//          manifest, one click downloads, installs and restarts; "Later" asks again at the next start)
// Only the per-user installation (EXE/NSIS) installs updates itself; MSI and MSIX are updated by IT or the package,
// there the check only reports the new version and links to the download page.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import updaterPkg from 'electron-updater';
import { verifyManifest, parseManifest } from './update-verify.js';
import { detectInstallKind } from './install-kind.js';

const { autoUpdater } = updaterPkg;
export const UPDATE_MODES = ['off', 'auto', 'ask'];
const FEED = 'https://keevault.de/update';
const INTERVAL = 6 * 60 * 60_000;

/** How this copy was installed: 'nsis' updates itself; 'msi', 'msix' (and 'managed' by policy) are updated elsewhere; 'dev' never updates. */
export function installKind() {
  let filesNextToExe = [];
  try { filesNextToExe = fs.readdirSync(path.dirname(process.execPath)); } catch { /* unreadable → not an EXE install */ }
  return detectInstallKind({ packaged: app.isPackaged, windowsStore: !!process.windowsStore, platform: process.platform, filesNextToExe });
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
   * mode(): current setting; onState(state): every change (renderer); offer(state): mode "ask" found a new version
   * at start – show it in the app; isIdle(): app locked/in the tray – a downloaded update may be installed right
   * away in mode "auto"; beforeInstall(): called right before the app quits for the installation;
   * fetch: secureFetch (in memory).
   */
  constructor({ mode, onState, offer, isIdle, beforeInstall, fetch, selfUpdate, windowCenter }) {
    Object.assign(this, { mode, onState, offer, isIdle, beforeInstall, fetch, windowCenter });
    // Policy SelfUpdate=0 ('managed'): IT distributes updates – the app only reports a newer version.
    this.kind = selfUpdate?.() === false ? 'managed' : installKind();
    this.state = { kind: this.kind, status: 'idle', current: app.getVersion(), version: null, notes: '', progress: 0, error: null, checked: null };
    this.timer = null;
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

  /** Newest version on the server → { version, notes } (null if none newer). Unsigned or altered manifests are rejected. */
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
    return { version: signed.version, notes: signed.notes };
  }

  /**
   * Background run: look; "auto" downloads quietly and installs in downloaded(); "ask" offers the new version in
   * the app (the download starts only when the user clicks).
   */
  async background() {
    if (this.mode() === 'off' || this.kind === 'dev' || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    try {
      this.set({ status: 'checking', error: null });
      const found = await this.latest();
      this.set({ checked: new Date().toISOString(), version: found?.version || null, notes: found?.notes || '', status: found ? 'available' : 'none' });
      if (!found || this.kind !== 'nsis') return;
      if (this.mode() === 'auto') {
        this.set({ status: 'downloading', progress: 0 });
        await autoUpdater.downloadUpdate();
      } else {
        this.offer?.(this.state);
      }
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
  }

  /** Manual check (menu, settings): → state; with a new version the caller offers download + install. */
  async check() {
    if (this.kind === 'dev') throw new Error('Updates gibt es nur in der installierten App.');
    this.set({ status: 'checking', error: null });
    try {
      const found = await this.latest();
      this.set({ checked: new Date().toISOString(), version: found?.version || null, notes: found?.notes || '', status: this.state.status === 'ready' ? 'ready' : found ? 'available' : 'none' });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
      throw e;
    }
    return this.state;
  }

  /** Manual: download (if needed) and install now – the app restarts. */
  async installNow() {
    if (this.kind === 'managed') throw new Error('Updates verteilt deine IT (Richtlinie).');
    if (this.kind !== 'nsis') throw new Error('Diese Installation (MSI/MSIX) wird über das Paket aktualisiert.');
    this.manualInstall = true;
    if (this.state.status === 'ready') return this.install();
    this.set({ status: 'downloading', progress: 0 });
    await autoUpdater.downloadUpdate();
    return undefined;
  }

  async downloaded(info) {
    this.downloadedFile = info?.downloadedFile || null;
    this.set({ status: 'ready', version: info?.version || this.state.version, progress: 100 });
    if (this.manualInstall) return this.install();
    // Fully automatic: install once nobody is working in the app (locked or only in the tray), else on quit.
    if (this.mode() === 'auto' && this.isIdle()) return this.install({ silent: true });
    return undefined;
  }

  /**
   * Installs the downloaded update. With Keevault-Update.exe (resources, windows/Setup) the app hands over to a
   * window in its own design that appears where the app window was, waits for the app to quit, runs the setup
   * silently and starts the new version (--updated-from shows "Updated to …"). An idle install (auto mode, app
   * locked or in the tray) stays invisible and the new version starts in the tray again. Without the helper:
   * electron-updater's silent installation, then start.
   */
  install({ silent = false } = {}) {
    this.beforeInstall?.();
    if (this.launchHelper(silent)) {
      autoUpdater.autoInstallOnAppQuit = false;
      setTimeout(() => app.quit(), 250);
      return;
    }
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  launchHelper(silent) {
    try {
      const helper = path.join(process.resourcesPath || '', 'Keevault-Update.exe');
      const setup = this.downloadedFile;
      if (!setup || !fs.existsSync(helper) || !fs.existsSync(setup)) return false;
      // Outside the installation folder: the setup replaces everything in it.
      const copy = path.join(path.dirname(setup), 'Keevault-Update.exe');
      fs.copyFileSync(helper, copy);
      const args = ['--update', setup, '--from', app.getVersion(), '--to', this.state.version || '', '--pid', String(process.pid)];
      const center = this.windowCenter?.();
      if (center) args.push('--x', String(Math.round(center.x)), '--y', String(Math.round(center.y)));
      if (silent) args.push('--silent');
      spawn(copy, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return true;
    } catch {
      return false;
    }
  }
}
