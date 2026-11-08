import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { MoveAssetsError, moveWithAssets, planMoveWithAssets } from '../extension/core/move-assets.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const A = 'kv-a.vault.azure.net';
const B = 'kv-b.vault.azure.net';
const isEntry = (name) => name !== 'pws-container' && !name.startsWith('pws-index');
const entries = (kv) => [...kv.secrets.keys()].filter(isEntry);

// The role of the signed-in user in one vault (stored with the container list).
async function setAccess(session, id, access) {
  await session.store.set('containers', (await session.store.get('containers')).map((c) => (c.id === id ? { ...c, access } : c)));
}

// fail: { putB: n } = the n-th entry written to B fails, { deleteA: n } = the n-th entry deleted from A fails.
async function two(fail = {}) {
  const kvA = fakeKeyVault(A);
  const kvB = fakeKeyVault(B);
  let puts = 0;
  let latePuts = 0;
  let deletes = 0;
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`,
    store: new MemoryStore(),
    fetch: (input, init = {}) => {
      const url = new URL(input);
      const name = url.pathname.split('/')[2];
      if (url.hostname.startsWith('kv-b') && init.method === 'PUT' && isEntry(name) && ++puts === fail.putB) return Promise.resolve(new Response('{}', { status: 500 }));
      // The write arrives, the answer does not (timeout).
      if (url.hostname.startsWith('kv-b') && init.method === 'PUT' && isEntry(name) && (++latePuts >= fail.putBLate && latePuts < fail.putBLate + 3)) return kvB.fetch(input, init).then(() => { throw new Error('timeout'); });
      // Purge protection or no purge right in B.
      if (url.pathname.startsWith('/deletedsecrets/') && init.method === 'DELETE' && url.hostname.startsWith('kv-b') && fail.noPurgeB) return Promise.resolve(new Response('{}', { status: 403 }));
      if (url.hostname.startsWith('kv-a') && init.method === 'DELETE' && isEntry(name) && ++deletes === fail.deleteA) return Promise.resolve(new Response('{}', { status: 500 }));
      return (url.hostname.startsWith('kv-a') ? kvA : kvB).fetch(input, init);
    },
    actor: () => 'bob@contoso.com',
  });
  await session.refreshContainers({ configured: [{ name: 'A', vaultUrl: 'kv-a' }, { name: 'B', vaultUrl: 'kv-b' }], discover: false });
  const login = await session.saveItem(A, { type: 'login', title: 'Admin', username: 'a', password: 'x', folder: 'Kunden' });
  const vm1 = await session.saveItem(A, { type: 'server', title: 'VM01', folder: 'Kunden', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}`, bastionVmLink: `${A}/${login.id}` } });
  const vm2 = await session.saveItem(A, { type: 'server', title: 'VM02', folder: 'Kunden', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}` } });
  return { kvA, kvB, session, login, vm1, vm2 };
}

test('plan: the entries that use a login move along, in the order they are created', async () => {
  const { session, login, vm1, vm2 } = await two();
  const plan = await planMoveWithAssets(session, A, B, login.id);
  assert.equal(plan.refused, null);
  assert.deepEqual(plan.members.map((m) => [m.title, m.role]), [['Admin', 'selected'], ['VM01', 'user'], ['VM02', 'user']]);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.dropped, []);
  // The server alone: the login is used by VM02 as well, so it stays behind and its links are lost.
  const solo = await planMoveWithAssets(session, A, B, vm1.id);
  assert.deepEqual(solo.members.map((m) => m.title), ['VM01']);
  assert.deepEqual(solo.dropped.map((d) => [d.title, d.uses]), [['VM01', ['rdp', 'bastionVm']]]);
  assert.ok(vm2);
});

test('a server takes the login with it that only it uses; the links stay valid', async () => {
  const { session, kvA, kvB, vm2, login } = await two();
  await session.deleteItem(A, (await session.linkedEntries(A, login.id)).find((e) => e.title === 'VM01').id);
  const plan = await planMoveWithAssets(session, A, B, vm2.id);
  assert.deepEqual(plan.members.map((m) => [m.title, m.role]), [['Admin', 'linked'], ['VM02', 'selected']]);
  const r = await moveWithAssets(session, A, B, vm2.id);
  assert.equal(r.saved.title, 'VM02');
  assert.equal(entries(kvA).length, 0);
  assert.equal(entries(kvB).length, 2);
  const newLogin = (await session.summaries()).find((s) => s.containerId === B && s.title === 'Admin');
  assert.equal((await session.getItem(B, r.saved.id)).server.rdpLink, `${B}/${newLogin.id}`);
  assert.deepEqual((await session.linkedEntries(B, newLogin.id)).map((e) => e.title), ['VM02']);
});

test('login with its assets: all arrive in the target with valid links, the source is empty', async () => {
  const { session, kvA, kvB, login } = await two();
  const r = await moveWithAssets(session, A, B, login.id, {});
  assert.equal(r.moved.length, 3);
  assert.equal(entries(kvA).length, 0);
  assert.equal(entries(kvB).length, 3);
  const newLogin = await session.getItem(B, r.saved.id);
  assert.equal(newLogin.title, 'Admin');
  const users = await session.linkedEntries(B, newLogin.id);
  assert.deepEqual(users.map((e) => [e.title, e.uses.join()]), [['VM01', 'rdp,bastionVm'], ['VM02', 'rdp']]);
  for (const u of users) assert.ok(!(await session.getItem(B, u.id)).server.rdpLink.startsWith(A));
});

test('counter-test: a failure in the middle leaves the source untouched and nothing in the target', async () => {
  const { session, kvA, kvB, login } = await two({ putB: 2 });
  await assert.rejects(moveWithAssets(session, A, B, login.id), (e) => e instanceof MoveAssetsError && e.stage === 'copy' && e.stuck.length === 0 && /unverändert im Quelltresor/.test(e.message));
  assert.equal(entries(kvA).length, 3);
  assert.equal(entries(kvB).length, 0, 'the copy made before the failure is removed again');
  assert.equal(kvB.deleted.size, 0, 'and purged: nothing a writer of the target could restore');
  assert.equal((await session.linkedEntries(A, login.id)).length, 2, 'links in the source are intact');
});

test('counter-test: a failed deletion in the source leaves complete, valid copies and names what is left', async () => {
  const { session, kvA, kvB, login } = await two({ deleteA: 2 });
  await assert.rejects(moveWithAssets(session, A, B, login.id), (e) => e instanceof MoveAssetsError && e.stage === 'delete' && e.left.length === 2 && /vollständig im Zieltresor/.test(e.message));
  assert.equal(entries(kvB).length, 3);
  const newLogin = (await session.summaries()).find((s) => s.containerId === B && s.title === 'Admin');
  assert.equal((await session.linkedEntries(B, newLogin.id)).length, 2, 'links in the target are valid');
  assert.equal(entries(kvA).length, 2, 'what is left is named, nothing is lost');
});

test('counter-test: without write access in the target nothing moves and the entries are listed', async () => {
  const { session, kvA, kvB, login } = await two();
  await setAccess(session, B, { read: true, write: false });
  const plan = await planMoveWithAssets(session, A, B, login.id);
  assert.match(plan.refused, /Schreibrecht/);
  assert.deepEqual(plan.members, []);
  assert.deepEqual(plan.blocked.map((b) => b.title).sort(), ['Admin', 'VM01', 'VM02']);
  await assert.rejects(moveWithAssets(session, A, B, login.id), /Schreibrecht/);
  assert.equal(entries(kvA).length, 3);
  assert.equal(entries(kvB).length, 0);
});

test('without write access in the source the originals cannot be removed: refused up front', async () => {
  const { session, login } = await two();
  await setAccess(session, A, { read: true, write: false });
  await assert.rejects(moveWithAssets(session, A, B, login.id), /Schreibrecht zum Entfernen/);
});

test('a linked login whose own target stays behind is listed as blocked and stays', async () => {
  const { session, kvA, kvB, login } = await two();
  const t1 = await session.saveItem(A, { type: 'login', title: 'Linked', loginLink: `${A}/${login.id}` });
  const s1 = await session.saveItem(A, { type: 'server', title: 'SRV', server: { kind: 'azurevm', rdpLink: `${A}/${t1.id}` } });
  const plan = await planMoveWithAssets(session, A, B, s1.id);
  assert.deepEqual(plan.members.map((m) => m.title), ['SRV']);
  assert.deepEqual(plan.blocked.map((b) => b.title), ['Linked']);
  assert.deepEqual(plan.dropped.map((d) => [d.title, d.uses]), [['SRV', ['rdp']]]);
  // A linked login alone does not move to another vault (#328).
  // #462: a plan that says why, not an error before any dialog.
  const alone = await planMoveWithAssets(session, A, B, t1.id);
  assert.match(alone.refused, /Anmeldung eines anderen Eintrags/);
  assert.deepEqual(alone.members, []);
  await assert.rejects(moveWithAssets(session, A, B, t1.id), /Anmeldung eines anderen Eintrags/);
  await moveWithAssets(session, A, B, s1.id);
  assert.equal(entries(kvB).length, 1);
  assert.equal(entries(kvA).length, 4);
});

test('same vault, another folder: all move; a failure in the middle puts every entry back', async () => {
  const ok = await two();
  const r = await moveWithAssets(ok.session, A, A, ok.login.id, { folder: 'Neu' });
  assert.equal(r.moved.length, 3);
  for (const s of (await ok.session.summaries()).filter((x) => x.containerId === A)) assert.equal((await ok.session.getItem(A, s.id)).folder, 'Neu');
  assert.equal((await ok.session.linkedEntries(A, ok.login.id)).length, 2, 'links unchanged');

  // Third write to A fails (the PUTs of the setup do not count: the counter starts here).
  const kv = fakeKeyVault(A);
  let puts = 0;
  let armed = false;
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), actor: () => 'bob@contoso.com',
    fetch: (input, init = {}) => (armed && init.method === 'PUT' && isEntry(new URL(input).pathname.split('/')[2]) && ++puts === 3 ? Promise.resolve(new Response('{}', { status: 500 })) : kv.fetch(input, init)),
  });
  await session.refreshContainers({ configured: [{ name: 'A', vaultUrl: 'kv-a' }], discover: false });
  const login = await session.saveItem(A, { type: 'login', title: 'Admin', password: 'x', folder: 'Alt' });
  await session.saveItem(A, { type: 'server', title: 'VM01', folder: 'Alt', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}` } });
  await session.saveItem(A, { type: 'server', title: 'VM02', folder: 'Alt', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}` } });
  armed = true;
  await assert.rejects(moveWithAssets(session, A, A, login.id, { folder: 'Neu' }), (e) => e instanceof MoveAssetsError && /alten Ordner/.test(e.message));
  for (const s of await session.summaries()) assert.equal((await session.getItem(A, s.id, { fresh: true })).folder, 'Alt', `${s.title} is back`);
});

test('counter-test: without purge right in the target the message names what lies in its recycle bin', async () => {
  const { session, kvA, kvB, login } = await two({ putB: 2, noPurgeB: true });
  await assert.rejects(moveWithAssets(session, A, B, login.id, { purgeRetryMs: 0 }), (e) => e instanceof MoveAssetsError && e.stage === 'copy' && e.trash.join() === 'Admin'
    && /Papierkorb des Zieltresors/.test(e.message) && !/nichts übrig geblieben/.test(e.message));
  assert.equal(entries(kvA).length, 3);
  assert.equal(entries(kvB).length, 0);
  assert.equal(kvB.deleted.size, 1, 'the copy really is in the recycle bin');
});

test('counter-test: a write that timed out but arrived is found in the target and removed', async () => {
  const { session, kvA, kvB, login } = await two({ putBLate: 2 });
  await assert.rejects(moveWithAssets(session, A, B, login.id, { purgeRetryMs: 0 }), (e) => e instanceof MoveAssetsError && e.stage === 'copy' && e.stuck.length === 0 && /nichts übrig geblieben/.test(e.message));
  assert.equal(entries(kvA).length, 3);
  assert.equal(entries(kvB).length, 0, 'both copies, the confirmed and the unconfirmed one, are gone');
  assert.equal(kvB.deleted.size, 0, 'and purged');
});

test('counter-test: the list the dialog showed must match the plan at the time of the move', async () => {
  const { session, kvA, kvB, login, vm1 } = await two();
  const shown = (await planMoveWithAssets(session, A, B, login.id)).members.map((m) => m.id);
  // Meanwhile another entry starts to use the login.
  await session.saveItem(A, { type: 'server', title: 'VM03', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}` } });
  await assert.rejects(moveWithAssets(session, A, B, login.id, { expected: shown }), /Verknüpfungen haben sich geändert/);
  assert.equal(entries(kvA).length, 4);
  assert.equal(entries(kvB).length, 0);
  // With the current list it goes through.
  const now = (await planMoveWithAssets(session, A, B, login.id)).members.map((m) => m.id);
  const r = await moveWithAssets(session, A, B, login.id, { expected: now });
  assert.equal(r.moved.length, 4);
  assert.ok(vm1);
});

test('a link into a third vault is reported as removed and really is removed in the target', async () => {
  const { session, kvB, login } = await two();
  const C = 'kv-c.vault.azure.net';
  const srv = await session.saveItem(A, { type: 'server', title: 'SRV3', server: { kind: 'azurevm', rdpLink: `${C}/item-x` } });
  const plan = await planMoveWithAssets(session, A, B, srv.id);
  assert.deepEqual(plan.dropped.map((d) => [d.title, d.uses]), [['SRV3', ['rdp']]]);
  const r = await moveWithAssets(session, A, B, srv.id);
  assert.equal((await session.getItem(B, r.saved.id)).server.rdpLink, '');
  assert.ok(kvB && login);
});
