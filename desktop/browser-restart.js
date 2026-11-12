// #494: restarting Edge or Chrome completely after "Browser-Erweiterung neu installieren", so the browser reads the new
// policies and installs or updates the extension. Runs without elevation and only for the signed-in user: taskkill and
// tasklist from the checked Windows folder with fixed arguments, only in this app's Windows session, then the browser
// itself with --restore-last-session (its path from the App Paths registration, checked by name; from HKCU only the
// per-user installation below %LOCALAPPDATA%). The browser reads its policies again when it starts.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import { parseRegTree, system as registry, windowsFolder } from './machine-setup.js';

const exec = promisify(execFile);

/** Image name per browser; nothing else is ever ended or started. */
export const BROWSER_IMAGES = { edge: 'msedge.exe', chrome: 'chrome.exe' };
const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
/** #494: where a per-user installation lives, below %LOCALAPPDATA%; only there is a path from HKCU (user-writable) believed. */
const USER_INSTALL = { edge: 'Microsoft\\Edge\\Application', chrome: 'Google\\Chrome\\Application' };

/** The only path an HKCU App Paths registration may name: <LOCALAPPDATA>\<vendor>\Application\<image>, or null. */
export function userInstallPath(browser, localAppData) {
  const base = String(localAppData || '').replace(/\\+$/, '');
  if (!USER_INSTALL[browser] || !/^[A-Za-z]:\\[^"<>|*?\r\n]+$/.test(base) || base.includes('..')) return null;
  return `${base}\\${USER_INSTALL[browser]}\\${BROWSER_IMAGES[browser]}`;
}

/** A registered path is used only when it is a full local path to exactly the browser's image name. */
export function browserPathOk(browser, file) {
  const image = BROWSER_IMAGES[browser];
  if (!image || typeof file !== 'string') return false;
  const p = file.trim().replace(/^"(.*)"$/, '$1');
  return /^[A-Za-z]:\\[^"<>|*?\r\n]+$/.test(p) && p.toLowerCase().endsWith(`\\${image}`) && !p.includes('..');
}

/** The default value of a `reg query <key> /ve` output ("(Standard)" or "(Default)", by language). */
const defaultValue = (stdout) => parseRegTree(stdout)[0]?.values.find((x) => x.name.startsWith('('))?.value ?? null;

/** Where the installers put the browsers, when the App Paths registration is missing. */
const KNOWN_PATHS = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};

/** Real system access; tests and the smoke run replace it. */
export const system = {
  regQuery: (args) => registry.regQuery(args),
  exists: (file) => fs.existsSync(file),
  run: (file, args) => exec(file, args, { windowsHide: true, timeout: 15000 }),
  start(file, args) {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  user: () => os.userInfo().username,
  localAppData: () => process.env.LOCALAPPDATA,
  /** The Windows session of this app (tasklist on its own process id), or null. */
  async session() {
    try {
      return sessionOf((await this.run(tool('tasklist.exe'), ['/FI', `PID eq ${process.pid}`, '/NH', '/FO', 'CSV'])).stdout);
    } catch {
      return null;
    }
  },
};

/** The session number from a tasklist CSV line ("image","pid","session name","session#","memory"), or null. */
export function sessionOf(stdout) {
  const m = /^"[^"]*","\d+","[^"]*","(\d+)"/m.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

/**
 * Where to start the browser from: { exe }, or { reason }: 'missing' (not installed) or 'untrusted' (#494: an HKCU App
 * Paths registration that names anything but the per-user installation below %LOCALAPPDATA%; then nothing is restarted
 * and the user restarts the browser himself). HKLM is checked first, it is writable by admins only.
 */
export async function browserLaunch(browser, sys = system) {
  const read = async (hive) => {
    const out = await sys.regQuery([`${hive}\\${APP_PATHS}\\${BROWSER_IMAGES[browser]}`, '/ve']);
    const file = out == null ? null : defaultValue(out);
    return file == null ? null : file.trim().replace(/^"(.*)"$/, '$1');
  };
  const machine = await read('HKLM');
  if (machine && browserPathOk(browser, machine) && sys.exists(machine)) return { exe: machine };
  const user = await read('HKCU');
  if (user != null) {
    const want = userInstallPath(browser, sys.localAppData());
    return want && browserPathOk(browser, user) && user.toLowerCase() === want.toLowerCase() && sys.exists(user) ? { exe: user } : { reason: 'untrusted' };
  }
  const known = KNOWN_PATHS[browser]?.find((f) => sys.exists(f));
  return known ? { exe: known } : { reason: 'missing' };
}

/** Path of the installed browser to start, or null (not installed, or not a registration to trust). */
export async function browserExe(browser, sys = system) {
  return (await browserLaunch(browser, sys)).exe ?? null;
}

const tool = (name) => {
  const w = windowsFolder();
  return w ? `${w}\\System32\\${name}` : null;
};
/**
 * Filter on the signed-in user and this app's own Windows session (#494), so no process of another session of the same
 * user (a second sign-in, RDP) is touched.
 */
const userFilter = (sys, session) => ['/FI', `USERNAME eq ${sys.user()}`, '/FI', `SESSION eq ${session}`];

/** Number of the user's processes of this browser in this session (tasklist, CSV without header). */
export async function runningCount(browser, sys = system, session = null) {
  const image = BROWSER_IMAGES[browser];
  try {
    if (!/^\d+$/.test(String(session ?? (session = await sys.session())))) return -1;
    const { stdout } = await sys.run(tool('tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, ...userFilter(sys, session), '/NH', '/FO', 'CSV']);
    return String(stdout).split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`"${image}"`)).length;
  } catch {
    return -1; // unknown
  }
}

async function waitGone(browser, sys, ms, session) {
  for (let left = ms; left > 0; left -= 500) {
    if ((await runningCount(browser, sys, session)) === 0) return true;
    await sys.wait(500);
  }
  return (await runningCount(browser, sys, session)) === 0;
}

/**
 * Ends the browser completely (windows first, so it can save its session; then the rest including background processes)
 * and starts it again with the last session. Resolves { ok, reason }: reason 'unavailable' (no trusted Windows folder or
 * session unknown), 'missing' (not installed), 'untrusted' (start path not trusted, see browserLaunch), 'running' (could not be ended).
 */
export async function restartBrowser(browser, sys = system) {
  if (!BROWSER_IMAGES[browser] || !tool('taskkill.exe')) return { ok: false, reason: 'unavailable' };
  const launch = await browserLaunch(browser, sys);
  if (!launch.exe) return { ok: false, reason: launch.reason };
  const session = await sys.session();
  if (!/^\d+$/.test(String(session))) return { ok: false, reason: 'unavailable' };
  const image = BROWSER_IMAGES[browser];
  if ((await runningCount(browser, sys, session)) !== 0) {
    // The gentle request goes to the whole tree (/T), so the browser closes its windows itself; the forced end only to
    // the browser's own processes, never to programs it started (downloads, protocol handlers).
    await sys.run(tool('taskkill.exe'), [...userFilter(sys, session), '/IM', image, '/T']).catch(() => {});
    if (!(await waitGone(browser, sys, 6000, session))) {
      await sys.run(tool('taskkill.exe'), [...userFilter(sys, session), '/IM', image, '/F']).catch(() => {});
      if (!(await waitGone(browser, sys, 6000, session))) return { ok: false, reason: 'running' };
    }
  }
  sys.start(launch.exe, ['--restore-last-session']);
  return { ok: true };
}
