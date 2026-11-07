// A deleted entry and the Key Vault index (#407): the entry stays gone whatever runs at the same moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';

const CID = 'kv-team.vault.azure.net';

/** Key Vault secrets as far as these tests need them, with soft delete. A request can be held or refused. */
function fakeVault() {
  const secrets = new Map();
  const deleted = new Map();
  const holds = [];
  const refusals = [];
  let seq = 0;
  const json = (status, body) => new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
  const bundle = (name, v) => ({ id: `https://${CID}/secrets/${name}/${v.version}`, value: v.value, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
  const answer = (method, url, init) => {
    const [kind, name] = url.pathname.split('/').filter(Boolean);
    if (kind === 'secrets' && !name) return json(200, { value: [...secrets].map(([n, v]) => ({ id: `https://${CID}/secrets/${n}`, tags: v.tags, contentType: v.contentType, attributes: v.attributes })), nextLink: null });
    if (method === 'GET') return secrets.has(name) ? json(200, bundle(name, secrets.get(name))) : notFound();
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      seq += 1;
      const at = Math.floor(Date.now() / 1000) + seq;
      const v = { version: `v${seq}`, value: body.value, tags: body.tags, contentType: body.contentType, attributes: { enabled: true, created: at, updated: at } };
      secrets.set(name, v);
      return json(200, bundle(name, v));
    }
    if (method === 'DELETE') {
      if (!secrets.has(name)) return notFound();
      deleted.set(name, secrets.get(name));
      secrets.delete(name);
      return json(200, { recoveryId: `https://${CID}/deletedsecrets/${name}` });
    }
    return json(400, { error: { code: 'BadRequest', message: url.pathname } });
  };
  async function fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    const call = `${method} ${url.pathname.replace(/\/+$/, '')}`;
    if (refusals.includes(call)) return json(403, { error: { code: 'Forbidden', message: 'refused' } });
    const held = holds.findIndex((h) => h.call === call);
    if (held < 0) return answer(method, url, init);
    const [h] = holds.splice(held, 1);
    // A read was answered by the vault already and is on its way back; a write has not reached the vault yet.
    const read = method === 'GET' ? answer(method, url, init) : null;
    h.reached();
    await h.released;
    return read || answer(method, url, init);
  }
  /** The next such request waits until release(); `reached` says it has got that far. */
  const hold = (call) => {
    const h = { call };
    const reached = new Promise((r) => { h.reached = r; });
    let release;
    h.released = new Promise((r) => { release = r; });
    holds.push(h);
    return { reached, release };
  };
  return { fetch, secrets, deleted, hold, refusals };
}

const client = (kv, who = 'alice@contoso.com') => new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => who });

/** A vault with Alpha and Beta, its index written. */
async function setup() {
  const kv = fakeVault();
  const session = client(kv);
  await session.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  await session.refreshIndex([CID]);
  for (const title of ['Alpha', 'Beta']) await session.saveItem(CID, { title, password: `${title}-secret` });
  await session.flushFastIndex();
  const victim = (await session.index())[CID].items.find((i) => i.title === 'Alpha');
  return { kv, session, victim };
}

const titles = async (session) => (await session.index())[CID].items.map((i) => i.title).sort();

/** What another app sees at its next start: the vault's own index, not the local one. */
async function otherApp(kv) {
  const other = client(kv, 'bob@contoso.com');
  await other.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return titles({ index: () => other.refreshIndexFast() });
}

function assertSecretGone(kv, victim) {
  assert.equal(kv.secrets.has(victim.id), false, 'the secret is gone from the vault');
  assert.equal(kv.deleted.has(victim.id), true, 'and in its trash');
}

test('deleted while the index is being read from the vault: stays gone, also in the vault index', async () => {
  const { kv, session, victim } = await setup();
  const read = kv.hold('GET /secrets/pws-index');
  const refreshing = session.refreshIndexFast([CID]);
  await read.reached;
  await session.deleteItem(CID, victim.id);
  read.release();
  await refreshing;
  assertSecretGone(kv, victim);
  assert.deepEqual(await titles(session), ['Beta'], 'list after the refresh');
  await session.flushFastIndex();
  assert.deepEqual(await otherApp(kv), ['Beta'], 'vault index after the next write');
});

test('deleted while the listing runs: stays gone', async () => {
  const { kv, session, victim } = await setup();
  const list = kv.hold('GET /secrets');
  const refreshing = session.refreshIndex([CID]);
  await list.reached;
  await session.deleteItem(CID, victim.id);
  list.release();
  await refreshing;
  assertSecretGone(kv, victim);
  assert.deepEqual(await titles(session), ['Beta'], 'list after the listing');
  await session.flushFastIndex();
  assert.deepEqual(await otherApp(kv), ['Beta'], 'vault index after the next write');
});

test('refresh while the own deletion is being written to the vault index: the old index does not bring it back', async () => {
  const { kv, session, victim } = await setup();
  await session.deleteItem(CID, victim.id);
  const write = kv.hold('PUT /secrets/pws-index-00');
  const writing = session.flushFastIndex(); // the same as the debounce timer firing
  await write.reached;
  const refreshing = session.refreshIndexFast([CID]);
  await new Promise((r) => setTimeout(r, 50));
  write.release();
  await Promise.all([writing, refreshing]);
  assert.deepEqual(await titles(session), ['Beta'], 'list after the refresh');
  assert.deepEqual(await otherApp(kv), ['Beta'], 'vault index');
});

test('the index write fails: a refresh does not bring the deleted entry back from the old index', async () => {
  const { kv, session, victim } = await setup();
  kv.refusals.push('PUT /secrets/pws-index-00', 'PUT /secrets/pws-index');
  await session.deleteItem(CID, victim.id);
  assert.deepEqual(await titles(session), ['Beta']);
  await session.refreshIndexFast([CID]);
  assertSecretGone(kv, victim);
  assert.deepEqual(await titles(session), ['Beta'], 'list after the refresh');
});

test('already gone from the vault (another app, drift): deleting takes it off the list', async () => {
  const { kv, session, victim } = await setup();
  kv.deleted.set(victim.id, kv.secrets.get(victim.id));
  kv.secrets.delete(victim.id);
  await session.deleteItem(CID, victim.id);
  assert.deepEqual(await titles(session), ['Beta']);
});

test('deleted by another app: the listing removes the local copy, an old copy is not served', async () => {
  const { kv, session, victim } = await setup();
  assert.ok(await session.store.get(`item:${CID}/${victim.id}`), 'saving left a copy');
  kv.deleted.set(victim.id, kv.secrets.get(victim.id));
  kv.secrets.delete(victim.id);
  await session.refreshIndex([CID]);
  assert.equal(await session.store.get(`item:${CID}/${victim.id}`) ?? null, null, 'copy gone');
  await assert.rejects(session.getItem(CID, victim.id), 'not readable');
});

test('the index write works again: the listing brings the vault index up to date and the fast path is back', async () => {
  const { kv, session, victim } = await setup();
  kv.refusals.push('PUT /secrets/pws-index-00', 'PUT /secrets/pws-index');
  await session.deleteItem(CID, victim.id);
  await session.flushFastIndex();
  kv.refusals.length = 0;
  await session.refreshIndexFast([CID]);
  await session.flushFastIndex();
  assert.deepEqual(await otherApp(kv), ['Beta']);
  assert.equal(session.fastIndexDirty.has(CID), false, 'nothing left to write');
});

test('read while deleting: no copy of the password stays in the local cache', async () => {
  const { kv, session, victim } = await setup();
  await session.store.remove(`item:${CID}/${victim.id}`);
  const read = kv.hold(`GET /secrets/${victim.id}`);
  const reading = session.getItem(CID, victim.id, { fresh: true });
  await read.reached;
  await session.deleteItem(CID, victim.id);
  read.release();
  await reading.catch(() => null);
  assert.equal(await session.store.get(`item:${CID}/${victim.id}`) ?? null, null, 'nothing cached');
  await assert.rejects(session.getItem(CID, victim.id), 'not readable after deleting');
});

/** The vault of setup(), and a new app that has not loaded its index yet. */
async function newApp() {
  const { kv, session } = await setup();
  session.close?.();
  const app = client(kv, 'bob@contoso.com');
  await app.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  assert.equal((await app.index())[CID], undefined, 'nothing loaded yet');
  return { kv, app };
}

// Konrad F15: without a local index an own change makes a list of that entry alone. saveItem usually loads first (its
// license count); these go straight to updateIndex, as any path does whose load failed or has not ended.
const gamma = { id: 'gamma', containerId: CID, type: 'login', title: 'Gamma', hosts: [], rpIds: [], updated: 1000 };
const addGamma = (list) => [...list.filter((i) => i.id !== 'gamma'), gamma];

test('changed during the very first load: the load counts, the change stays, the vault index stays whole', async () => {
  const { kv, app } = await newApp();
  app.fastIndexDirty = new Set([CID]);
  const list = kv.hold('GET /secrets');
  const loading = app.refreshIndex([CID]);
  await list.reached;
  await app.updateIndex(CID, addGamma);
  await app.flushFastIndex();
  list.release();
  await loading;
  assert.deepEqual(await titles(app), ['Alpha', 'Beta', 'Gamma'], 'whole list with the change');
  await app.flushFastIndex();
  assert.deepEqual(await otherApp(kv), ['Alpha', 'Beta', 'Gamma'], 'vault index');
});

test('deleted during the very first load: stays gone, the rest comes', async () => {
  const { kv, app } = await newApp();
  const loaded = client(kv);
  await loaded.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  const victim = (await loaded.refreshIndexFast())[CID].items.find((i) => i.title === 'Alpha');
  const list = kv.hold('GET /secrets');
  const loading = app.refreshIndex([CID]);
  await list.reached;
  await app.updateIndex(CID, (items) => items.filter((i) => i.id !== victim.id));
  list.release();
  await loading;
  assert.deepEqual(await titles(app), ['Beta']);
});

test('a change without any load: the partial list is not written over the vault index, the next load completes it', async () => {
  const { kv, app } = await newApp();
  const before = kv.secrets.get('pws-index').version;
  await app.updateIndex(CID, addGamma);
  await app.flushFastIndex();
  assert.equal(kv.secrets.get('pws-index').version, before, 'vault index untouched');
  assert.equal((await app.summaries()).length, 3, 'summaries() does not take the partial list as loaded');
  assert.deepEqual(await titles(app), ['Alpha', 'Beta', 'Gamma']);
  await app.flushFastIndex();
  assert.deepEqual(await otherApp(kv), ['Alpha', 'Beta', 'Gamma']);
});

test('a loaded local index that changed during the load is still kept (not F15)', async () => {
  const { kv, session, victim } = await setup();
  const list = kv.hold('GET /secrets');
  const loading = session.refreshIndex([CID]);
  await list.reached;
  await session.deleteItem(CID, victim.id);
  list.release();
  await loading;
  assert.equal((await session.index())[CID].partial, undefined);
  assert.deepEqual(await titles(session), ['Beta']);
});

// Konrad F16.
const setWrite = async (session, write) => {
  const containers = await session.store.get('containers');
  await session.store.set('containers', containers.map((c) => ({ ...c, access: { ...c.access, write } })));
};
const staleSummary = async (session, victim) => {
  const index = await session.index();
  index[CID].items = index[CID].items.map((i) => (i.id === victim.id ? { ...i, updated: 1 } : i));
  await session.store.set('index', index);
};

test('read only: a newer entry found on reading leaves the fast path in place; with write access it is written', async () => {
  const { session, victim } = await setup();
  await session.flushFastIndex();
  await setWrite(session, false);
  await staleSummary(session, victim);
  await session.getItem(CID, victim.id, { fresh: true });
  assert.equal(session.fastIndexDirty.has(CID), false, 'no full listing on every refresh');
  await setWrite(session, true);
  await staleSummary(session, victim);
  await session.getItem(CID, victim.id, { fresh: true });
  assert.equal(session.fastIndexDirty.has(CID), true, 'this is what tells the check above from one that never marks');
  await session.flushFastIndex();
});

// Konrad, rest of #408: the extension's sessionStore is asynchronous.
test('deleted while the copy is being written: the copy goes again', async () => {
  const { session, victim } = await setup();
  const key = `item:${CID}/${victim.id}`;
  await session.store.remove(key);
  const { set } = session.store;
  // The write is on its way and lands after the deletion has removed the copy and is done.
  session.store.set = async function (k, v) {
    if (k === key) await session.deleteItem(CID, victim.id);
    await set.call(this, k, v);
  };
  await session.getItem(CID, victim.id, { fresh: true });
  session.store.set = set;
  assert.equal(await session.store.get(key) ?? null, null, 'nothing cached');
});
