import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineMirror, OfflineError, isNetworkError } from '../desktop/offline.js';

// Stand-in for the OS key store: reversible, so the tests run without Electron.
const protect = (b) => Buffer.from(b).map((x) => x ^ 0x5a);
const unprotect = (b) => Buffer.from(b).map((x) => x ^ 0x5a);
const mirror = (dir) => new OfflineMirror({ dir, protect, unprotect, now: () => 1_700_000_000_000 });

const vault = 'https://kv-team.vault.azure.net';
const fakeFetch = async (url, init = {}) => {
  if ((init.method || 'GET') !== 'GET') return new Response('{}', { status: 200 });
  if (String(url).includes('/secrets?')) return new Response(JSON.stringify({ value: [{ id: `${vault}/secrets/a` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ value: 'secret-value' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('offline mirror: records GETs, replays them after a PIN unlock, refuses writes and wrong PINs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-offline-'));
  try {
    const m = mirror(dir);
    const fetch = m.record(fakeFetch);
    // Without the key nothing is recorded (the user has not entered the PIN yet).
    await fetch(`${vault}/secrets?api-version=7.4`);
    assert.equal(m.entries.size, 0);
    await m.unlockKey('1234');
    const list = await (await fetch(`${vault}/secrets?api-version=7.4`)).json();
    assert.equal(list.value.length, 1, 'the real answer passes through');
    await fetch(`${vault}/secrets/a/?api-version=7.4`);
    await fetch(`${vault}/secrets/a?api-version=7.4`, { method: 'PUT', body: '{}' });
    await fetch('https://management.azure.com/subscriptions?api-version=2020-01-01');
    assert.equal(m.entries.size, 2, 'only Key Vault GETs are kept');
    m.setContainers([{ kind: 'keyvault', name: 'Team', vaultUrl: vault }, { kind: 'file', name: 'x' }]);
    assert.ok(await m.save());

    // A fresh process: PIN → key → mirror readable.
    const again = mirror(dir);
    await assert.rejects(again.load(), OfflineError);
    await again.unlockKey('1234');
    const info = await again.load();
    assert.deepEqual([info.entries, info.containers, info.at], [2, 1, 1_700_000_000_000]);
    const replayed = await (await again.replay(`${vault}/secrets/a/?api-version=7.4`)).json();
    assert.equal(replayed.value, 'secret-value');
    await assert.rejects(again.replay(`${vault}/secrets/a?api-version=7.4`, { method: 'PUT' }), /Offline/);
    await assert.rejects(again.replay(`${vault}/secrets/unknown/?api-version=7.4`), /Offline/);

    // Wrong PIN: the GCM tag fails, nothing leaks.
    const wrong = mirror(dir);
    await wrong.unlockKey('9999');
    await assert.rejects(wrong.load(), /PIN/);

    // PIN change re-encrypts; removal leaves nothing behind.
    await again.rekey('1234', '5678');
    const changed = mirror(dir);
    await changed.unlockKey('5678');
    assert.equal((await changed.load()).entries, 2);
    await changed.remove();
    assert.equal(await changed.exists(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #413: what the vault says is gone must not stay readable offline. A vault with pages and soft delete, in its URLs as sent.
const API = '?api-version=7.5';
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const gone = () => new Response('{}', { status: 404 });
async function goneMirror(t, answers) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-offline-'));
  const m = mirror(dir);
  await m.unlockKey('1234');
  t.after(async () => { await m.remove(); rmSync(dir, { recursive: true, force: true }); });
  const fetch = m.record(async (url, init = {}) => answers(String(url), init.method || 'GET'));
  return { m, fetch, dir };
}
const secretA = [`${vault}/secrets/a${API}`, `${vault}/secrets/a/v1${API}`, `${vault}/secrets/a/versions${API}&maxresults=25`];
const secretB = `${vault}/secrets/b${API}`;
const unreadable = (m, url) => assert.rejects(m.replay(url), /Offline/, url);
const readable = async (m, url) => assert.equal((await m.replay(url)).status, 200, url);

test('offline mirror: after a DELETE, or a 404 on a read, no URL of that secret answers; others stay', async (t) => {
  for (const [method, status] of [['DELETE', 200], ['DELETE', 404], ['GET', 404]]) {
    let answer = () => ok({ value: 'password' });
    const { m, fetch } = await goneMirror(t, () => answer());
    for (const url of [...secretA, secretB]) await fetch(url);
    answer = () => (status === 404 ? gone() : ok({}));
    await fetch(`${vault}/secrets/A${API}`, { method });
    for (const url of secretA) await unreadable(m, url);
    await readable(m, secretB);
  }
});

test('offline mirror: deleted is gone from the file as well, not only from memory', async (t) => {
  let answer = () => ok({ value: 'very-secret-password' });
  const { m, fetch, dir } = await goneMirror(t, () => answer());
  await fetch(secretA[0]);
  await m.save();
  answer = () => ok({});
  await fetch(secretA[0], { method: 'DELETE' });
  await m.save();
  const fresh = mirror(dir);
  await fresh.unlockKey('1234');
  await fresh.load();
  await unreadable(fresh, secretA[0]);
});

test('offline mirror: a failed DELETE or a failed read removes nothing', async (t) => {
  let answer = () => ok({ value: 'x' });
  const { m, fetch } = await goneMirror(t, () => answer());
  await fetch(secretA[0]);
  for (const status of [403, 500]) {
    answer = () => new Response('{}', { status });
    await fetch(secretA[0], { method: 'DELETE' });
    await fetch(secretA[0]);
    await readable(m, secretA[0]);
  }
});

const LIST = `${vault}/secrets${API}&maxresults=25`;
const PAGE2 = `${vault}:443/secrets${API}&$skiptoken=two`;
const listed = (...names) => names.map((n) => ({ id: `${vault}/secrets/${n}` }));

test('offline mirror: only a list read to its end removes what it does not name', async (t) => {
  const pages = { [LIST]: { value: listed('A'), nextLink: PAGE2 }, [PAGE2]: { value: listed('c'), nextLink: null } };
  const { m, fetch } = await goneMirror(t, (url) => ok(pages[url] || { value: 'x' }));
  for (const url of [secretA[0], secretB, `${vault}/secrets/c${API}`]) await fetch(url);
  await fetch(LIST);
  await readable(m, secretB);
  await fetch(PAGE2);
  await unreadable(m, secretB);
  await readable(m, secretA[0]);
  await readable(m, `${vault}/secrets/c${API}`);
  await readable(m, LIST);
  await readable(m, PAGE2);
});

test('offline mirror: a list out of turn, of another vault or without a list in it concludes nothing', async (t) => {
  const other = 'https://kv-other.vault.azure.net';
  const pages = {
    [LIST]: { value: listed('a'), nextLink: PAGE2 }, [PAGE2]: { value: [], nextLink: null },
    [`${other}/secrets${API}`]: { value: [], nextLink: null },
  };
  const { m, fetch } = await goneMirror(t, (url) => ok(pages[url] || { value: 'x' }));
  await fetch(secretB);
  await fetch(PAGE2); // a last page with no first
  await readable(m, secretB);
  await fetch(`${other}/secrets${API}`);
  await readable(m, secretB);
  pages[LIST] = { value: 'not a list' };
  await fetch(LIST);
  await readable(m, secretB);
});

test('network errors are told apart from refused sign-ins', () => {
  assert.ok(isNetworkError(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')));
  assert.ok(isNetworkError({ errorCode: 'network_error', message: 'Network request failed' }));
  assert.ok(isNetworkError(new TypeError('fetch failed')));
  assert.ok(!isNetworkError({ errorCode: 'interaction_required', message: 'AADSTS50076' }));
  assert.ok(!isNetworkError(new Error('user_cancelled')));
});
