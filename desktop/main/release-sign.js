// Release signing in the app (#378, #375). Only desktop/main/api/release.js (and the smoke hook in smoke-release.js)
// import this module; agents, the browser bridge and the Windows provider never do (npm run check enforces it).
//
// Flow: the person picks the release folder in a native dialog of this process (no path comes from outside) → the
// folder is read once and checked against the hashes in latest.yml (desktop/release-files.js) → an own window shows
// version, commit and hashes with a waiting time → with a registered hardware key (#417) the key must sign the release
// challenge → the folder is read again, the manifest bytes and every hash must be unchanged → latest.yml.sig2 is
// written. The signature is the hardware key's assertion (phase 2); desktop/release-key.js keeps the key records.

import { BrowserWindow, app, ipcMain, safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { here, demo, smokeTest } from './boot.js';
import { addApproverBytes, approverNumber, createKeyStore, removeApproverBytes, updateKeyElement, updateKeyLine } from '../release-key.js';
import { inspectRelease } from '../release-files.js';
import { CONFIRM_DELAY_MS, releaseDialogHtml } from '../release-dialog.js';
import { releaseChallenge, encodeAssertion, verifyManifest } from '../update-verify.js';
import { appSigningRefusal } from './release-gate.js';
import { passkeyCeremony } from './passkey-window.js';
import { cardPlacement, showCard } from './confirm-card.js';

export const SIGNATURE_FILE = 'latest.yml.sig2';

export const refusal = () => appSigningRefusal(app, { demo, smoke: smokeTest });

let store = null;
export function keyStore() {
  store ||= createKeyStore({
    file: path.join(app.getPath('userData'), 'release-signing.bin'),
    encrypt: async (text) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Der Windows-Schutz (DPAPI) ist nicht verfügbar – der Schlüssel wird nicht unverschlüsselt gespeichert.');
      return safeStorage.encryptStringAsync(text);
    },
    decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
  });
  return store;
}

/**
 * The approval dialog in its own window with its own preload. → { result: Promise<boolean>, window }.
 * Closing the window is a "no" and always works (also when the page hangs). Navigation and new windows are blocked; only
 * the answer of this window's own page counts. The window is shown only after its page reported content; a page that
 * fails to load, loses its preload, crashes, hangs or stays empty makes `result` reject with a plain message and the
 * window is closed (a black window nobody can close is worse than no window).
 */
export function openApprovalDialog(info, { approverRequired = false, delayMs = CONFIRM_DELAY_MS, parent, loadTimeoutMs = 10_000 } = {}) {
  const [width, height] = [780, 660];
  const id = randomUUID();
  const nonce = randomBytes(16).toString('base64');
  const window = new BrowserWindow({
    parent: (!smokeTest && parent) || undefined,
    // #459: a frameless, rounded card (no Windows title bar) at the top centre over the app window (or the screen).
    width,
    height,
    ...cardPlacement(width, parent, height),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    minimizable: false,
    closable: true,
    alwaysOnTop: !smokeTest,
    show: false,
    title: 'Release signieren',
    webPreferences: { preload: path.join(here, 'release-window', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--release-dialog=${id}`], partition: `release-${id}` },
  });
  window.removeMenu();
  const wc = window.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const result = new Promise((resolve, reject) => {
    const channel = `release:decide:${id}`;
    const readyChannel = `release:ready:${id}`;
    let settled = false;
    let timer = null;
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(channel, onDecide);
      ipcMain.removeListener(readyChannel, onReady);
      if (!window.isDestroyed()) window.destroy();
      settle();
    };
    const fail = (why) => finish(() => reject(new Error(`Das Freigabefenster konnte nicht angezeigt werden (${why}). Es wurde nichts signiert.`)));
    const onDecide = (event, yes) => {
      if (event.sender === wc) finish(() => resolve(yes === true)); // another sender is ignored, it can neither confirm nor cancel
    };
    const onReady = (event, filled) => {
      if (event.sender !== wc) return;
      clearTimeout(timer);
      if (filled !== true) {
        fail('Inhalt leer');
        return;
      }
      showCard(window, id);
    };
    ipcMain.on(channel, onDecide);
    ipcMain.on(readyChannel, onReady);
    // X, Alt+F4 or the task bar: a "no", executed here and not through the page, so a hanging page cannot hold it open.
    window.on('close', (e) => { e.preventDefault(); finish(() => resolve(false)); });
    window.on('closed', () => finish(() => resolve(false)));
    wc.on('did-fail-load', (_e, code, description) => fail(`${description || 'Laden'} ${code}`));
    wc.on('preload-error', (_e, _file, error) => fail(`Vorlade-Skript: ${error?.message || 'Fehler'}`));
    wc.on('render-process-gone', (_e, details) => fail(`Anzeige beendet: ${details?.reason || 'unbekannt'}`));
    wc.on('unresponsive', () => fail('Anzeige reagiert nicht'));
    timer = setTimeout(() => fail('Zeitüberschreitung'), loadTimeoutMs);
  });
  // The caller awaits right after; until then a rejection must not count as unhandled.
  result.catch(() => {});
  wc.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(releaseDialogHtml(info, { nonce, delayMs, approverRequired })).toString('base64')}`).catch(() => {});
  return { result, window };
}

/**
 * The hardware key signs the release challenge of these bytes and releases its PRF secret in the same touch.
 * → { assertion (JSON as in latest.yml.sig2), credentialId, prfOutput }
 */
async function approveWithKey(bytes, approvers) {
  const r = await passkeyCeremony({
    mode: 'approve', containerName: 'Release-Signatur', challenge: releaseChallenge(bytes),
    credentials: approvers.map((a) => ({ credentialId: a.credentialId, prfSalt: a.prfSalt })), autoStart: !smokeTest,
  });
  const raw = (b64) => Buffer.from(b64, 'base64');
  return { assertion: encodeAssertion({ authData: raw(r.authData), clientDataJSON: raw(r.clientDataJSON), signature: raw(r.signature) }), credentialId: r.credentialId, prfOutput: r.prfOutput };
}

const registerWithKey = () => passkeyCeremony({ mode: 'approver-register', containerName: 'Release-Signatur', userName: 'Keevault Release', autoStart: !smokeTest });

const same = (a, b) => a.manifest.equals(b.manifest) && a.installer.sha512 === b.installer.sha512 && a.sums === b.sums && JSON.stringify(a.files) === JSON.stringify(b.files);

/**
 * deps (defaults for the app, replaced only by the smoke hook): keyStore, confirm(info, options) → Promise<boolean>,
 * approve(bytes, approvers) → proof, refusal(). → { version, file } or null when the person said no.
 * Phase 2 (#378): the signature is the hardware key's own WebAuthn assertion over the release challenge; the software
 * key signs nothing any more. Without a registered approver there is nothing to sign with.
 */
export function createReleaseSigning({ keyStore: ks, confirm, approve = approveWithKey, refusal: refused = refusal }) {
  return async function signReleaseFolder(dir) {
    const why = refused();
    if (why) throw new Error(why);
    const approvers = ks.hasKey() ? await ks.approvers() : [];
    if (!approvers.length) throw new Error('Es ist noch kein Sicherheitsschlüssel als Freigeber eingetragen. Erst „Release-Schlüssel einrichten“.');
    const info = await inspectRelease(dir);
    if (!(await confirm(info, { approverRequired: true }))) return null;
    const proof = await approve(info.manifest, approvers);
    const signature = await ks.attest(info.manifest, proof);
    if (!verifyManifest(info.manifest, signature, approvers)) throw new Error('Die Signatur passt zu keinem eingetragenen Freigeber – nichts geschrieben.');
    // The folder may have changed while the person decided: signed is only what was shown.
    if (!same(info, await inspectRelease(dir))) throw new Error('Der Release-Ordner hat sich während der Freigabe geändert – nichts geschrieben.');
    const file = path.join(dir, SIGNATURE_FILE);
    try {
      fs.writeFileSync(file, signature);
    } catch (e) {
      throw new Error(`Die Signatur konnte nicht nach ${file} geschrieben werden (${e.code || e.message}).`);
    }
    return { version: info.version, file };
  };
}

export const signReleaseFolder = (dir, parent) => createReleaseSigning({
  keyStore: keyStore(),
  confirm: (info, options) => openApprovalDialog(info, { ...options, parent }).result,
})(dir).catch((e) => {
  // Every stop says why (#428): a missing file is named, nothing ends silently.
  if (e?.code === 'ENOENT') throw new Error(`Datei nicht gefunden: ${e.path || dir}`);
  throw e;
});

/**
 * Setup: the key (once) and a FIDO2 hardware key as approver (B1, B2). Goes through the waiting-time dialog; a further
 * approver needs the touch of an existing one over exactly that new credential. → { publicKey } for UPDATE_KEYS, or null.
 */
export function createReleaseSetup({ keyStore: ks, confirm, register = registerWithKey, approve = approveWithKey, refusal: refused = refusal }) {
  return async function setupApprover() {
    const why = refused();
    if (why) throw new Error(why);
    const existing = ks.hasKey() ? await ks.approvers() : [];
    if (!(await confirm({ setup: true, existing: existing.length, publicKey: ks.hasKey() ? await ks.publicKey() : '' }, { approverRequired: existing.length > 0 }))) return null;
    const reg = await register();
    if (reg.attachment !== 'cross-platform') throw new Error('Als Freigeber zählt nur ein FIDO2-Sicherheitsschlüssel, kein Windows Hello.');
    if (!reg.prfEnabled) throw new Error('Dieser Sicherheitsschlüssel unterstützt hmac-secret (PRF) nicht – damit lässt sich der Signierschlüssel nicht schützen.');
    const credential = { credentialId: reg.credentialId, publicKey: reg.publicKey, authData: Buffer.from(reg.authData, 'base64'), attachment: reg.attachment, prfSalt: randomBytes(32).toString('base64url') };
    // The new key proves itself and hands over its PRF secret in one touch (nothing is stored before that worked).
    const own = await approve(Buffer.from(`setup|${credential.credentialId}`), [credential]);
    credential.prfOutput = own.prfOutput;
    // First approver: the secret must come out the same on a second touch before the key is wrapped for it (C2).
    if (!existing.length) {
      const again = await approve(Buffer.from(`setup-check|${credential.credentialId}`), [credential]);
      if (again.prfOutput !== own.prfOutput) throw new Error('Der Sicherheitsschlüssel liefert bei der zweiten Berührung ein anderes hmac-secret – nichts gespeichert.');
    }
    const proof = existing.length ? await approve(addApproverBytes(credential), existing) : null;
    // No key yet: it is created wrapped from the start, never stored in plain (C4). A phase-1 key gets its first approver here.
    if (!ks.hasKey()) await ks.generate(credential);
    else await ks.addApprover(credential, proof);
    return releaseApprovers(ks, credential.credentialId);
  };
}

/**
 * The registered security keys as UPDATE_KEYS elements (public parts only):
 * { approvers: [{ id, credentialId, line }], added (the one just entered, or null), publicKey (its line, or '') }.
 */
export async function releaseApprovers(ks, addedCredentialId = null) {
  const list = ks.hasKey() ? await ks.approvers() : [];
  const approvers = list.map((a, i) => ({ id: updateKeyElement(a, approverNumber(a, i)).id, credentialId: a.credentialId, line: updateKeyLine(a, approverNumber(a, i)) }));
  const added = approvers.find((a) => a.credentialId === addedCredentialId) || null;
  return { approvers, added, publicKey: added?.line || '' };
}

/**
 * Removing an approver (#437, lost key). Goes through the waiting-time dialog; then another registered approver must
 * touch its key over exactly the credential being removed (the ceremony offers only the others). The last one stays.
 * → releaseApprovers of the remaining ones, or null when the person said no.
 */
export function createReleaseRemoval({ keyStore: ks, confirm, approve = approveWithKey, refusal: refused = refusal }) {
  return async function removeApprover(credentialId) {
    const why = refused();
    if (why) throw new Error(why);
    const list = ks.hasKey() ? await ks.approvers() : [];
    const index = list.findIndex((a) => a.credentialId === credentialId);
    if (index < 0) throw new Error('Dieser Sicherheitsschlüssel ist nicht als Freigeber eingetragen.');
    if (list.length < 2) throw new Error('Der letzte Freigeber lässt sich nicht entfernen – ohne ihn ließe sich der Signierschlüssel nicht mehr öffnen.');
    const target = list[index];
    const info = { remove: true, id: updateKeyElement(target, approverNumber(target, index)).id, credentialId: target.credentialId, remaining: list.length - 1 };
    if (!(await confirm(info, { approverRequired: true }))) return null;
    const proof = await approve(removeApproverBytes(target), list.filter((a) => a !== target));
    await ks.removeApprover(target.credentialId, proof);
    return releaseApprovers(ks);
  };
}

export const removeReleaseApprover = (credentialId, parent) => createReleaseRemoval({
  keyStore: keyStore(),
  confirm: (info, options) => openApprovalDialog(info, { ...options, parent }).result,
})(credentialId);

export const setupReleaseKey = (parent) => createReleaseSetup({
  keyStore: keyStore(),
  confirm: (info, options) => openApprovalDialog(info, { ...options, parent }).result,
})();

/** Smoke hook only (api/release.js smokeRelease): a key store with a reversible fake "encryption" in a test folder. */
export function testKeyStore(file) {
  if (!smokeTest || app.isPackaged) throw new Error('testKeyStore nur im Testlauf');
  return createKeyStore({ file, encrypt: (text) => Buffer.from(text, 'utf8').reverse(), decrypt: (data) => Buffer.from(data).reverse().toString('utf8') });
}
