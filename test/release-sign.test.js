import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRelease } from '../desktop/release-files.js';
import { createKeyStore, checkApproverCredential, addApproverBytes, removeApproverBytes, approverNumber, updateKeyElement, updateKeyLine } from '../desktop/release-key.js';
import { verifyManifest, releaseChallenge, encodeAssertion } from '../desktop/update-verify.js';
import { AAGUID } from '../extension/core/webauthn.js';
import { releaseDialogHtml } from '../desktop/release-dialog.js';
import { signingRefusal } from '../desktop/main/release-gate.js';

// Test keys and test files only – nothing here touches a real key.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kv-release-'));

function fakeRelease({ tamperInstaller = false, tamperMsi = false, noSumsLine = false, clean = true, commit = 'abc1234' } = {}) {
  const dir = tmp();
  const installer = Buffer.from('installer bytes');
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  fs.writeFileSync(path.join(dir, 'Keevault-Setup-9.9.9.exe'), tamperInstaller ? Buffer.from('other bytes') : installer);
  fs.writeFileSync(path.join(dir, 'Keevault.msi'), 'msi');
  // As scripts/release.mjs does: checksum list of the files, its hash goes into the manifest.
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), ['Keevault-Setup-9.9.9.exe', 'Keevault.msi'].map((f) => `${sha256(f)}  ${f}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'unlisted.txt'), 'not part of the release');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: Keevault-Setup-9.9.9.exe\n    sha512: ${sha512}\n    size: 15\npath: Keevault-Setup-9.9.9.exe\nsha512: ${sha512}\n${noSumsLine ? '' : `kvSha256Sums: ${sha256('SHA256SUMS.txt')}\n`}`);
  if (tamperMsi) fs.writeFileSync(path.join(dir, 'Keevault.msi'), 'swapped after the list was made');
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: '9.9.9', commit, clean, channel: 'beta' }));
  return { dir, sha512 };
}

// "Encryption" for the test: reversible, visibly not the plain record.
const encrypt = (s) => Buffer.from(Buffer.from(s).toString('base64').split('').reverse().join(''));
const decrypt = (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString();
const store = () => createKeyStore({ file: path.join(tmp(), 'k.bin'), encrypt, decrypt });

test('release folder: manifest bytes, hashes and file list come from one read', async () => {
  const { dir, sha512 } = fakeRelease();
  const r = await inspectRelease(dir);
  assert.equal(r.version, '9.9.9');
  assert.equal(r.commit, 'abc1234');
  assert.equal(r.installer.sha512, sha512);
  assert.equal(Buffer.isBuffer(r.manifest), true);
  assert.equal(r.manifestSha512, crypto.createHash('sha512').update(r.manifest).digest('hex'));
  assert.deepEqual(r.files.map((f) => f.name), ['Keevault-Setup-9.9.9.exe', 'Keevault.msi'], 'manifest, signatures and build info are not in the list');
  assert.equal(r.files[1].sha256, crypto.createHash('sha256').update('msi').digest('hex'));
});

test('release folder counter-tests: changed installer, unclean build, missing build info give nothing to sign', async () => {
  await assert.rejects(inspectRelease(fakeRelease({ tamperInstaller: true }).dir), /stimmt nicht mit sha512/);
  await assert.rejects(inspectRelease(fakeRelease({ clean: false }).dir), /unsauberen/);
  await assert.rejects(inspectRelease(fakeRelease({ tamperMsi: true }).dir), /stimmt nicht mit SHA256SUMS/, 'B5: a file swapped after the list was made');
  await assert.rejects(inspectRelease(fakeRelease({ noSumsLine: true }).dir), /kvSha256Sums/, 'B5: the manifest does not carry the list hash'  );
  await assert.rejects(inspectRelease(fakeRelease({ commit: 'not-a-commit' }).dir), /Commit/);
  const noInfo = fakeRelease();
  fs.rmSync(path.join(noInfo.dir, 'build-info.json'));
  await assert.rejects(inspectRelease(noInfo.dir), /build-info/);
  const outside = fakeRelease();
  fs.writeFileSync(path.join(outside.dir, 'latest.yml'), 'version: 9.9.9\npath: ../x.exe\nsha512: a\n');
  await assert.rejects(inspectRelease(outside.dir), /außerhalb/);
});

test('signing key: the record is encrypted, the signature verifies against the public key, a second key is refused', async () => {
  const s = store();
  const pub = await s.generate();
  assert.equal(await s.publicKey(), pub);
  await assert.rejects(s.generate(), /bereits/);
  const manifest = Buffer.from('version: 9.9.9\n');
  const sig = await s.sign(manifest);
  assert.equal(verifyManifest(manifest, sig, [{ alg: 'ed25519', publicKey: pub }]), true);
  assert.equal(verifyManifest(Buffer.from('version: 9.9.8\n'), sig, [{ alg: 'ed25519', publicKey: pub }]), false);
});

// A registration the way a hardware key reports it: rpIdHash, flags, counter, AAGUID, credential id, public key.
function registration({ flags = 0x45, aaguid = Buffer.alloc(16, 1) } = {}) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([flags]), Buffer.alloc(4), aaguid, Buffer.from([0, 4]), Buffer.from('cred')]);
  return { pair, authData, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

test('approver credentials: Keevault itself, synced passkeys, untouched keys, Windows Hello and non-P-256 are refused', () => {
  const ok = { ...registration(), attachment: 'cross-platform' };
  assert.doesNotThrow(() => checkApproverCredential(ok));
  assert.throws(() => checkApproverCredential({ ...ok, attachment: 'platform' }), /Windows Hello/, 'B2: Windows Hello is no approver');
  assert.throws(() => checkApproverCredential({ ...ok, attachment: '' }), /Sicherheitsschlüssel/);
  assert.throws(() => checkApproverCredential({ ...registration({ aaguid: Buffer.from(AAGUID) }), attachment: 'cross-platform' }), /von Keevault selbst/);
  assert.throws(() => checkApproverCredential({ ...registration({ flags: 0x4d }), attachment: 'cross-platform' }), /synchronisiert/, 'BE flag');
  assert.throws(() => checkApproverCredential({ ...registration({ flags: 0x55 }), attachment: 'cross-platform' }), /synchronisiert/, 'BS flag');
  assert.throws(() => checkApproverCredential({ ...registration({ flags: 0x41 }), attachment: 'cross-platform' }), /PIN/, 'C2: no PIN asked (user verification missing)');
  assert.throws(() => checkApproverCredential({ ...registration({ flags: 0x40 }), attachment: 'cross-platform' }), /nicht berührt/);
  assert.throws(() => checkApproverCredential({ ...ok, authData: ok.authData.subarray(0, 40) }), /Unvollständig/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => checkApproverCredential({ ...ok, publicKey: rsa }), /ES256/);
});

/** What a hardware key does: signs authData || SHA-256(clientDataJSON) for the release challenge. */
function assertion(manifest, pair, { challenge, flags = 0x05 } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge ?? releaseChallenge(manifest), origin: 'http://localhost', crossOrigin: false }));
  const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([flags]), Buffer.alloc(4)]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), pair.privateKey);
  return encodeAssertion({ authData, clientDataJSON, signature });
}

const prf = () => crypto.randomBytes(32).toString('base64');
const asApprover = (r, credentialId, prfOutput) => ({ credentialId, publicKey: r.publicKey, authData: r.authData, attachment: 'cross-platform', prfSalt: 'c2FsdA', prfOutput });
const proof = (bytes, hw, credentialId, prfOutput, over) => ({ assertion: assertion(bytes, hw.pair, over), credentialId, prfOutput });
const keyFile = () => path.join(tmp(), 'k.bin');
const rawRecord = (file) => JSON.parse(decrypt(fs.readFileSync(file)));

test('B1: with an approver the signing key is wrapped with its PRF secret; the record alone cannot sign', async () => {
  const file = keyFile();
  const s = createKeyStore({ file, encrypt, decrypt });
  const pub = await s.generate();
  assert.ok(rawRecord(file).pkcs8, 'phase 1: the record holds the key (accepted limit)');
  const hw = registration();
  const secret = prf();
  await s.addApprover(asApprover(hw, 'cred-1', secret));
  const record = rawRecord(file);
  assert.equal(record.pkcs8, undefined, 'no plain key in the record any more');
  assert.equal(JSON.stringify(record).includes(record.approvers[0].wrapped.ct) && record.approvers[0].wrapped.ct.length > 40, true);
  const manifest = Buffer.from('version: 9.9.9\n');
  await assert.rejects(s.sign(manifest), /Freigabe/, 'no proof: no signature (GUI click alone)');
  await assert.rejects(s.sign(manifest, proof(manifest, hw, 'cred-1', prf())), /nicht öffnen/, 'right assertion, wrong secret: the key stays shut');
  await assert.rejects(s.sign(manifest, { assertion: assertion(manifest, hw.pair), credentialId: 'cred-1' }), /nicht öffnen/, 'no secret at all');
  await assert.rejects(s.sign(manifest, proof(Buffer.from('version: 9.9.8\n'), hw, 'cred-1', secret)), /Freigabe/, 'assertion for other bytes');
  await assert.rejects(s.sign(manifest, proof(manifest, hw, 'cred-1', secret, { flags: 0 })), /Freigabe/, 'key not touched');
  await assert.rejects(s.sign(manifest, proof(manifest, registration(), 'cred-1', secret)), /Freigabe/, 'foreign key');
  await assert.rejects(s.sign(manifest, proof(manifest, hw, 'other', secret)), /Freigabe/, 'unknown credential');
  const sig = await s.sign(manifest, proof(manifest, hw, 'cred-1', secret));
  assert.equal(verifyManifest(manifest, sig, [{ alg: 'ed25519', publicKey: pub }]), true);
  assert.equal((await s.approvers())[0].wrapped, undefined, 'the public list never carries the wrapped key');
});

test('B2: a further approver needs the touch of an existing one for exactly that credential; Windows Hello and the first re-entry are refused', async () => {
  const s = createKeyStore({ file: keyFile(), encrypt, decrypt });
  const pub = await s.generate();
  const a = registration();
  const b = registration();
  const secretA = prf();
  const secretB = prf();
  await s.addApprover(asApprover(a, 'cred-a', secretA));
  const second = asApprover(b, 'cred-b', secretB);
  const bytes = addApproverBytes(second);
  await assert.rejects(s.addApprover(second), /vorhandener Freigeber/, 'no proof of an existing approver');
  await assert.rejects(s.addApprover(second, proof(Buffer.from('anderes'), a, 'cred-a', secretA)), /vorhandener Freigeber/, 'proof for other bytes');
  await assert.rejects(s.addApprover(second, proof(bytes, a, 'cred-a', secretA, { flags: 0 })), /vorhandener Freigeber/, 'not touched');
  await assert.rejects(s.addApprover(second, proof(bytes, b, 'cred-b', secretB)), /vorhandener Freigeber/, 'the new key cannot vouch for itself');
  await assert.rejects(s.addApprover(second, proof(bytes, a, 'cred-a', prf())), /nicht öffnen/, 'wrong secret of the existing key');
  await assert.rejects(s.addApprover({ ...second, attachment: 'platform' }, proof(bytes, a, 'cred-a', secretA)), /Windows Hello/);
  await assert.rejects(s.addApprover(asApprover(a, 'cred-a', secretA)), /schon eingetragen/);
  const third = asApprover(registration(), 'cred-c', prf());
  await assert.rejects(s.addApprover(third, proof(bytes, a, 'cred-a', secretA)), /vorhandener Freigeber/, 'a proof for credential b cannot add credential c');
  assert.equal((await s.approvers()).length, 1, 'nothing was added by the refused attempts');
  await s.addApprover(second, proof(bytes, a, 'cred-a', secretA));
  assert.equal((await s.approvers()).length, 2);
  const manifest = Buffer.from('version: 9.9.9\n');
  for (const [hw, id, secret] of [[a, 'cred-a', secretA], [b, 'cred-b', secretB]]) {
    assert.equal(verifyManifest(manifest, await s.sign(manifest, proof(manifest, hw, id, secret)), [{ alg: 'ed25519', publicKey: pub }]), true, `${id} signs`);
  }
});

test('#437: removing an approver needs the touch of another one, the last stays, the removed one opens nothing', async () => {
  const file = keyFile();
  const s = createKeyStore({ file, encrypt, decrypt });
  const a = registration();
  const b = registration();
  const secretA = prf();
  const secretB = prf();
  await s.generate(asApprover(a, 'cred-a', secretA));
  const second = asApprover(b, 'cred-b', secretB);
  await s.addApprover(second, proof(addApproverBytes(second), a, 'cred-a', secretA));
  const [, entryB] = await s.approvers();
  const bytes = removeApproverBytes(entryB);
  await assert.rejects(s.removeApprover('cred-b'), /anderer eingetragener Freigeber/, 'no proof');
  await assert.rejects(s.removeApprover('cred-b', proof(bytes, b, 'cred-b', secretB)), /anderer eingetragener Freigeber/, 'the removed key cannot vouch for itself');
  await assert.rejects(s.removeApprover('cred-b', proof(addApproverBytes(entryB), a, 'cred-a', secretA)), /anderer eingetragener Freigeber/, 'proof for other bytes (an add proof)');
  await assert.rejects(s.removeApprover('cred-b', proof(bytes, a, 'cred-a', secretA, { flags: 0 })), /anderer eingetragener Freigeber/, 'not touched');
  await assert.rejects(s.removeApprover('cred-b', proof(bytes, registration(), 'cred-a', secretA)), /anderer eingetragener Freigeber/, 'foreign key under the id of a');
  await assert.rejects(s.removeApprover('cred-b', proof(bytes, a, 'cred-a', prf())), /nicht öffnen/, 'wrong secret of the confirming key');
  await assert.rejects(s.removeApprover('cred-x', proof(bytes, a, 'cred-a', secretA)), /nicht als Freigeber/);
  assert.equal((await s.approvers()).length, 2, 'nothing was removed by the refused attempts');

  await s.removeApprover('cred-b', proof(bytes, a, 'cred-a', secretA));
  assert.deepEqual((await s.approvers()).map((x) => x.credentialId), ['cred-a']);
  assert.equal(JSON.stringify(rawRecord(file)).includes('cred-b'), false, 'its wrapped copy is gone from the record');
  const manifest = Buffer.from('version: 9.9.9\n');
  await assert.rejects(s.sign(manifest, proof(manifest, b, 'cred-b', secretB)), /Freigabe/, 'the removed key signs nothing');
  await assert.rejects(s.attest(manifest, proof(manifest, b, 'cred-b', secretB)), /Freigabe/, 'the removed key attests nothing');
  await assert.rejects(s.addApprover(asApprover(registration(), 'cred-c', prf()), proof(addApproverBytes(asApprover(registration(), 'cred-c', prf())), b, 'cred-b', secretB)), /vorhandener Freigeber/, 'the removed key lets nobody in');
  assert.ok(await s.attest(manifest, proof(manifest, a, 'cred-a', secretA)), 'the one who stays still works');

  await assert.rejects(s.removeApprover('cred-a', proof(removeApproverBytes((await s.approvers())[0]), a, 'cred-a', secretA)), /letzte Freigeber/, 'the last one stays');
  assert.equal((await s.approvers()).length, 1);
});

test('#437: numbers stay stable after a removal, a new approver gets the next free number', async () => {
  const s = createKeyStore({ file: keyFile(), encrypt, decrypt });
  const keys = [registration(), registration(), registration()];
  const secrets = keys.map(() => prf());
  await s.generate(asApprover(keys[0], 'cred-1', secrets[0]));
  for (const i of [1, 2]) {
    const c = asApprover(keys[i], `cred-${i + 1}`, secrets[i]);
    await s.addApprover(c, proof(addApproverBytes(c), keys[0], 'cred-1', secrets[0]));
  }
  await s.removeApprover('cred-2', proof(removeApproverBytes((await s.approvers())[1]), keys[0], 'cred-1', secrets[0]));
  const fourth = asApprover(registration(), 'cred-4', prf());
  await s.addApprover(fourth, proof(addApproverBytes(fourth), keys[2], 'cred-3', secrets[2]));
  const list = await s.approvers();
  assert.deepEqual(list.map((x) => x.id), ['approver-1', 'approver-3', 'approver-4']);
  assert.deepEqual(list.map((x, i) => updateKeyElement(x, approverNumber(x, i)).id), ['release-1', 'release-3', 'release-4'], 'UPDATE_KEYS ids do not shift');
});

test('#437: the removal route picks the key in the main process, asks the gate first and is no agent or bridge command', () => {
  const api = read('desktop/main/api/release.js');
  assert.match(api, /async removeReleaseApprover\(\) \{\s*requireOpen\(\);\s*const why = refusal\(\);\s*if \(why\) throw new Error\(why\);/, 'no argument from the window, the Developer-build gate (#456) first');
  assert.match(api, /const done = await removeReleaseApprover\(target\.credentialId, win\);\s*if \(!done\) return null;/, 'a cancel is checked before it is unpacked');
  const flow = read('desktop/main/release-sign.js');
  assert.match(flow, /if \(!\(await confirm\(info, \{ approverRequired: true \}\)\)\) return null;\s*const proof = await approve\(removeApproverBytes\(target\), list\.filter\(\(a\) => a !== target\)\);/, 'dialog before the touch, the ceremony offers only the keys that stay');
  const dialog = releaseDialogHtml({ remove: true, id: 'release-2', credentialId: '<cred>', remaining: 1 }, { nonce: 'n' });
  assert.match(dialog, /Release-Freigeber entfernen/);
  assert.ok(dialog.includes('&lt;cred&gt;') && !dialog.includes('<cred>'), 'the credential id is escaped');
});

test('signing is refused when Chromium itself sees a debug switch, whatever the spelling', () => {
  const base = { developer: true, packaged: true, argv: ['Keevault.exe'], demo: false, smoke: false };
  assert.match(signingRefusal({ ...base, hasSwitch: (n) => n === 'remote-debugging-port' }), /remote-debugging-port/);
  assert.equal(signingRefusal({ ...base, hasSwitch: (n) => n === 'disable-features' }), null, 'switches Electron may set itself are not asked');
});

test('signing is refused when not packaged, in demo and smoke runs and with debugging switches', () => {
  const base = { developer: true, packaged: true, argv: ['Keevault.exe'], demo: false, smoke: false };
  assert.equal(signingRefusal(base), null);
  assert.match(signingRefusal({ ...base, packaged: false }), /installierten/);
  assert.match(signingRefusal({ ...base, developer: false }), /Developer-Build/, 'a release build never signs');
  assert.match(signingRefusal({ ...base, developer: undefined }), /Developer-Build/, 'unknown build kind counts as refused');
  assert.match(signingRefusal({ ...base, demo: true }), /Demo/);
  assert.match(signingRefusal({ ...base, smoke: true }), /Test/);
  for (const flag of ['-remote-debugging-port=9222', '/Remote-Debugging-Port=9222', '--REMOTE-DEBUGGING-PIPE', '--Inspect', '--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect', '--inspect-brk=9229', '--js-flags=--expose-gc', '--remote-allow-origins=*', '--enable-logging']) {
    assert.match(signingRefusal({ ...base, argv: ['Keevault.exe', flag] }), /Debug|Schalter/, flag);
  }
});

// ---- no way in for agents (plan #378, section 5): static, because the modules import Electron
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const handlerKeys = (src, name) => [...new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(src)[1].matchAll(/^  ['"]?([\w:]+)['"]?\s*[:(]/gm)].map((m) => m[1]);

test('agents and the browser have no signing command: handler tables are exactly the known ones', () => {
  assert.deepEqual(handlerKeys(read('desktop/main/agents.js'), 'mcpHandlers'), ['hello', 'mcp:call']);
  assert.deepEqual(handlerKeys(read('desktop/main/windows-passkeys.js'), 'windowsHandlers'), ['hello', 'win:status', 'win:makeCredential', 'win:getAssertion', 'win:cancel']);
  const browser = handlerKeys(read('desktop/main/browser.js'), 'browserHandlers');
  assert.equal(browser.some((k) => /sign.?release|release/i.test(k)), false, browser.join(','));
});

test('MCP tools: exactly the known list, none about releases or signing', async () => {
  const { MCP_TOOLS } = await import('../desktop/mcp.js');
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), ['list_vaults', 'search_entries', 'get_entry', 'get_totp', 'create_entry', 'update_entry', 'sign_in_with_passkey', 'request_microsoft_login', 'generate_password']);
});

test('the signing modules do not read key files or key environment variables', () => {
  for (const rel of ['desktop/release-key.js', 'desktop/main/release-sign.js', 'desktop/release-files.js']) {
    const src = read(rel).replace(/\/\/.*$/gm, '');
    assert.equal(/\.pem|process\.env|KEY_PEM|readFileSync\([^)]*key/i.test(src), false, `${rel} touches key material from outside`);
  }
});

// ---- emergency signature page: writes nothing without a valid answer of an embedded hardware key
import { createEmergencyServer } from '../scripts/emergency-sign.mjs';

test('emergency page: only a valid assertion of a listed hardware key writes latest.yml.sig2', async () => {
  const { dir } = fakeRelease();
  const manifest = fs.readFileSync(path.join(dir, 'latest.yml'));
  const hw = registration();
  const keys = [{ id: 'hw', alg: 'es256', publicKey: hw.publicKey }];
  const server = createEmergencyServer({ dir, credentialIds: ['cred'], keys, origin: 'http://localhost' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (assertionJson) => {
    const a = JSON.parse(assertionJson);
    return fetch(`${base}/sign`, { method: 'POST', body: JSON.stringify({ authData: a.authData, clientDataJSON: a.clientDataJSON, signature: a.signature }) });
  };
  try {
    assert.match(await (await fetch(`${base}/`)).text(), /Release 9\.9\.9 signieren/);
    const other = await post(assertion(Buffer.from('anderes'), hw.pair));
    assert.equal(other.status, 400, 'assertion for other bytes');
    assert.equal((await post(assertion(manifest, registration().pair))).status, 400, 'foreign key');
    assert.equal(fs.existsSync(path.join(dir, 'latest.yml.sig2')), false, 'nothing written so far');
    assert.equal((await post(assertion(manifest, hw.pair))).status, 200);
    assert.equal(verifyManifest(manifest, fs.readFileSync(path.join(dir, 'latest.yml.sig2'), 'utf8'), keys), true);
  } finally {
    server.close();
  }
});

test('emergency page (B6c): version is escaped in the page, a changed installer gets no page', async () => {
  const bad = fakeRelease({ tamperInstaller: true });
  assert.throws(() => createEmergencyServer({ dir: bad.dir, credentialIds: ['c'], keys: [] }), /Installer/);
  const { dir } = fakeRelease();
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8').replace('version: 9.9.9', 'version: <img/src=x/onerror=alert(1)>');
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml);
  const server = createEmergencyServer({ dir, credentialIds: ['c</script><b>'], keys: [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.equal(html.includes('<img/src=x'), false);
    assert.equal(html.includes('</script><b>'), false);
    assert.match(html, /&lt;img\/src=x/);
  } finally {
    server.close();
  }
});

test('C4: with the first approver at creation the key exists only wrapped, never in plain', async () => {
  const file = keyFile();
  const s = createKeyStore({ file, encrypt, decrypt });
  const hw = registration();
  const secret = prf();
  const pub = await s.generate({ ...asApprover(hw, 'cred-1', secret) });
  const record = rawRecord(file);
  assert.equal(record.pkcs8, undefined);
  assert.equal(record.approvers.length, 1);
  assert.equal(fs.readFileSync(file).includes(Buffer.from('pkcs8')), false);
  const manifest = Buffer.from('version: 9.9.9\n');
  await assert.rejects(s.sign(manifest), /Freigabe/);
  assert.equal(verifyManifest(manifest, await s.sign(manifest, proof(manifest, hw, 'cred-1', secret)), [{ alg: 'ed25519', publicKey: pub }]), true);
  await assert.rejects(createKeyStore({ file: keyFile(), encrypt, decrypt }).generate({ ...asApprover(hw, 'c', secret), attachment: 'platform' }), /Windows Hello/, 'a refused approver creates no key');
});

test('C2: an approver without PIN is refused and a secret that does not open the key stores nothing', async () => {
  const s = createKeyStore({ file: keyFile(), encrypt, decrypt });
  await s.generate();
  const noPin = registration({ flags: 0x41 });
  await assert.rejects(s.addApprover(asApprover(noPin, 'cred-x', prf())), /PIN/);
  assert.equal((await s.approvers()).length, 0, 'phase-1 key untouched');
  await assert.rejects(s.addApprover(asApprover(registration(), 'cred-y', 'too-short')), /hmac-secret/, 'no 32-byte secret: refused before anything is stored');
  assert.equal((await s.approvers()).length, 0);
});

test('C5: cancelling the setup or signing returns nothing and the API does not unpack it', () => {
  const api = read('desktop/main/api/release.js');
  assert.match(api, /const done = await setupReleaseKey\(win\);\s*if \(!done\) return null;/, 'the setup answer is checked before it is unpacked');
  assert.match(api, /const done = await signReleaseFolder\(filePaths\[0\], win\);\s*if \(done\)/);
});

test('phase 2: the signature is the hardware key own assertion, verified against the approver, and fits the UPDATE_KEYS element', async () => {
  const s = createKeyStore({ file: keyFile(), encrypt, decrypt });
  const manifest = Buffer.from('version: 9.9.9' + String.fromCharCode(10));
  const hw = registration();
  const secret = prf();
  await assert.rejects(s.attest(manifest, proof(manifest, hw, 'cred-1', secret)), /Freigeber/, 'no key store, no approver');
  await s.generate({ ...asApprover(hw, 'cred-1', secret) });
  await assert.rejects(s.attest(manifest, null), /Freigabe/, 'no answer of the key');
  await assert.rejects(s.attest(manifest, proof(Buffer.from('version: 9.9.8' + String.fromCharCode(10)), hw, 'cred-1', secret)), /Freigabe/, 'assertion for other bytes');
  await assert.rejects(s.attest(manifest, proof(manifest, hw, 'cred-1', secret, { flags: 0 })), /Freigabe/, 'not touched');
  await assert.rejects(s.attest(manifest, proof(manifest, registration(), 'cred-1', secret)), /Freigabe/, 'foreign key');
  await assert.rejects(s.attest(manifest, proof(manifest, hw, 'other', secret)), /Freigabe/, 'unknown credential');
  const sig = await s.attest(manifest, proof(manifest, hw, 'cred-1', secret));
  assert.ok(sig.startsWith('{'), 'an assertion, no software signature');
  const [approver] = await s.approvers();
  assert.equal(verifyManifest(manifest, sig, [updateKeyElement(approver, 1)]), true, 'the UPDATE_KEYS element verifies it');
  assert.equal(verifyManifest(manifest, sig, [{ alg: 'ed25519', publicKey: await s.publicKey() }]), false, 'the software key has nothing to do with it');
  const line = updateKeyLine(approver, 1);
  assert.match(line, /alg: 'es256'/);
  assert.ok(line.includes(approver.credentialId) && line.includes(approver.publicKey));
  assert.equal(line.includes('wrapped'), false, 'public parts only');
});

test('a folder without latest.yml says so in words (#428), not ENOENT', async () => {
  const dir = tmp();
  await assert.rejects(inspectRelease(dir), (e) => /keine latest\.yml/.test(e.message) && !/ENOENT/.test(e.message));
});

test('#428: the emergency page asks for the PIN, a build deletes a stale latest.yml.sig2', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'emergency-sign.mjs'), 'utf8'), /userVerification: 'required'/);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'release.mjs'), 'utf8'), /rmSync\(R\('release\/latest\.yml\.sig2'\)/);
});
