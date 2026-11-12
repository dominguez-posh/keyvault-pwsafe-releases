// #512: Windows Hello for the window lock (see ../window-hello.js). The main process starts the helper itself and reads
// its answer; the smoke test simulates Windows Hello (never a real Windows dialog in a test).

import { spawn } from 'node:child_process';
import { t } from '../../extension/core/i18n.js';
import { HELLO_AVAILABLE, WindowHelloGate, helloOn, helloOutput } from '../window-hello.js';
import { smokeTest } from './boot.js';
import { helperExe } from './typing.js';
import { config, opened, setWindowLocked, win, windowLockEpoch, windowLocked } from './state.js';
import { changed } from './session.js';
import { revealHeldQuestions } from './agents.js';
import { diag } from './diag.js';

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

/** Switched on by the user, with an app PIN set. */
export const windowHelloOn = () => helloOn(config.get(), config.has('windowHello'));

const gate = new WindowHelloGate({
  on: windowHelloOn,
  locked: () => ({ opened, windowLocked, epoch: windowLockEpoch }),
  async verify() {
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
