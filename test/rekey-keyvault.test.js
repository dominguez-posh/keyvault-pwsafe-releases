import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlockKeyring, KEY_CHANGE } from '../extension/core/protect.js';
import { VaultSession, MemoryStore } from '../extension/core/session.js';

KEY_CHANGE.enabled = true; // switched off in the app, tested switched on
import { setup } from './fixtures/fake-keyvault.js';

// Key change of a protected Key Vault container (#402).
test('key change: old recovery key and old keyring no longer open any secret; a stopped change is resumed on unlock', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  await session.saveItem(cid, { title: 'Firewall', username: 'admin', password: 'fw-secret', urls: ['fw.example.com'] });
  await session.saveItem(cid, { title: 'Router', password: 'r-secret' });
  const { recoveryKey: oldRk } = await session.enableProtection(cid, { password: 'master-password-1' });
  await session.addFolder(cid, 'Kunden/Contoso');
  const oldKeyring = JSON.parse(kv.secrets.get('pws-keyring').at(-1).value);
  const oldKey = (await unlockKeyring(oldKeyring, { code: oldRk })).ck;
  const names = () => [...kv.secrets].filter(([n, vs]) => vs.at(-1).value.startsWith('{"kvpwsafe-sealed"') && !n.startsWith('pws-index')).map(([n]) => n);
  assert.ok(names().length >= 3, 'two items and the folders are sealed');

  // The change is stopped halfway: one secret cannot be written (403).
  const stopName = names().find((n) => n !== 'pws-folders');
  const realFetch = kv.fetch;
  let blocked = true;
  session.fetch = async (input, init = {}) => {
    if (blocked && init.method === 'PUT' && new URL(input).pathname === `/secrets/${stopName}`) {
      return new Response(JSON.stringify({ error: { code: 'Forbidden', message: 'no' } }), { status: 403 });
    }
    return realFetch(input, init);
  };
  session.clients?.clear?.();
  const r = await session.updateProtection(cid, { type: 'rekey', password: 'new-password-2' });
  assert.match(r.recoveryKey, /^RK-/);
  assert.equal(r.failed.length, 1);
  assert.ok(JSON.parse(kv.secrets.get('pws-keyring').at(-1).value).prev, 'the old key stays sealed in the keyring until the end');

  // Another unlock (here with the new password) finishes the change.
  blocked = false;
  await session.lockContainer(cid);
  await assert.rejects(session.unlockContainer(cid, { code: oldRk }), { name: 'UnlockError' });
  await assert.rejects(session.unlockContainer(cid, { password: 'master-password-1' }), { name: 'UnlockError' });
  await session.unlockContainer(cid, { password: 'new-password-2' });
  const keyring = JSON.parse(kv.secrets.get('pws-keyring').at(-1).value);
  assert.equal(keyring.prev, undefined, 'finished');
  assert.equal(keyring.keyVersion, 2);

  // The old key (from the old recovery key) opens no sealed secret any more, the new key opens all of them.
  const newKey = (await unlockKeyring(keyring, { password: 'new-password-2' })).ck;
  for (const n of names()) {
    const text = kv.secrets.get(n).at(-1).value;
    const sealed = JSON.parse(text);
    const data = typeof sealed['kvpwsafe-sealed'] === 'string' ? sealed['kvpwsafe-sealed'] : sealed.data;
    await assert.rejects(oldKey.decrypt(data, `${cid}/${n}`), `old key opens ${n}`);
    await newKey.decrypt(data, `${cid}/${n}`);
  }
  // Older versions are switched off, so that they do not hand out the old ciphertext.
  for (const n of names().filter((x) => x !== 'pws-folders')) {
    const versions = kv.secrets.get(n);
    assert.ok(versions.slice(0, -1).every((v) => v.attributes.enabled === false), `old versions of ${n} disabled`);
  }
  const list = await session.summaries({ maxAgeMs: 0 });
  assert.deepEqual(list.map((x) => x.title).sort(), ['Firewall', 'Router']);
  assert.equal((await session.getItem(cid, list.find((x) => x.title === 'Firewall').id, { fresh: true })).password, 'fw-secret');
  assert.deepEqual(await session.folders(cid), ['Kunden/Contoso']);

  // A second device still holding the old key: it is dropped, the container shows as locked.
  await session.store.set(`ck:${cid}`, oldKey.exported);
  session.keys.clear();
  assert.equal((await session.protectionInfo(cid, 'localhost')).locked, true);
  assert.equal(await session.store.get(`ck:${cid}`), undefined);
});

test('#402 finding 1: a device that unlocked before the change cannot seal anything with the old key afterwards; old keyring versions are off', async () => {
  const { kv, session: a } = await setup();
  const cid = 'kv-team.vault.azure.net';
  await a.saveItem(cid, { title: 'X', password: 'p1' });
  const { recoveryKey: oldRk } = await a.enableProtection(cid, { password: 'master-password-1' });
  const oldKeyring = JSON.parse(kv.secrets.get('pws-keyring').at(-1).value);
  const b = new VaultSession({ getToken: async (s) => `token-${s}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => 'bob@contoso.com' });
  await b.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  await b.unlockContainer(cid, { password: 'master-password-1' });

  const r = await a.updateProtection(cid, { type: 'rekey', password: 'new-password-2' });
  assert.equal(r.failed.length, 0);
  assert.equal(kv.secrets.get('pws-keyring').slice(0, -1).every((v) => v.attributes.enabled === false), true, 'older keyring versions are off');

  const names = () => [...kv.secrets].map(([n, vs]) => `${n}@${vs.length}`).join();
  const before = names();
  await assert.rejects(b.saveItem(cid, { title: 'Written by the stale device', password: 'after' }), { name: 'ContainerLockedError' });
  await assert.rejects(b.addFolder(cid, 'Stale/Folder'), { name: 'ContainerLockedError' });
  await assert.rejects(b.setContainerLogo(cid, 'data:image/png;base64,AAAA'), (e) => e.name === 'ContainerLockedError' || /Bild/.test(e.message));
  assert.equal(names(), before, 'nothing was written with the old key');
  assert.equal((await b.protectionInfo(cid, 'localhost')).locked, true, 'the stale session is locked and asks again');

  // The old recovery key with the old keyring version opens nothing of the new state.
  const oldCk = (await unlockKeyring(oldKeyring, { code: oldRk })).ck;
  const saved = await a.saveItem(cid, { title: 'After', password: 'p2' });
  const data = JSON.parse(kv.secrets.get(saved.id).at(-1).value).data;
  await assert.rejects(oldCk.decrypt(data, `${cid}/${saved.id}`));
  // And unlocking again with the new password works for the other device.
  await b.unlockContainer(cid, { password: 'new-password-2' });
  assert.equal((await b.saveItem(cid, { title: 'Now fine', password: 'p3' })).title, 'Now fine');
});

test('#402 Konrad, low: a version written during the change (newer than the one kept) is not disabled', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  await session.saveItem(cid, { title: 'X', password: 'p1' });
  await session.enableProtection(cid, { password: 'master-password-1' });
  // Protection stores the item under a new name.
  const name = [...kv.secrets.keys()].find((n) => !['pws-container', 'pws-keyring'].includes(n) && !n.startsWith('pws-index'));
  const realFetch = kv.fetch;
  let injected = false;
  session.fetch = async (input, init = {}) => {
    const url = new URL(input);
    // Just before the old versions are switched off, another writer stores a newer version of the item.
    if (!injected && url.pathname === `/secrets/${name}/versions`) {
      injected = true;
      const latest = kv.secrets.get(name).at(-1);
      await realFetch(`https://kv-team.vault.azure.net/secrets/${name}?api-version=7.5`, { method: 'PUT', headers: { Authorization: 'Bearer token-x', 'Content-Type': 'application/json' }, body: JSON.stringify({ value: latest.value, tags: latest.tags, contentType: latest.contentType }) });
    }
    return realFetch(input, init);
  };
  session.clients?.clear?.();
  const r = await session.updateProtection(cid, { type: 'rekey', password: 'new-password-2' });
  assert.equal(r.failed.length, 0);
  assert.ok(injected, 'the versions of the item were listed');
  const versions = kv.secrets.get(name);
  assert.equal(versions.at(-1).attributes.enabled, true, 'the newer concurrent version stays enabled');
  assert.equal(versions.at(-2).attributes.enabled, true, 'the version written by the change stays enabled');
  assert.ok(versions.slice(0, -2).every((v) => v.attributes.enabled === false), 'versions before the change are off');
});

test('switched off: the Key Vault change is refused and nothing is touched', async () => {
  KEY_CHANGE.enabled = false;
  try {
    const { kv, session } = await setup();
    const cid = 'kv-team.vault.azure.net';
    await session.saveItem(cid, { title: 'X', password: 'p1' });
    await session.enableProtection(cid, { password: 'master-password-1' });
    const before = JSON.stringify([...kv.secrets].map(([n, vs]) => [n, vs.length]));
    await assert.rejects(session.updateProtection(cid, { type: 'rekey', password: 'new-password-2' }), /nicht eingeschaltet/);
    assert.equal(JSON.stringify([...kv.secrets].map(([n, vs]) => [n, vs.length])), before);
    // A new recovery key is the plain wrapping again, as before.
    const r = await session.updateProtection(cid, { type: 'newRecovery' });
    assert.match(r.recoveryKey, /^RK-/);
  } finally {
    KEY_CHANGE.enabled = true;
  }
});
