import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBridge, hostScript } from '../desktop/bridge.js';
import { browserItemHandlers, ITEM_CAPS } from '../desktop/browser-items.js';

// #464: history, linked assets and moving for the browser extension – rights, no private passkey key, unknown client refused.

const KEY = 'PRIVATE-KEY-A';
const pk = () => [{ credentialId: 'A', privateKey: KEY, rpId: 'example.com', userName: 'u' }];

/** A small in-memory vault session with two containers; w = write right per container. */
function fakeVault({ aWrite = true, bWrite = true, aPersonal = false, bPersonal = false } = {}) {
  const containers = {
    A: { id: 'A', name: 'Quelle', access: { write: aWrite }, personal: aPersonal },
    B: { id: 'B', name: 'Ziel', access: { write: bWrite }, personal: bPersonal },
  };
  const items = new Map([['A/1', { id: '1', containerId: 'A', title: 'Eins', type: 'login', passkeys: pk(), folder: '', version: 'v1' }]]);
  const calls = [];
  let n = 0;
  const vault = {
    calls,
    container: async (id) => { if (!containers[id]) throw new Error('Tresor nicht gefunden'); return containers[id]; },
    getItem: async (c, id) => { const it = items.get(`${c}/${id}`); if (!it) throw new Error('Nicht gefunden'); return structuredClone(it); },
    saveItem: async (c, item) => { calls.push(['save', c]); const id = item.id || `n${++n}`; const saved = { ...item, id, containerId: c, key: `${c}/${id}` }; items.set(`${c}/${id}`, saved); return structuredClone(saved); },
    deleteItem: async (c, id) => { calls.push(['delete', c, id]); items.delete(`${c}/${id}`); },
    purge: async () => {},
    requireLicenseForNew: async () => {},
    linkedEntries: async () => [],
    moveItem: async (from, to, id) => { calls.push(['moveItem', from, to]); return vault.saveItem(to, { ...items.get(`${from}/${id}`), id: '' }); },
    history: async () => [{ version: 'v1', updated: 5, enabled: true, secret: 'x', updatedBy: 'me' }],
    getVersion: async () => ({ id: '1', title: 'Alt', passkeys: pk() }),
  };
  return { vault, items };
}

const handlers = (opts, { open = true, answer = true } = {}) => {
  const f = fakeVault(opts);
  let changes = 0;
  const asked = [];
  const h = browserItemHandlers({
    vault: f.vault,
    requireOpen: () => { if (!open) throw new Error('gesperrt'); },
    changed: () => { changes++; },
    movePasskey: async () => true,
    confirm: async (info) => { asked.push(info); return answer; },
  });
  return { ...f, h, asked, changes: () => changes };
};

test('history and version: read only, the list carries only its fields, no private key', async () => {
  const { h, items } = handlers();
  const list = await h.history({ containerId: 'A', itemId: '1' });
  assert.deepEqual(list, [{ version: 'v1', updated: 5, enabled: true, updatedBy: 'me' }]);
  const old = await h.version({ containerId: 'A', itemId: '1', version: 'v1' });
  assert.equal(old.title, 'Alt');
  assert.deepEqual(old.passkeys.map((k) => k.privateKey), ['']);
  assert.ok(!JSON.stringify(old).includes(KEY));
  assert.equal(items.get('A/1').passkeys[0].privateKey, KEY, 'the stored entry is untouched');
  // A file vault numbers its versions.
  assert.equal((await h.version({ containerId: 'A', itemId: '1', version: 3 })).title, 'Alt');
  await assert.rejects(h.history({ containerId: '', itemId: '1' }), /Ungültige Angabe/);
  await assert.rejects(h.version({ containerId: 'A', itemId: '1', version: { $: 1 } }), /Ungültige Angabe/);
});

test('every command needs an unlocked app', async () => {
  const { h } = handlers({}, { open: false });
  for (const [cmd, msg] of [['history', { containerId: 'A', itemId: '1' }], ['version', { containerId: 'A', itemId: '1', version: 'v1' }],
    ['linkedEntries', { containerId: 'A', itemId: '1' }], ['planMove', { fromId: 'A', toId: 'B', itemId: '1' }],
    ['move', { fromId: 'A', toId: 'B', itemId: '1' }], ['moveWithAssets', { fromId: 'A', toId: 'B', itemId: '1' }],
    ['movePasskey', { from: { containerId: 'A', id: '1' }, to: { containerId: 'B', id: '2' }, credentialId: 'A' }]]) {
    await assert.rejects(h[cmd](msg), /gesperrt/, cmd);
  }
});

test('linkedEntries: only the fields the popup shows', async () => {
  const { h, vault } = handlers();
  vault.linkedEntries = async () => [{ key: 'A/2', containerId: 'A', id: '2', title: 'Server', type: 'server', uses: ['rdp'], password: 'nope' }];
  assert.deepEqual(await h.linkedEntries({ containerId: 'A', itemId: '1' }), [{ key: 'A/2', containerId: 'A', id: '2', title: 'Server', type: 'server', uses: ['rdp'] }]);
});

test('move and moveWithAssets: write right in the target and in the source, otherwise nothing happens', async () => {
  for (const [opts, text] of [[{ bWrite: false }, /Ziel.*Schreibrecht/], [{ aWrite: false }, /Quelle.*Schreibrecht/], [{ aPersonal: false, bPersonal: true }, /persönlichen Tresor/]]) {
    for (const cmd of ['move', 'moveWithAssets']) {
      const { h, vault, changes } = handlers(opts);
      await assert.rejects(h[cmd]({ fromId: 'A', toId: 'B', itemId: '1' }), text, `${cmd} ${JSON.stringify(opts)}`);
      assert.deepEqual(vault.calls, [], 'no write reached the vault');
      assert.equal(changes(), 0);
    }
  }
  const { h } = handlers();
  await assert.rejects(h.move({ fromId: 'A', toId: 'X', itemId: '1' }), /nicht gefunden/);
  await assert.rejects(h.move({ fromId: 'A', toId: 'B' }), /Ungültige Angabe/);
});

test('move and moveWithAssets: the answer carries no private key, the move runs in the app', async () => {
  const one = handlers();
  const saved = await one.h.move({ fromId: 'A', toId: 'B', itemId: '1' });
  assert.equal(saved.containerId, 'B');
  assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.equal(one.changes(), 1);
  const two = handlers();
  const res = await two.h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] });
  assert.ok(!JSON.stringify(res).includes(KEY));
  assert.equal(res.moved.length, 1);
  assert.equal(two.items.has('A/1'), false, 'the original is gone');
  assert.equal(two.items.get(`B/${res.moved[0].id}`).passkeys[0].privateKey, KEY, 'the copy in the target keeps its key inside the app');
});

test('moveWithAssets: the plan must match what the popup showed; a failing write is rolled back', async () => {
  const a = handlers();
  await assert.rejects(a.h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1', 'extra'] }), /haben sich geändert/);
  assert.equal(a.items.has('A/1'), true);
  assert.deepEqual(a.vault.calls, [], 'nothing moved');

  const b = handlers();
  const save = b.vault.saveItem;
  b.vault.saveItem = async (c, item) => { if (c === 'B') { await save(c, item); throw new Error('Netz weg'); } return save(c, item); };
  await assert.rejects(b.h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] }), /Netz weg/);
  assert.equal(b.items.has('A/1'), true, 'the source stays');
  assert.ok([...b.items.keys()].every((k) => k.startsWith('A/')), 'the copy in the target was removed again');
  assert.ok(b.changes() >= 1, 'the app tells the others even after a failure');
});

test('planMove: plan without the entries themselves; movePasskey needs the write right', async () => {
  const { h } = handlers();
  const plan = await h.planMove({ fromId: 'A', toId: 'B', itemId: '1' });
  assert.deepEqual(Object.keys(plan).sort(), ['blocked', 'dropped', 'members', 'refused']);
  assert.ok(!JSON.stringify(plan).includes(KEY));
  const ref = { from: { containerId: 'A', id: '1' }, to: { containerId: 'A', id: '2' }, credentialId: 'A' };
  assert.equal(await h.movePasskey(ref), true);
  for (const opts of [{ aWrite: false }]) {
    const x = handlers(opts);
    await assert.rejects(x.h.movePasskey(ref), /Schreibrecht/);
  }
  await assert.rejects(h.movePasskey({ ...ref, credentialId: '' }), /Ungültige Angabe/);
});

test('move and moveWithAssets into another vault: no confirmation, no move; with it the card names source, target, entries, passkeys', async () => {
  for (const cmd of ['move', 'moveWithAssets']) {
    const no = handlers({}, { answer: false });
    await assert.rejects(no.h[cmd]({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] }), /nicht bestätigt/, cmd);
    assert.deepEqual(no.vault.calls, [], 'nothing was written');
    assert.equal(no.items.has('A/1'), true);
    assert.equal(no.changes(), 0);
    const yes = handlers();
    await yes.h[cmd]({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] });
    assert.deepEqual(yes.asked, [{ from: 'Quelle', to: 'Ziel', entries: [{ title: 'Eins', passkey: true }] }], cmd);
    assert.ok([...yes.items.keys()].some((k) => k.startsWith('B/')), 'moved');
  }
  // Without any way to ask (no confirm function) the move is refused as well.
  const f = fakeVault();
  const bare = browserItemHandlers({ vault: f.vault, requireOpen() {}, changed() {}, movePasskey: async () => true });
  await assert.rejects(bare.move({ fromId: 'A', toId: 'B', itemId: '1' }), /nicht bestätigt/);
});

test('move inside one vault (folder change) asks nothing', async () => {
  for (const cmd of ['move', 'moveWithAssets']) {
    const x = handlers({}, { answer: false });
    await x.h[cmd]({ fromId: 'A', toId: 'A', itemId: '1', folder: 'Neu', expected: ['1'] });
    assert.deepEqual(x.asked, [], cmd);
  }
});

test('movePasskey across vaults is refused, inside one vault it runs without asking', async () => {
  const x = handlers();
  await assert.rejects(x.h.movePasskey({ from: { containerId: 'A', id: '1' }, to: { containerId: 'B', id: '2' }, credentialId: 'A' }), /nur innerhalb desselben Tresors/);
  assert.equal(await x.h.movePasskey({ from: { containerId: 'A', id: '1' }, to: { containerId: 'A', id: '2' }, credentialId: 'A' }), true);
  assert.deepEqual(x.asked, []);
});

test('capabilities: the app reports the new commands; only approved browsers have them', () => {
  assert.deepEqual(ITEM_CAPS, ['history', 'linkedEntries', 'move', 'movePasskey']);
  const src = readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8');
  assert.match(src, /APP_CAPS = \['passkeySign', 'copy', \.\.\.ITEM_CAPS\]/);
  const dispatch = src.slice(src.indexOf('const bridgeHandlers'));
  assert.match(dispatch, /origin === WINDOWS_ORIGIN \? windowsHandlers : client\?\.origin\?\.startsWith\('mcp:'\) \? mcpHandlers : browserHandlers/);
  for (const file of ['desktop/main/windows-passkeys.js', 'desktop/main/agents.js']) {
    const other = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!/\b(moveWithAssets|movePasskey|planMove)\b/.test(other), `${file} has none of the move commands`);
  }
});

// ---- an unknown (not approved) browser reaches none of the commands

function frame(msg) {
  const json = Buffer.from(JSON.stringify(msg));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

test('unknown client: every new command is refused before it reaches a handler', async () => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\kvpwsafe-items-${process.pid}-${Date.now()}` : join(mkdtempSync(join(tmpdir(), 'kvpwsafe-sock-')), 'bridge.sock');
  const { h } = handlers();
  const reached = [];
  const spied = Object.fromEntries(Object.entries(h).map(([k, fn]) => [k, async (m) => { reached.push(k); return fn(m); }]));
  const bridge = new BrowserBridge({ path: pipe, approve: async (origin) => origin === 'chrome-extension://good/', handlers: { ...spied, hello: async () => ({ version: '1' }) } });
  await bridge.start();
  const dir = mkdtempSync(join(tmpdir(), 'kvpwsafe-host-'));
  writeFileSync(join(dir, 'host.cjs'), hostScript(pipe));
  const procs = [];
  const start = (origin) => {
    const proc = spawn(process.execPath, [join(dir, 'host.cjs'), origin], { stdio: ['pipe', 'pipe', 'inherit'] });
    procs.push(proc);
    const messages = [];
    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        messages.push(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()));
        buf = buf.subarray(4 + buf.readUInt32LE(0));
      }
    });
    const next = async (n) => { for (let i = 0; i < 100 && messages.length < n; i++) await new Promise((r) => setTimeout(r, 50)); return messages[n - 1]; };
    return { proc, send: (m) => proc.stdin.write(frame(m)), next };
  };
  try {
    const bad = start('chrome-extension://bad/');
    assert.deepEqual(await bad.next(1), { event: 'online' });
    bad.send({ id: 1, cmd: 'hello' });
    assert.equal((await bad.next(2)).error.name, 'NotApproved', 'hello');
    let n = 2;
    for (const cmd of ['history', 'version', 'linkedEntries', 'planMove', 'move', 'moveWithAssets', 'movePasskey']) {
      bad.send({ id: n + 1, cmd, containerId: 'A', itemId: '1', fromId: 'A', toId: 'B' });
      assert.equal((await bad.next(++n)).error.name, 'NotApproved', cmd);
    }
    assert.deepEqual(reached, [], 'no handler was called');
    const good = start('chrome-extension://good/');
    await good.next(1);
    good.send({ id: 1, cmd: 'hello' });
    await good.next(2);
    good.send({ id: 2, cmd: 'history', containerId: 'A', itemId: '1' });
    const answer = await good.next(3);
    assert.equal(answer.result?.[0]?.version, 'v1', JSON.stringify(answer));
    good.proc.kill();
    bad.proc.kill();
  } finally {
    for (const p of procs) p.kill();
    bridge.stop();
  }
});

test('moveWithAssets: without the entries the browser names, or with other ones, nothing is asked and nothing moves', async () => {
  for (const expected of [undefined, [], ['1', 'extra'], ['other'], 'x', [1]]) {
    const x = handlers();
    await assert.rejects(x.h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected }), /Einträge haben sich geändert/, JSON.stringify(expected));
    assert.deepEqual(x.asked, [], 'no card for a request that does not match its plan');
    assert.deepEqual(x.vault.calls, []);
    assert.equal(x.items.has('A/1'), true);
  }
});

test('moveWithAssets: a plan that changes after the confirmation is refused (entries, versions); nothing moves', async () => {
  // A linked entry appears while the card is open.
  const a = handlers();
  a.items.set('A/2', { id: '2', containerId: 'A', title: 'Neu verknüpft', type: 'login', passkeys: [], folder: '', version: 'v1' });
  const ask = a.vault.linkedEntries;
  let open = false;
  a.vault.linkedEntries = async (c, id) => (open && id === '1' ? [{ key: 'A/2', containerId: 'A', id: '2', title: 'Neu verknüpft', type: 'login', uses: ['login'] }] : ask(c, id));
  const confirmWas = a.asked;
  const h = browserItemHandlers({ vault: a.vault, requireOpen() {}, changed() {}, movePasskey: async () => true, confirm: async (info) => { confirmWas.push(info); open = true; return true; } });
  await assert.rejects(h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] }), /Einträge haben sich geändert/);
  assert.equal(confirmWas.length, 1, 'the card was shown with one entry');
  assert.deepEqual(confirmWas[0].entries.map((e) => e.title), ['Eins']);
  assert.deepEqual(a.vault.calls, [], 'nothing was written');
  assert.equal(a.items.has('A/1'), true);

  // The entry itself is saved again while the card is open (new version).
  const b = handlers();
  let bump = 1;
  const h2 = browserItemHandlers({ vault: b.vault, requireOpen() {}, changed() {}, movePasskey: async () => true, confirm: async () => { b.items.get('A/1').version = `v${++bump}`; return true; } });
  await assert.rejects(h2.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] }), /Einträge haben sich geändert/);
  await assert.rejects(h2.move({ fromId: 'A', toId: 'B', itemId: '1' }), /Einträge haben sich geändert/);
  assert.deepEqual(b.vault.calls, []);
  assert.equal(b.items.has('A/1'), true);
});

test('move: expectedVersion of the browser must be the current version; otherwise nothing is asked', async () => {
  const x = handlers();
  await assert.rejects(x.h.move({ fromId: 'A', toId: 'B', itemId: '1', expectedVersion: 'v0' }), /Einträge haben sich geändert/);
  assert.deepEqual(x.asked, []);
  assert.deepEqual(x.vault.calls, []);
  const saved = await x.h.move({ fromId: 'A', toId: 'B', itemId: '1', expectedVersion: 'v1' });
  assert.equal(saved.containerId, 'B');
});

test('a refused plan shows no card', async () => {
  const x = handlers();
  const real = x.vault.container;
  // Rights are checked first (both()); a plan refusal comes back at once as well.
  await assert.rejects(handlers({ bWrite: false }).h.moveWithAssets({ fromId: 'A', toId: 'B', itemId: '1', expected: ['1'] }), /Schreibrecht/);
  assert.ok(real);
  assert.deepEqual(x.asked, []);
});
