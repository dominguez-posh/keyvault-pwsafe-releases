// #512: Windows Hello for the window lock (see ../window-hello.js). The main process starts the helper itself and reads
// its answer; the smoke test simulates Windows Hello (never a real Windows dialog in a test).

import { spawn } from 'node:child_process';
import { t } from '../../extension/core/i18n.js';
import { HELLO_AVAILABLE, HELLO_VERIFIED, WindowHelloGate, helloOn, helloOutput } from '../window-hello.js';
import { smokeTest } from './boot.js';
import { helperExe } from './typing.js';
import { config, opened, setWindowLocked, win, windowLockEpoch, windowLocked } from './state.js';
import { changed } from './session.js';
import { revealHeldQuestions } from './agents.js';
import { diag } from './diag.js';
import { helloUnlock } from './hello-key.js';
import { helloAllowed } from './unlock.js';

// Smoke test only: { availability, result } instead of the helper (set by desktop/main/smoke-window-hello.js).
let simulated = null;
export function simulateHello(value) {
  if (smokeTest) simulated = value;
}

/** Keevault-Update.exe in one Hello mode; the number under `key` of its answer, null without one. */
function runHelper(args, stdin, key, timeoutMs) {
  const exe = helperExe();
  if (!exe || process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 4096) out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(helloOutput(code, out, key)); });
    child.stdin.end(Buffer.from(stdin || '', 'utf8'));
  });
}

/** The app window's handle as a decimal number (owner of the Windows Hello dialog). */
function windowHandle() {
  const handle = win?.getNativeWindowHandle?.();
  if (!handle?.length) return null;
  return String(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0));
}

/** Whether Windows Hello is set up on this device (shows nothing). */
export async function helloAvailable() {
  if (smokeTest) return simulated?.availability === HELLO_AVAILABLE;
  return (await runHelper(['--hello-status'], '', 'availability', 10000)) === HELLO_AVAILABLE;
}

/** #537: the Hello key of the master password is set up (and allowed) – it lifts the window lock too, through DK. */
const helloKeyOn = () => !!config.get().unlockKeys?.hello && helloAllowed();

/** Switched on by the user, with an app PIN set (#512) – or the Hello key of the master password (#537). */
export const windowHelloOn = () => helloKeyOn() || helloOn(config.get(), config.has('windowHello'));

const gate = new WindowHelloGate({
  on: windowHelloOn,
  locked: () => ({ opened, windowLocked, epoch: windowLockEpoch }),
  async verify() {
    // #537: the Hello key counts only as an unwrapped device key (Konrad), never as Windows' yes/no.
    if (helloKeyOn()) return (await helloUnlock.proveDk('window').then(() => true, (e) => { diag(`HELLO window key refused: ${e.name}`); return false; })) ? HELLO_VERIFIED : null;
    if (smokeTest) return simulated ? simulated.result : null;
    const hwnd = windowHandle();
    if (!hwnd) return null;
    win?.focus();
    return runHelper(['--hello-verify', hwnd], t('Keevault-Fenster entsperren'), 'result', 180000);
  },
});

/** Lifts the window lock after Windows Hello – like the PIN on the lock screen, no session opens and no PIN token. */
export async function unlockWindowWithHello() {
  try {
    await gate.confirm();
  } catch (e) {
    diag(`HELLO window unlock refused: ${e.name}`);
    throw e;
  }
  setWindowLocked(false);
  win?.show();
  win?.focus();
  changed();
  revealHeldQuestions(); // agents' questions waiting behind the lock now show what they ask
  diag('HELLO window unlocked');
  return true;
}
