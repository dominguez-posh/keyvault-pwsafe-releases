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
//     approver without the touch of an existing one is refused and adds nothing,
//   - removing (#437): the dialog names the key, cancel removes nothing, the removed key cannot confirm itself and is
//     not offered, another key's touch removes it, it opens nothing afterwards, the last one stays; Developer builds only.

import crypto from 'node:crypto';
import { overrideBuildKindForSmoke } from './build-kind.js';
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
  if (await api.removeReleaseApprover().then(() => true, (e) => !/Test/.test(e.message))) fail(area, 'removeReleaseApprover did not refuse in a test run');

  // 1b. Build kind (#445): a release build refuses every signing route with its own message and offers no menu entries; the
  // smoke itself is a Developer build, whose refusal is the test-run one checked above.
  overrideBuildKindForSmoke({ developer: false, commit: '' });
  try {
    const noDev = (e) => /Developer-Build/.test(e.message);
    if ((await api.state()).releaseSigning !== false) fail(area, 'release build offers the signing menu entries');
    const st = await api.releaseSigningStatus();
    if (st.available || !/Developer-Build/.test(st.reason || '')) fail(area, `release build: signing status is not refused (${JSON.stringify(st)})`);
    for (const route of ['signRelease', 'setupReleaseKey', 'showReleaseApprovers', 'removeReleaseApprover']) {
      if (await api[route]().then(() => true, (e) => !noDev(e))) fail(area, `${route} did not refuse in a release build`);
    }
  } finally { overrideBuildKindForSmoke(null); }

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
  // #459: a card, not a window with a title bar: rounded card element, fixed size, no menu, no frame (window and content
  // the same height, a title bar would add about 30); Esc (a real key) cancels. The size is 780 x 660 as requested; Windows
  // at a scale above 100 % reports a frameless transparent window a few pixels larger (785 x 663 at 125 %), so up to 8 more.
  const bounds = closing.window.getBounds();
  const content = closing.window.getContentBounds();
  const look = { card: await closing.window.webContents.executeJavaScript('!!document.querySelector(".card") && getComputedStyle(document.querySelector(".card")).borderTopLeftRadius === "16px"'), resizable: closing.window.isResizable(), menu: closing.window.isMenuBarVisible(), bounds, content };
  const near = (value, size) => value >= size && value <= size + 8;
  if (!look.card || look.resizable || look.menu || bounds.height - content.height > 2 || !near(content.width, 780) || !near(content.height, 660)) fail(area, `the release dialog is not the frameless card (${JSON.stringify(look)})`);
  const escWin = lab.openApprovalDialog(probeInfo, { approverRequired: true, delayMs: DELAY });
  for (let i = 0; i < 40 && !(await escWin.window.webContents.executeJavaScript('!!document.getElementById("go")').catch(() => false)); i++) await sleep(100);
  escWin.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  escWin.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  if ((await Promise.race([escWin.result, sleep(2000).then(() => 'timeout')])) !== false) fail(area, 'Esc does not cancel the release dialog');
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

  // 6. #459 (Konrad): the confirmation card. Enter with the focus on "deny" confirms nothing; on the default card (also the
  // browser approval) Enter confirms after the waiting time, Esc denies. Real key events of the engine, after the waiting time.
  const card = async (extra) => {
    let cardWin = null;
    const answer = lab.confirmInCard({ title: 'Smoke-Karte', detail: 'Nur ein Test', go: 'Erlauben', cancel: 'Ablehnen', ...extra }, { delayMs: DELAY, onWindow: (w) => { cardWin = w; } });
    for (let i = 0; i < 40 && !(cardWin && (await cardWin.webContents.executeJavaScript('!!document.getElementById("go")').catch(() => false))); i++) await sleep(100);
    await sleep(DELAY + 600);
    const press = (keyCode) => { cardWin.webContents.sendInputEvent({ type: 'keyDown', keyCode }); cardWin.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode }); cardWin.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
    return { answer, cardWin, press };
  };
  if (!lab.confirmInCard) fail(area, 'smoke hook offers no confirmation card');
  else {
    const onDeny = await card({});
    await onDeny.cardWin.webContents.executeJavaScript('document.getElementById("no").focus(); true');
    onDeny.press('Enter');
    if ((await Promise.race([onDeny.answer, sleep(1500).then(() => 'timeout')])) === true) fail(area, '#459: Enter with the focus on "Ablehnen" confirmed the card');
    if (!onDeny.cardWin.isDestroyed()) onDeny.cardWin.close();
    // Browser approval = the default card (Lucas, 2026-11-08): Enter confirms after the waiting time.
    const browserCard = await card({});
    browserCard.press('Enter');
    if ((await Promise.race([browserCard.answer, sleep(1500).then(() => 'timeout')])) !== true) fail(area, '#459: Enter after the waiting time did not confirm the browser approval card');
    if (!browserCard.cardWin.isDestroyed()) browserCard.cardWin.close();
    const escCard = await card({});
    escCard.press('Escape');
    if ((await Promise.race([escCard.answer, sleep(1500).then(() => 'timeout')])) !== false) fail(area, '#459: Esc does not deny the browser approval card');
    // A minimised app window (Windows reports -32000) is restored first and the card lands inside a screen's work area.
    let restored = false;
    const minimised = { isDestroyed: () => false, isMinimized: () => !restored, restore: () => { restored = true; }, isVisible: () => true, getBounds: () => ({ x: -32000, y: -32000, width: 160, height: 28 }) };
    const at = lab.cardPlacement(780, minimised, 660);
    const inside = lab.workAreas().some((w) => at.x >= w.x && at.y >= w.y && at.x + Math.min(780, w.width) <= w.x + w.width && at.y + Math.min(660, w.height) <= w.y + w.height);
    if (!restored || !inside) fail(area, `#459: card for a minimised app window not restored or outside the work area (${JSON.stringify(at)})`);
  }

  // 7. Removing an approver (#437, lost key): the dialog first, then the touch of another registered key; the last one
  // stays, the removed one opens nothing any more. Fake keys only.
  const store3 = lab.testKeyStore(keyFile());
  const k1 = fakeKey('cred-r1');
  const k2 = fakeKey('cred-r2');
  const keyOf = { 'cred-r1': [k1, prfSecret()], 'cred-r2': [k2, prfSecret()] };
  const asCred = (id) => ({ credentialId: id, publicKey: keyOf[id][0].publicKey, authData: keyOf[id][0].authData, attachment: 'cross-platform', prfSalt: 'c2FsdA', prfOutput: keyOf[id][1] });
  const answer = (id, bytes) => ({ assertion: assertionFor(bytes, keyOf[id][0].pair), credentialId: id, prfOutput: keyOf[id][1] });
  await store3.generate(asCred('cred-r1'));
  await store3.addApprover(asCred('cred-r2'), answer('cred-r1', Buffer.from(`add-approver|cred-r2|${k2.publicKey}`)));
  const count3 = async () => (await store3.approvers()).length;
  let offered = null;
  const approveAs = (id) => async (bytes, list) => { offered = list.map((a) => a.credentialId); return answer(id, bytes); };
  dialog = null;
  const cancelRemove = lab.remove({ keyStore: store3, confirm, approve: approveAs('cred-r1') })('cred-r2');
  await waitDialog();
  const removeText = await text();
  if (!removeText.includes('cred-r2') || !/Freigeber entfernen/.test(removeText)) fail(area, 'remove: the dialog does not name the key being removed');
  await dialog.window.webContents.executeJavaScript('document.getElementById("no").click(); true');
  if ((await cancelRemove.catch(() => 'error')) !== null || offered || (await count3()) !== 2) fail(area, 'remove: a cancel still asked for a touch or removed the key');
  const self = await lab.remove({ keyStore: store3, confirm: async () => true, approve: approveAs('cred-r2') })('cred-r2').then(() => null, (e) => e.message);
  if (!/anderer eingetragener Freigeber/.test(self || '') || (await count3()) !== 2) fail(area, `remove: the key being removed confirmed its own removal (${self})`);
  if (JSON.stringify(offered) !== '["cred-r1"]') fail(area, `remove: the ceremony offers the key being removed (${JSON.stringify(offered)})`);
  const removed = await lab.remove({ keyStore: store3, confirm: async () => true, approve: approveAs('cred-r1') })('cred-r2').catch((e) => ({ error: e.message }));
  if (removed?.approvers?.length !== 1 || (await count3()) !== 1) fail(area, `remove: another key's touch did not remove the approver (${JSON.stringify(removed)})`);
  const m = Buffer.from('version: 9.9.9\n');
  if (await store3.attest(m, answer('cred-r2', m)).then(() => true, () => false)) fail(area, 'remove: the removed approver still releases a signature');
  if (await store3.sign(m, answer('cred-r2', m)).then(() => true, () => false)) fail(area, 'remove: the removed approver still opens the key');
  if (!(await store3.attest(m, answer('cred-r1', m)).then(() => true, () => false))) fail(area, 'remove: the approver who stays no longer works');
  const last = await lab.remove({ keyStore: store3, confirm: async () => true, approve: approveAs('cred-r1') })('cred-r1').then(() => null, (e) => e.message);
  if (!/letzte Freigeber/.test(last || '') || (await count3()) !== 1) fail(area, `remove: the last approver could be removed (${last})`);
  for (const d of [dir, cancelled.dir, changed.dir, late.dir, gated.dir, swapped.dir]) fs.rmSync(d, { recursive: true, force: true });
}
