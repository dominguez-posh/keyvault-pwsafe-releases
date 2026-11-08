// #476 "Nur für mich": an entry of a shared vault only its owner sees. Filter by owner (lists, search, autofill, MCP),
// root rule (never in a folder), saving keeps the flag, admin view only where the person is Verwalter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { serializeItem, summaryFromSecret, normalizeItem } from '../extension/core/model.js';
import { visibleTo, withPrivacy, requirePrivateRoot, privateFirst, mayMakePrivate } from '../extension/core/private.js';
import { parseImport } from '../extension/core/importer.js';
import { McpService } from '../desktop/mcp.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const CID = 'kv-team.vault.azure.net';

async function twoMembers() {
  const kv = fakeKeyVault(CID);
  const member = async (oid, who) => {
    const s = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => who, viewer: () => oid });
    await s.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
    return s;
  };
  return { kv, alice: await member('oid-alice', 'alice@contoso.com'), bob: await member('oid-bob', 'bob@contoso.com') };
}

const fresh = async (s) => { await s.refreshIndex(); return s.summaries({ maxAgeMs: Infinity }); };
const ALICE = { owner: 'oid-alice', name: 'Alice Admin' };

test('#476 model: owner in the metadata (one tag "objectId name"), read back into the summary', () => {
  const { tags, doc } = serializeItem({ title: 'M365 Kunde', privateOwner: 'oid-alice', privateOwnerName: 'Alice Admin' });
  assert.equal(tags.po, 'oid-alice Alice Admin');
  assert.equal(doc.privateOwner, 'oid-alice');
  const s = summaryFromSecret({ name: 'pws-1', tags }, CID);
  assert.equal(s.privateOwner, 'oid-alice');
  assert.equal(s.privateOwnerName, 'Alice Admin');
  assert.equal(serializeItem({ title: 'Öffentlich' }).tags.po, undefined);
  assert.equal(normalizeItem({ privateOwnerName: 'x' }).privateOwnerName, '', 'no name without an owner');
});

test('#476 filter by owner: the owner sees it, others not; `others` only where allowed', () => {
  const e = { containerId: CID, privateOwner: 'oid-alice' };
  assert.equal(visibleTo(e, 'oid-alice'), true);
  assert.equal(visibleTo(e, 'oid-bob'), false);
  assert.equal(visibleTo(e, ''), false, 'nobody signed in: hidden');
  assert.equal(visibleTo({ containerId: CID }, 'oid-bob'), true, 'public entries for everyone');
  assert.equal(visibleTo(e, 'oid-bob', (id) => id === CID), true, 'Verwalter of this vault with the switch on');
  assert.equal(visibleTo(e, 'oid-bob', (id) => id === 'other-vault'), false, 'Verwalter of another vault only');
  assert.deepEqual(privateFirst([{ t: 'a' }, { t: 'b', privateOwner: 'x' }]).map((x) => x.t), ['b', 'a']);
});

test('#476 root rule and saving: never in a folder; a plain save keeps the flag, only `privacy` changes it', () => {
  assert.throws(() => requirePrivateRoot({ title: 'X', privateOwner: 'oid-alice', folder: 'Kunden' }), /Root-Ordner|root folder/);
  requirePrivateRoot({ title: 'X', privateOwner: 'oid-alice', folder: '' });
  requirePrivateRoot({ title: 'X', folder: 'Kunden' });
  const known = { privateOwner: 'oid-alice', privateOwnerName: 'Alice' };
  assert.equal(withPrivacy({ title: 'X', privateOwner: '' }, known, undefined).privateOwner, 'oid-alice', 'an edit cannot drop it');
  assert.equal(withPrivacy({ title: 'X', privateOwner: 'oid-evil' }, null, undefined).privateOwner, '', 'nor set it');
  assert.equal(withPrivacy({ title: 'X' }, known, null).privateOwner, '', 'explicitly back to public');
});

test('#476 session: the other member does not see it – list, getItem, autofill, trash; the owner does', async () => {
  const { alice, bob } = await twoMembers();
  const mine = await alice.saveItem(CID, { title: 'M365 Kunde', username: 'alice@kunde.de', password: 'x', urls: ['https://login.kunde.de'] }, { privacy: ALICE });
  await alice.saveItem(CID, { title: 'Firewall', username: 'root', password: 'fw', urls: ['https://fw.contoso.com'] });
  assert.deepEqual((await fresh(alice)).map((s) => s.title).sort(), ['Firewall', 'M365 Kunde']);
  assert.deepEqual((await fresh(bob)).map((s) => s.title), ['Firewall']);
  await assert.rejects(bob.getItem(CID, mine.id), (e) => e.status === 404);
  assert.equal((await bob.matchesForHost('login.kunde.de')).length, 0, 'no autofill for others');
  assert.equal((await alice.matchesForHost('login.kunde.de')).length, 1);
  assert.equal((await alice.getItem(CID, mine.id)).privateOwner, 'oid-alice');
  // Admin view: Verwalter with the switch on – the entry with the owner's name.
  const shown = await bob.summaries({ maxAgeMs: Infinity, others: (id) => id === CID });
  assert.equal(shown.find((s) => s.id === mine.id)?.privateOwnerName, 'Alice Admin');
  assert.equal((await bob.getItem(CID, mine.id, { others: () => true })).title, 'M365 Kunde');
  await alice.deleteItem(CID, mine.id);
  assert.equal((await bob.trash(CID)).length, 0, 'the trash hides it too');
  assert.equal((await alice.trash(CID)).length, 1);
});

test('#476 session: moving into a folder is refused (save with folder, move), a plain edit keeps it private', async () => {
  const { alice, bob } = await twoMembers();
  const mine = await alice.saveItem(CID, { title: 'Privat', password: 'x' }, { privacy: ALICE });
  await assert.rejects(alice.saveItem(CID, { ...mine, folder: 'Kunden' }), /Root-Ordner|root folder/);
  await assert.rejects(alice.moveItem(CID, CID, mine.id, { folder: 'Kunden' }), /Root-Ordner|root folder/);
  await assert.rejects(alice.saveItem(CID, { title: 'Neu', privateOwner: 'oid-alice', folder: 'Kunden' }, { privacy: ALICE }), /Root-Ordner|root folder/);
  // An edit that does not know the flag (e.g. an older client) keeps it.
  const { privateOwner, privateOwnerName, ...plain } = await alice.getItem(CID, mine.id);
  await alice.saveItem(CID, { ...plain, title: 'Privat 2' });
  assert.deepEqual((await fresh(bob)).map((s) => s.title), []);
  assert.equal((await alice.getItem(CID, mine.id, { fresh: true })).privateOwner, 'oid-alice');
  // Back to public: everyone sees it.
  await alice.saveItem(CID, await alice.getItem(CID, mine.id), { privacy: null });
  assert.deepEqual((await fresh(bob)).map((s) => s.title), ['Privat 2']);
});

test('#476 MCP: search_entries and get_entry leave out other people\'s private entries', async () => {
  const { alice, bob } = await twoMembers();
  const mine = await alice.saveItem(CID, { title: 'Azure Kunde', username: 'a@kunde.de', password: 'S3cret' }, { privacy: ALICE });
  await bob.refreshIndex();
  const mcp = new McpService({ admitted: () => true, policy: () => ({ write: true }), vault: () => bob,
    confirmRead: async () => 'session', confirmWrite: async () => true, audit: () => {} });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  const r = await mcp.call(client, 'search_entries', { query: 'azure' });
  assert.equal(r.total, 0);
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: CID, entryId: mine.id }));
  // The owner's agent finds it.
  await alice.refreshIndex();
  const own = new McpService({ admitted: () => true, policy: () => ({ write: true }), vault: () => alice,
    confirmRead: async () => 'session', confirmWrite: async () => true, audit: () => {} });
  own.connect(client);
  assert.equal((await own.call(client, 'search_entries', { query: 'azure' })).total, 1);
});

// --- Review findings (Konrad, #476) ---

test('#476 review 1: "Nur für mich" only for the creator of the entry or a Verwalter', async () => {
  assert.equal(mayMakePrivate({ createdBy: 'Alice@Contoso.com' }, 'alice@contoso.com'), true, 'own entry (case-insensitive)');
  assert.equal(mayMakePrivate({ createdBy: 'alice@contoso.com' }, 'bob@contoso.com'), false, 'someone else\'s entry');
  assert.equal(mayMakePrivate({ createdBy: '' }, 'bob@contoso.com'), false, 'unknown creator');
  assert.equal(mayMakePrivate({ createdBy: '' }, ''), false, 'nobody signed in');
  assert.equal(mayMakePrivate({ createdBy: 'alice@contoso.com' }, 'bob@contoso.com', true), true, 'Verwalter: any entry');
  // The creator cannot be taken over by an edit: the session keeps the stored one.
  const { alice, bob } = await twoMembers();
  const e = await alice.saveItem(CID, { title: 'Firewall', password: 'fw' });
  await bob.refreshIndex();
  await bob.saveItem(CID, { ...(await bob.getItem(CID, e.id)), createdBy: 'bob@contoso.com' });
  const after = await bob.getItem(CID, e.id, { fresh: true });
  assert.equal(after.createdBy, 'alice@contoso.com');
  assert.equal(mayMakePrivate(after, 'bob@contoso.com'), false);
});

test('#476 review 2: the Keevault JSON import never brings "Nur für mich" along, also not into file vaults', async () => {
  const file = { text: JSON.stringify({ format: 'kvpwsafe', items: [{ title: 'X', privateOwner: 'oid-evil', privateOwnerName: 'Evil', folder: 'Kunden' }] }) };
  const { items } = await parseImport(file);
  assert.equal(items[0].privateOwner, '');
  assert.equal(items[0].privateOwnerName, '');
  // saveItems of an adapter (file vault) goes through withPrivacy as well.
  let written = null;
  const adapter = { containers: async () => [{ id: 'file-1', name: 'Datei', personal: true }], summaries: async () => [],
    saveItems: async (cid, list) => { written = list; return list.map((i) => ({ item: i })); } };
  const s = new VaultSession({ getToken: async () => 't', store: new MemoryStore(), actor: () => 'a', viewer: () => 'oid-a', adapters: { file: adapter } });
  const out = await s.saveItems('file-1', [{ title: 'Y', privateOwner: 'oid-evil', privateOwnerName: 'Evil' }]);
  assert.equal(out.length, 1);
  assert.equal(written[0].privateOwner, '');
  assert.equal(written[0].privateOwnerName, '');
});

test('#476 review 3: a save without expectedVersion keeps a flag that a stale index does not know yet', async () => {
  const { kv, alice } = await twoMembers();
  const e = await alice.saveItem(CID, { title: 'Passkey-Login', password: 'x' });
  // A second window of the same person (extension, bridge) with its index from before the flag.
  const other = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => 'alice@contoso.com', viewer: () => 'oid-alice' });
  await other.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  await other.refreshIndex();
  const before = await other.getItem(CID, e.id);
  await alice.saveItem(CID, await alice.getItem(CID, e.id, { fresh: true }), { privacy: ALICE });
  await other.saveItem(CID, { ...before, notes: 'signCount 2' }); // no expectedVersion, index still says public
  const now = await alice.getItem(CID, e.id, { fresh: true });
  assert.equal(now.privateOwner, 'oid-alice');
  assert.equal(now.notes, 'signCount 2');
});

test('#476 review 4: getVersion of an entry the index does not know is refused (fail-closed)', async () => {
  const { kv, alice } = await twoMembers();
  const e = await alice.saveItem(CID, { title: 'Sichtbar', password: 'x' });
  const [{ version }] = await alice.history(CID, e.id);
  assert.equal((await alice.getVersion(CID, e.id, version)).title, 'Sichtbar');
  // Not an entry of the index (no item tag): before the fix it counted as visible.
  const raw = kv.secrets.get(e.id).map((v) => ({ ...v, tags: {} }));
  kv.secrets.set('pws-raw', raw);
  await assert.rejects(alice.getVersion(CID, 'pws-raw', raw[0].version), (err) => err.status === 404);
});

test('#476 review 1: the main process refuses someone else\'s entry for a member, allows it for a Verwalter', async () => {
  const state = await import('../desktop/main/state.js');
  const { setPrivacy } = await import('../desktop/main/private.js');
  const { alice, bob } = await twoMembers();
  const theirs = await alice.saveItem(CID, { title: 'Firewall', password: 'fw' });
  const own = await bob.saveItem(CID, { title: 'Bobs Login', password: 'b' });
  await bob.refreshIndex();
  state.setVault(bob);
  state.setAuth({ account: { localAccountId: 'oid-bob', username: 'bob@contoso.com', name: 'Bob' } });
  state.setConfig({ get: () => ({ adminTools: true }) });
  await assert.rejects(setPrivacy(CID, theirs.id, true), /eigene Einträge|own entries/);
  assert.equal((await bob.getItem(CID, theirs.id, { fresh: true })).privateOwner, '', 'still public');
  assert.equal((await setPrivacy(CID, own.id, true)).privateOwner, 'oid-bob', 'own entry');
  // Verwalter of the vault: any entry.
  const stored = await bob.store.get('containers');
  await bob.store.set('containers', stored.map((c) => ({ ...c, access: { ...c.access, manage: true } })));
  assert.equal((await setPrivacy(CID, theirs.id, true)).privateOwner, 'oid-bob');
  state.setVault(null);
  state.setAuth(null);
  state.setConfig(undefined);
});
