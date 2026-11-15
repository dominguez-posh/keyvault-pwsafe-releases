// #537 stage 3: Windows Hello as a way to unlock (desktop/unlock-hello.js) wired to the helper Keevault-Update.exe
// (windows/Setup/HelloKey.cs, KeyCredentialManager) – or, in smoke runs, to the simulated Hello key (desktop/hello-sim.js,
// mode in KVPWSAFE_TEST_HELLO). The helper's answer is read here only; signature and key never go to the window or a log.

import { spawn } from 'node:child_process';
import { HelloUnlock } from '../unlock-hello.js';
import { SimulatedHello, noteExtensionCard } from '../hello-sim.js';
import { verifyAttestation } from '../hello-attest.js';
import { demo, smokeTest } from './boot.js';
import { helperExe } from './typing.js';
import { win } from './state.js';
import { helloAllowed, unlockService } from './unlock.js';
import { diag } from './diag.js';
import { helloOwner } from './hello-window.js';
import { confirmInCard } from './confirm-card.js';
import { t } from '../../extension/core/i18n.js';

const MAX_OUTPUT = 64 * 1024; // public key, signature and the attestation chain

/** The helper's one JSON line (exit code 0), else null. stdin: the challenge as base64 – never on the command line. */
function runHelper(args, stdin, timeoutMs) {
  const exe = helperExe();
  if (!exe || process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const v = JSON.parse(out.trim());
        resolve(v && typeof v === 'object' && Number.isInteger(v.status ?? 0) ? v : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(Buffer.from(stdin || '', 'utf8'));
  });
}

/** The app window's handle as a decimal number (owner of the Windows Hello dialog). */
function windowHandle() {
  const handle = win?.getNativeWindowHandle?.();
  if (!handle?.length) return '0';
  return String(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0));
}

// Longer than the helper's own limits (HelloKey.cs: create 3 min + sign 3 min + attestation 1 min; open 3 + sign 3),
// so that the helper ends first and its answer – also a late key – is read, never cut off here.
const CREATE_MS = 8 * 60_000;
const SIGN_MS = 7 * 60_000;

const helper = {
  status: async () => (await runHelper(['--hello-key-status'], '', 15000)) || { supported: false, remote: false },
  create: (name, challenge, hwnd) => runHelper(['--hello-key-create', name, '--hwnd', hwnd || windowHandle()], challenge.toString('base64'), CREATE_MS),
  sign: (name, challenge, hwnd) => runHelper(['--hello-key-sign', name, '--hwnd', hwnd || windowHandle()], challenge.toString('base64'), SIGN_MS),
  remove: (name) => runHelper(['--hello-key-delete', name], '', 30000),
};

// Smoke runs of the demo only (Konrad: never in a real profile): the simulation, whose attestation is marked as
// simulated – accepted only here.
const simulation = smokeTest && !!demo;
const backend = simulation ? new SimulatedHello() : helper;

/** New master password (unlock-service rotate): the old key goes from the Hello container. */
export const removeHelloKey = (name) => backend.remove(name);

function attested(attestation) {
  if (simulation && attestation?.simulated === true && attestation.status === 0) return true;
  const r = verifyAttestation(attestation);
  if (!r.ok) diag(`UNLOCK windows hello attestation refused: ${r.reason}`);
  return r.ok;
}

/**
 * Konrad (review of stage 4): before Windows Hello unlocks for the browser extension, Keevault asks in a card of its own
 * – Zulassen only by a click after the waiting time (#368/#459), never by Enter; closing or Esc refuse. Smoke runs of
 * the demo: no card on anyone's desktop – the answer comes from KVPWSAFE_TEST_HELLO_CARD ('yes'), and the card is noted.
 */
async function confirmExtension() {
  const card = {
    title: t('Die Browser-Erweiterung möchte Keevault entsperren.'),
    detail: t('Danach fragt Windows Hello. Lass das nur zu, wenn du gerade selbst in der Erweiterung „Mit Windows Hello entsperren“ geklickt hast.'),
    go: t('Zulassen'), cancel: t('Ablehnen'), enter: false,
  };
  if (simulation) {
    noteExtensionCard(card);
    return process.env.KVPWSAFE_TEST_HELLO_CARD === 'yes';
  }
  return confirmInCard(card, { parent: win && !win.isDestroyed() && win.isVisible() ? win : null, delayMs: 1500 });
}

async function withOwner(purpose, fn) {
  const owner = await helloOwner(purpose);
  try {
    return await fn(owner.hwnd);
  } finally {
    owner.done();
  }
}

// Made on first use: unlock.js and this module import each other through the main modules (no access while loading).
let instance = null;
function hello() {
  instance ??= new HelloUnlock({
    service: unlockService,
    hello: {
      status: () => backend.status(),
      // #537 stage 4: the Hello dialog has an owner that says who asks and for what (desktop/main/hello-window.js).
      create: (name, challenge, purpose) => withOwner(purpose, (hwnd) => backend.create(name, challenge, hwnd)),
      sign: (name, challenge, purpose) => withOwner(purpose, (hwnd) => backend.sign(name, challenge, hwnd)),
      remove: (name) => backend.remove(name),
      attested,
      allowed: helloAllowed,
      confirmExtension,
    },
  });
  return instance;
}

export const helloUnlock = {
  info: () => hello().info(),
  enable: (password) => hello().enable(password),
  disable: (password) => hello().disable(password),
  proveDk: (purpose) => hello().proveDk(purpose),
  unlock: () => hello().unlock(),
  unlockForExtension: () => hello().unlockForExtension(),
};

/**
 * #537 stage 4: a fresh Windows Hello confirmation for one gate use (passkey, copy, export, admin mode). Konrad: proofs
 * are purpose-bound and used once – nothing of this answer is kept, the next use asks again; the DK it unwraps is
 * dropped here (it proves the person, it opens nothing).
 */
export async function helloProof(purpose) {
  await helloUnlock.proveDk(purpose);
  diag(`UNLOCK windows hello proof (${purpose})`);
  return true;
}
