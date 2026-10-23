import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { requestCode, validRequestCode, verifyLicense, issueLicense, FREE_LIMIT } from '../extension/core/license.js';
import { VaultSession, MemoryStore } from '../extension/core/session.js';

async function testKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signing = await crypto.subtle.importKey('pkcs8', privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'Ed25519' }, false, ['sign']);
  return { signing, pub: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64url') };
}

test('license: request code per vault name, signed key valid only for that vault', async () => {
  const code = await requestCode('KV-Team.vault.azure.net');
  assert.match(code, /^KVP-[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.equal(code, await requestCode('kv-team.vault.azure.net'), 'case does not matter');
  assert.notEqual(code, await requestCode('kv-other.vault.azure.net'));
  assert.equal(await validRequestCode(code), true);
  assert.equal(await validRequestCode(code.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), false, 'typo is caught');

  const { signing, pub } = await testKeys();
  const key = await issueLicense({ privateKey: signing, code, vault: 'kv-team.vault.azure.net', to: 'Contoso' });
  assert.equal((await verifyLicense(key, 'kv-team.vault.azure.net', pub)).valid, true);
  assert.equal((await verifyLicense(key, 'kv-other.vault.azure.net', pub)).valid, false, 'bound to the vault');
  const other = await testKeys();
  assert.equal((await verifyLicense(key, 'kv-team.vault.azure.net', other.pub)).valid, false, 'foreign signature rejected');
  const [head, sig] = key.split('.');
  const forged = `${head.slice(0, -2)}AA.${sig}`;
  assert.equal((await verifyLicense(forged, 'kv-team.vault.azure.net', pub)).valid, false, 'tampered payload rejected');
});

test('license: without license a vault holds FREE_LIMIT entries; edits stay possible', async () => {
  const secrets = new Map();
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let v = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const [, kind, name] = u.pathname.split('/');
    const method = init.method || 'GET';
    if (kind === 'secrets' && !name) return json(200, { value: [...secrets].map(([n, s]) => ({ id: `https://kv-small.vault.azure.net/secrets/${n}`, tags: s.tags, attributes: { enabled: true, updated: 1 } })) });
    if (method === 'PUT') {
      const b = JSON.parse(init.body);
      secrets.set(name, { ...b, version: String(++v) });
      return json(200, { id: `https://kv-small.vault.azure.net/secrets/${name}/${v}`, value: b.value, tags: b.tags, attributes: { enabled: true, updated: 1 } });
    }
    if (method === 'GET' && secrets.has(name)) {
      const s = secrets.get(name);
      return json(200, { id: `https://kv-small.vault.azure.net/secrets/${name}/${s.version}`, value: s.value, tags: s.tags, attributes: { enabled: true, updated: 1 } });
    }
    return json(404, { error: { code: 'SecretNotFound' } });
  };
  const session = new VaultSession({ getToken: async () => 'token', store: new MemoryStore(), fetch, actor: () => 'a@b.c' });
  await session.refreshContainers({ configured: [{ name: 'Klein', vaultUrl: 'kv-small' }], discover: false });
  const cid = 'kv-small.vault.azure.net';
  let first;
  for (let i = 0; i < FREE_LIMIT; i++) {
    const saved = await session.saveItem(cid, { title: `E${i}` });
    first ??= saved;
    await session.refreshIndex();
  }
  await assert.rejects(session.saveItem(cid, { title: 'one too many' }), (e) => e.name === 'LicenseLimitError');
  const item = await session.getItem(cid, first.id, { fresh: true });
  await session.saveItem(cid, { ...item, title: 'renamed' }, { expectedVersion: item.version });
  const state = await session.licenseState(cid);
  assert.equal(state.licensed, false);
  assert.equal(state.count, FREE_LIMIT);
  assert.equal(state.code, await requestCode(cid));
});
