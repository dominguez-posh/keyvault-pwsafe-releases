// Smoke check of release signing (#378, #417), part of the feature checks (desktop/smoke-features.js). Written with
// test keys and a test folder only; nothing real is signed. Checked:
//   - a test run refuses to sign and the menu entries are off (the real signing path is closed in tests),
//   - the approval dialog (own window, hidden) shows the values recomputed here, Enter and a synthetic click right at
//     the start confirm nothing, a real click after the waiting time does,
//   - phase 2 (#378): the written latest.yml.sig2 is the hardware key's assertion (test key) and verifies against its
//     UPDATE_KEYS element; without a registered approver nothing is signed,
//   - the window (#378 black window): closing it is a cancel, a page that does not report content in time rejects with a
//     plain message and the window is gone, the page has content,
//   - counter-tests: cancel writes no file, a changed installer gets no dialog, an installer changed while the dialog
//     was open gets no signature, a file swapped after the checksum list was made gets no dialog (B5), a registered
//     hardware key without its answer gets no signature (a click is not enough),
//   - setup (B1, B2): cancelling creates no key, Windows Hello and a key without hmac-secret are refused, a further
//     approver without the touch of an existing one is refused and adds nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyManifest, releaseChallenge, encodeAssertion } from './update-verify.js';

const DELAY = 1200;

const prfSecret = () => crypto.randomBytes(32).toString('base64');
/** A registration the way a security key reports it: P-256 key, user presence, attested credential data. */
function fakeKey(credentialId) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16, 7), Buffer.from([0, 4]), Buffer.from(credentialId)]);
  return { publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), authData, pair };
}

/** What a hardware key answers for these manifest bytes: the WebAuthn assertion over the release challenge (touch + PIN). */
function assertionFor(manifest, pair) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: releaseChallenge(manifest), origin: 'http://localhost', crossOrigin: false }));
  const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), pair.privateKey);
  return encodeAssertion({ authData, clientDataJSON, signature });
}

function testRelease() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-smoke-release-'));
  const installer = Buffer.from('smoke installer');
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  fs.writeFileSync(path.join(dir, 'Keevault-Setup-9.9.9.exe'), installer);
  fs.writeFileSync(path.join(dir, 'Keevault.msi'), 'smoke msi');
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${['Keevault-Setup-9.9.9.exe', 'Keevault.msi'].map((f) => `${sha256(f)}  ${f}`).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: Keevault-Setup-9.9.9.exe\n    sha512: ${sha512}\n    size: 15\npath: Keevault-Setup-9.9.9.exe\nsha512: ${sha512}\nkvSha256Sums: ${sha256('SHA256SUMS.txt')}\n`);
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: '9.9.9', commit: 'abc1234', clean: true, channel: 'beta' }));
  return { dir, sha512 };
}

export async function releaseSignCheck({ api, fail, sleep, release }) {
  const area = 'releasesign';
  // 1. The real path stays closed in a test run.
  const status = await api.releaseSigningStatus();
  if (status.available || !/Test/.test(status.reason || '')) fail(area, `signing is not refused in a test run (${JSON.stringify(status)})`);
  if ((await api.state()).releaseSigning !== false) fail(area, 'state offers the menu entries "Release signieren" in a test run');
  if (await api.signRelease().then(() => true, (e) => !/Test/.test(e.message))) fail(area, 'signRelease did not refuse in a test run');
  if (await api.setupReleaseKey().then(() => true, (e) => !/Test/.test(e.message))) fail(area, 'setupReleaseKey did not refuse in a test run');

  // 2. The dialog and the signature with a test key.
  const lab = release();
  const keyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kv-smoke-key-')), 'key.bin');
  const store = lab.testKeyStore(keyFile());
  const hw = fakeKey('cred-sign');
  await store.generate({ credentialId: 'cred-sign', publicKey: hw.publicKey, authData: hw.authData, attachment: 'cross-platform', prfSalt: 'c2FsdA', prfOutput: prfSecret() });
  const element = { alg: 'es256', publicKey: hw.publicKey, credentialId: 'cred-sign' };
  let touched = 0;
  const approve = async (bytes) => { touched += 1; return { assertion: assertionFor(bytes, hw.pair), credentialId: 'cred-sign', prfOutput: prfSecret() }; };
  const noApprover = lab.testKeyStore(keyFile());
  await noApprover.generate();
  const none = await lab.sign({ keyStore: noApprover, confirm: async () => true, approve })(testRelease().dir).then(() => null, (e) => e.message);
  if (!/Freigeber/.test(none || '') || touched) fail(area, `a key store without approver still got to sign (${none})`);
  let dialog = null;
  const confirm = (info, options) => {
    dialog = lab.openApprovalDialog(info, { ...options, delayMs: DELAY });
    return dialog.result;
  };
  const text = () => dialog.window.webContents.executeJavaScript('document.body.innerText');
  const waitDialog = async () => {
    for (let i = 0; i < 40 && !dialog; i++) await sleep(100);
    if (!dialog) throw new Error('approval dialog did not open');
    for (let i = 0; i < 40 && !(await dialog.window.webContents.executeJavaScript('!!document.getElementById("go")').catch(() => false)); i++) await sleep(100);
  };

  const { dir, sha512 } = testRelease();
  const signing = lab.sign({ keyStore: store, confirm, approve })(dir);
  let settled = false;
  signing.then(() => { settled = true; }, () => { settled = true; });
  await waitDialog();
  const shown = await text();
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'Keevault-Setup-9.9.9.exe'))).digest('hex');
  for (const { what, value } of [{ what: 'version', value: '9.9.9' }, { what: 'commit', value: 'abc1234' }, { what: 'installer sha512', value: sha512 }, { what: 'file sha256', value: sha256 }]) {
    if (!shown.includes(value)) fail(area, `dialog does not show the recomputed ${what}`);
  }
  // Enter and a synthetic click right at the start: nothing happens.
  await dialog.window.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); document.getElementById("go").click(); true');
  await sleep(400);
  if (settled) fail(area, 'Enter or a synthetic click confirmed the dialog');
  if ((await dialog.window.webContents.executeJavaScript('document.getElementById("go").getAttribute("aria-disabled")')) !== 'true') fail(area, 'confirm button is not locked during the waiting time');
  // After the waiting time a real click confirms (input event of the browser engine, not a script click).
  await sleep(DELAY + 600);
  const rect = JSON.parse(await dialog.window.webContents.executeJavaScript('(() => { const r = document.getElementById("go").getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()'));
  const wc = dialog.window.webContents;
  wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  const outcome = await Promise.race([signing, sleep(4000).then(() => 'timeout')]).catch((e) => `error: ${e.message}`);
  const sig = path.join(dir, 'latest.yml.sig2');
  if (outcome === 'timeout' || typeof outcome === 'string') fail(area, `a real click after the waiting time did not sign (${outcome})`);
  else if (!fs.existsSync(sig) || !verifyManifest(fs.readFileSync(path.join(dir, 'latest.yml')), fs.readFileSync(sig, 'utf8'), [element])) fail(area, 'no valid latest.yml.sig2 (hardware key assertion) after confirming');
  else if (!fs.readFileSync(sig, 'utf8').trim().startsWith('{')) fail(area, 'latest.yml.sig2 is not an assertion of the hardware key');

  // 3. Counter-tests.
  const cancelled = testRelease();
  dialog = null;
  const cancelling = lab.sign({ keyStore: store, confirm, approve })(cancelled.dir);
  await waitDialog();
  await dialog.window.webContents.executeJavaScript('document.getElementById("no").click(); true');
  if ((await cancelling.catch(() => 'error')) !== null || fs.existsSync(path.join(cancelled.dir, 'latest.yml.sig2'))) fail(area, 'cancel still produced a signature');

  const changed = testRelease();
  fs.writeFileSync(path.join(changed.dir, 'Keevault-Setup-9.9.9.exe'), 'changed after the hash');
  let asked = false;
  const refused = await lab.sign({ keyStore: store, approve, confirm: () => { asked = true; return Promise.resolve(true); } })(changed.dir).then(() => null, (e) => e.message);
  if (asked || !/sha512/.test(refused || '') || fs.existsSync(path.join(changed.dir, 'latest.yml.sig2'))) fail(area, `a changed installer got a dialog or a signature (${refused})`);

  const late = testRelease();
  const tooLate = await lab.sign({
    keyStore: store,
    approve,
    confirm: () => { fs.writeFileSync(path.join(late.dir, 'Keevault-Setup-9.9.9.exe'), 'changed while the dialog was open'); return Promise.resolve(true); },
  })(late.dir).then(() => null, (e) => e.message);
  if (!tooLate || fs.existsSync(path.join(late.dir, 'latest.yml.sig2'))) fail(area, 'an installer changed during the approval still got signed');

  // 4. #417: with a registered hardware key a confirmed dialog is not enough.
  const guarded = store;
  const gated = testRelease();
  const withoutKey = await lab.sign({ keyStore: guarded, confirm: () => Promise.resolve(true), approve: async () => null })(gated.dir).then(() => null, (e) => e.message);
  if (!/Freigabe/.test(withoutKey || '') || fs.existsSync(path.join(gated.dir, 'latest.yml.sig2'))) fail(area, `a confirmed dialog without the hardware key's answer still signed (${withoutKey})`);
  // B5: a file swapped after the checksum list was made gets no dialog.
  const swapped = testRelease();
  fs.writeFileSync(path.join(swapped.dir, 'Keevault.msi'), 'swapped after the list was made');
  let askedSwapped = false;
  const swappedWhy = await lab.sign({ keyStore: store, approve, confirm: () => { askedSwapped = true; return Promise.resolve(true); } })(swapped.dir).then(() => null, (e) => e.message);
  if (askedSwapped || !/SHA256SUMS/.test(swappedWhy || '') || fs.existsSync(path.join(swapped.dir, 'latest.yml.sig2'))) fail(area, `a file swapped after the checksum list got a dialog or a signature (${swappedWhy})`);

  // 4b. The window itself (black-window case): closing is a cancel, a page without content in time is closed with a message.
  const probe = testRelease();
  const probeInfo = await (await import('./release-files.js')).inspectRelease(probe.dir);
  const closing = lab.openApprovalDialog(probeInfo, { approverRequired: true, delayMs: DELAY });
  for (let i = 0; i < 40 && !(await closing.window.webContents.executeJavaScript('!!document.getElementById("go")').catch(() => false)); i++) await sleep(100);
  if (!(await closing.window.webContents.executeJavaScript('document.body.innerText')).includes('9.9.9')) fail(area, 'the dialog page has no content');
  closing.window.close();
  if ((await Promise.race([closing.result, sleep(2000).then(() => 'timeout')])) !== false || !closing.window.isDestroyed()) fail(area, 'closing the window is not a cancel that always works');
  const slow = lab.openApprovalDialog(probeInfo, { approverRequired: true, delayMs: DELAY, loadTimeoutMs: 1 });
  const slowWhy = await Promise.race([slow.result.then(() => 'resolved', (e) => e.message), sleep(3000).then(() => 'timeout')]);
  if (!/Freigabefenster/.test(slowWhy) || !slow.window.isDestroyed()) fail(area, `a window that does not load in time is not closed with a message (${slowWhy})`);
  fs.rmSync(probe.dir, { recursive: true, force: true });

  // 5. Setup (B1, B2) with fake keys: no ceremony, no real key.
  const fresh = lab.testKeyStore(keyFile());
  if ((await lab.setup({ keyStore: fresh, confirm: async () => false })()) !== null || fresh.hasKey()) fail(area, 'cancelling the setup still created a key');
  const rejects = async (deps, pattern, what) => {
    const why = await lab.setup({ confirm: async () => true, ...deps })().then(() => null, (e) => e.message);
    if (!pattern.test(why || '')) fail(area, `setup: ${what} was not refused (${why})`);
  };
  const reg = (over) => async () => ({ ...fakeKey('cred-1'), credentialId: 'cred-1', attachment: 'cross-platform', prfEnabled: true, ...over, authData: (over?.authData || fakeKey('cred-1').authData).toString('base64') });
  const fixedSecret = prfSecret();
  const own = async () => ({ prfOutput: fixedSecret }); // the same secret on every touch, as a real key gives it
  const store2 = lab.testKeyStore(keyFile());
  await rejects({ keyStore: store2, register: reg({ attachment: 'platform' }), approve: own }, /Windows Hello/, 'Windows Hello as approver');
  await rejects({ keyStore: store2, register: reg({ prfEnabled: false }), approve: own }, /hmac-secret/, 'a key without hmac-secret');
  if ((await store2.approvers()).length) fail(area, 'a refused setup still registered an approver');
  const first = await lab.setup({ keyStore: store2, confirm: async () => true, register: reg(), approve: own })();
  if (!first?.publicKey || !/alg: 'es256'/.test(first.publicKey) || !first.publicKey.includes('cred-1') || (await store2.approvers()).length !== 1) fail(area, 'the first approver was not registered or gave no UPDATE_KEYS element');
  else if (await store2.sign(Buffer.from('x')).then(() => true, () => false)) fail(area, 'with an approver the key still signs without its answer');
  await rejects({ keyStore: store2, register: reg({ credentialId: 'cred-2', publicKey: fakeKey('cred-2').publicKey }), approve: async (bytes, list) => (list.some((a) => a.credentialId === 'cred-1') ? { assertion: '', credentialId: 'cred-1', prfOutput: prfSecret() } : own()) }, /vorhandener Freigeber/, 'a further approver without the existing one\'s touch');
  if ((await store2.approvers()).length !== 1) fail(area, 'a further approver was added without the touch of an existing one');
  for (const d of [dir, cancelled.dir, changed.dir, late.dir, gated.dir, swapped.dir]) fs.rmSync(d, { recursive: true, force: true });
}
