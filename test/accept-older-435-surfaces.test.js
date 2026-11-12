import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { FileContainers } from '../desktop/files.js';
import { ACCEPT_DELAY_MS, ACCEPT_TOKEN_MS, OlderStateAcceptance } from '../desktop/file-accept-older.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #435: the main-process side – token, wait, name, unchanged file – and no route from a locked window, the browser,
// an agent or the extension.

const root = path.resolve(import.meta.dirname, '..');
const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-435-'));
  const file = path.join(dir, 'Team.kvpws');
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  const state = { paths: [file], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  const alicePk = passkey('alice');
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: alicePk });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const req = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
  await alice.saveItem({ type: 'login', title: 'Old', password: 'o' });
  const backup = await io.read();
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  const files = make();
  await files.load();
  await fs.writeFile(file, backup); // put back while the app was closed
  files.close();
  const later = make();
  await later.load();
  return { dir, file, later, alicePk, backup };
}

test('#435: token, wait, name and an unchanged file are checked in the main process; the token works once', async () => {
  const { dir, file, later, alicePk, backup } = await setup();
  try {
    const entry = [...later.entries.values()][0];
    assert.equal(entry.refusal, 'older');
    const c = (await later.containers())[0];
    assert.equal(c.olderState, true, 'offered for an older state');
    let now = 1_000_000;
    const acc = new OlderStateAcceptance(later, { now: () => now });
    const info = await acc.prepare(entry.id);
    assert.equal(info.name, 'Team');
    assert.equal(info.lost, null, 'the newer state is not open here');
    // Without the passkey step nothing is written.
    now += ACCEPT_DELAY_MS;
    await assert.rejects(acc.commit(info.token, 'Team'), /PIN und Passkey|PIN and passkey/);
    // A wrong token, an expired one.
    await assert.rejects(acc.unlock('nope', { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput }), /ungültig|invalid/);
    const late = await acc.prepare(entry.id);
    now += ACCEPT_TOKEN_MS + 1;
    await assert.rejects(acc.unlock(late.token, { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput }), /abgelaufen|expired/);
    // The file changes between the dialog and the passkey: refused.
    now = 2_000_000;
    const t1 = await acc.prepare(entry.id);
    await fs.writeFile(file, backup.replace('"name": "Team"', '"name": "Team"\n'));
    await assert.rejects(acc.unlock(t1.token, { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput }), /geändert|changed/);
    await fs.writeFile(file, backup);
    // The real run: too early, wrong name, then right.
    const t2 = await acc.prepare(entry.id);
    const checked = await acc.unlock(t2.token, { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput });
    assert.equal(checked.dropped, 0, 'Bob wrote nothing; Alice\'s entry stays');
    await assert.rejects(acc.commit(t2.token, 'Team'), /Wartezeit|wait/);
    now += ACCEPT_DELAY_MS;
    await assert.rejects(acc.commit(t2.token, 'Tea'), /Name|name/);
    // Changed again before writing: nothing written.
    await fs.writeFile(file, `${backup} `);
    await assert.rejects(acc.commit(t2.token, 'Team'), /geändert|changed/);
    await assert.rejects(acc.commit(t2.token, 'Team'), /ungültig|invalid/, 'used once');
    await fs.writeFile(file, backup);
    const t3 = await acc.prepare(entry.id);
    await acc.unlock(t3.token, { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput });
    now += ACCEPT_DELAY_MS;
    const id = await acc.commit(t3.token, ' Team ');
    const fresh = later.entries.get(id);
    assert.ok(fresh?.vault, 'opens with the floor of this device');
    assert.equal((await later.containers()).find((x) => x.id === id).olderState, false);
    await fresh.vault.unlockWithPasskey(alicePk.credentialId, alicePk.prfOutput);
    assert.deepEqual(fresh.vault.summaries().map((s) => s.title), ['Old']);
  } finally {
    later.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('#435: a file that is not refused as older is not offered', async () => {
  const { dir, file, later } = await setup();
  try {
    const entry = [...later.entries.values()][0];
    entry.refusal = 'tampered';
    await assert.rejects(new OlderStateAcceptance(later).prepare(entry.id), /kein älterer Stand|No older state/);
    assert.equal((await later.containers())[0].olderState, false);
    void file;
  } finally {
    later.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function sources(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === 'lib' ? [] : sources(p);
    return /\.(m|c)?js$/.test(n) ? [p] : [];
  });
}

test('#435: no route from a locked window, the browser, agents, the Windows provider or the extension', () => {
  const index = readFileSync(path.join(root, 'desktop/main/api/index.js'), 'utf8');
  const allow = index.match(/WINDOW_LOCKED_API = new Set\(\[([^\]]*)\]/)[1];
  assert.ok(!/acceptOlder/.test(allow), 'not allowed while the window is locked');
  for (const rel of ['desktop/bridge.js', 'desktop/mcp.js', 'desktop/main/browser.js', 'desktop/main/agents.js', 'desktop/main/windows-passkeys.js', 'desktop/browser-items.js']) {
    assert.ok(!/acceptOlder|file-accept-older|rollback-accept/.test(readFileSync(path.join(root, rel), 'utf8')), rel);
  }
  for (const p of sources(path.join(root, 'extension')).filter((p) => !p.endsWith(`${path.sep}rollback-accept.js`))) {
    assert.ok(!/acceptOlder|rollback-accept/.test(readFileSync(p, 'utf8')), p);
  }
  // Every step checks admin mode; the unlock step asks for the app PIN (attempt lock) and a passkey.
  const api = readFileSync(path.join(root, 'desktop/main/api/files.js'), 'utf8');
  for (const name of ['acceptOlderPrepare', 'acceptOlderUnlock', 'acceptOlderCommit']) {
    const body = api.slice(api.indexOf(name), api.indexOf('\n  },', api.indexOf(name)));
    assert.match(body, /requireAdminMode\(\)/, name);
  }
  const unlock = api.slice(api.indexOf('acceptOlderUnlock'), api.indexOf('acceptOlderCommit'));
  assert.match(unlock, /api\.verifyPin\(/);
  assert.match(unlock, /passkeyCeremony\(\{ mode: 'evaluate'/);
  assert.match(readFileSync(path.join(root, 'extension/core/prf.js'), 'utf8'), /userVerification: 'required'/);
});

test('#435: refused on a reload with the newer state unlocked here – the dialog names what is lost', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-435b-'));
  const file = path.join(dir, 'Team.kvpws');
  const state = { paths: [], pins: {}, notes: {} };
  const files = new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  try {
    const pk = passkey('alice');
    const { id } = await files.createSecure(file, 'Team', { email: 'alice@contoso.com', passkey: pk });
    const v = files.get(id);
    await v.memberOp({ type: 'sharing', enabled: true });
    const bob = new FileVault({ read: () => fs.readFile(file, 'utf8'), write: (s) => fs.writeFile(file, s) });
    const req = await bob.requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
    await v.load();
    await v.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader' });
    const backup = await fs.readFile(file, 'utf8');
    await v.saveItem({ type: 'login', title: 'Newer entry', password: 'n' });
    await v.memberOp({ type: 'remove', memberId: req.memberId });
    await fs.writeFile(file, backup);
    const entry = files.entries.get(id);
    await files.watched(entry);
    assert.equal(entry.refusal, 'older');
    const info = await new OlderStateAcceptance(files).prepare(id);
    assert.deepEqual(info.lost, ['Newer entry']);
  } finally {
    files.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
