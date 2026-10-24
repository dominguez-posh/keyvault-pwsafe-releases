import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore, ConflictError } from '../extension/core/session.js';
import { createCredential } from '../extension/core/webauthn.js';

// In-memory imitation of the Key Vault secrets REST API (paging with page size 2, versions, soft delete).
function fakeKeyVault(host) {
  const secrets = new Map(); // name -> [{ version, value, tags, contentType, attributes }]
  const deleted = new Map();
  let versionSeq = 0;
  const calls = [];
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bundle = (name, v) => ({ id: `https://${host}/secrets/${name}/${v.version}`, value: v.value, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
  const item = (name, v) => ({ id: `https://${host}/secrets/${name}`, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
  const page = (url, all) => {
    const skip = Number(url.searchParams.get('$skiptoken') || 0);
    const next = skip + 2 < all.length ? `https://${host}${url.pathname}?api-version=7.5&$skiptoken=${skip + 2}` : null;
    return { value: all.slice(skip, skip + 2), nextLink: next };
  };

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    calls.push(`${method} ${url.pathname}`);
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.get('api-version'), '7.5');
    assert.match(init.headers.Authorization, /^Bearer token-/);
    const parts = url.pathname.split('/').filter(Boolean);
    const [kind, name, version] = parts;
    if (kind === 'secrets' && !name && method === 'GET') {
      return json(200, page(url, [...secrets].map(([n, vs]) => item(n, vs.at(-1)))));
    }
    if (kind === 'secrets' && parts[2] === 'versions') {
      return json(200, page(url, (secrets.get(name) || []).map((v) => ({ ...item(name, v), id: `https://${host}/secrets/${name}/${v.version}` }))));
    }
    if (kind === 'secrets' && method === 'GET') {
      const vs = secrets.get(name);
      const v = vs && (version ? vs.find((x) => x.version === version) : vs.at(-1));
      return v ? json(200, bundle(name, v)) : json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
    }
    if (kind === 'secrets' && method === 'PUT') {
      if (deleted.has(name)) return json(409, { error: { code: 'Conflict', message: 'deleted' } });
      const body = JSON.parse(init.body);
      const now = Math.floor(Date.now() / 1000) + versionSeq;
      const v = { version: `v${++versionSeq}`, value: body.value, tags: body.tags, contentType: body.contentType, attributes: { enabled: true, created: now, updated: now } };
      secrets.set(name, [...(secrets.get(name) || []), v]);
      return json(200, bundle(name, v));
    }
    if (kind === 'secrets' && method === 'DELETE') {
      const vs = secrets.get(name);
      secrets.delete(name);
      deleted.set(name, vs);
      return json(200, { recoveryId: `https://${host}/deletedsecrets/${name}`, ...item(name, vs.at(-1)) });
    }
    if (kind === 'deletedsecrets' && method === 'GET') {
      return json(200, page(url, [...deleted].map(([n, vs]) => ({ recoveryId: `https://${host}/deletedsecrets/${n}`, ...item(n, vs.at(-1)), deletedDate: 1000, scheduledPurgeDate: 2000 }))));
    }
    if (kind === 'deletedsecrets' && parts[2] === 'recover') {
      secrets.set(name, deleted.get(name));
      deleted.delete(name);
      return json(200, {});
    }
    if (kind === 'deletedsecrets' && method === 'DELETE') {
      deleted.delete(name);
      return json(204);
    }
    return json(400, { error: { code: 'BadRequest', message: `${method} ${url.pathname}` } });
  }
  return { fetch, secrets, deleted, calls };
}

async function setup() {
  const kv = fakeKeyVault('kv-team.vault.azure.net');
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`,
    store: new MemoryStore(),
    fetch: kv.fetch,
    actor: () => 'alice@contoso.com',
  });
  await session.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return { kv, session };
}

test('container list from configuration', async () => {
  const { session } = await setup();
  const [c] = await session.containers();
  assert.equal(c.id, 'kv-team.vault.azure.net');
  assert.equal(c.name, 'Team');
  assert.deepEqual(c.sources, ['manual']);
});

test('create, list (paged), read, update with conflict check, delete, restore', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  for (const n of ['A', 'B', 'C']) await session.saveItem(cid, { title: n, username: `${n}@x`, password: 'pw', urls: [`${n.toLowerCase()}.example.com`] });
  kv.secrets.set('foreign-secret', [{ version: 'x', value: 'nope', tags: {}, attributes: { enabled: true, updated: 1 } }]);

  const index = await session.refreshIndex();
  assert.equal(index[cid].items.length, 3, 'foreign secrets are ignored, all pages are read');

  const [first] = (await session.summaries()).filter((s) => s.title === 'A');
  const item = await session.getItem(cid, first.id);
  assert.equal(item.password, 'pw');
  assert.equal(item.createdBy, 'alice@contoso.com');

  const updated = await session.saveItem(cid, { ...item, password: 'new' }, { expectedVersion: item.version });
  assert.notEqual(updated.version, item.version);
  await assert.rejects(session.saveItem(cid, { ...item, password: 'stale' }, { expectedVersion: item.version }), ConflictError);

  const history = await session.history(cid, item.id);
  assert.equal(history.length, 2);
  const old = await session.getVersion(cid, item.id, history[1].version);
  assert.equal(old.password, 'pw');

  assert.equal((await session.matchesForHost('login.a.example.com')).length, 1);
  assert.equal((await session.matchesForHost('evil.com')).length, 0);

  await session.deleteItem(cid, item.id);
  assert.equal((await session.summaries()).length, 2);
  const trash = await session.trash(cid);
  assert.equal(trash[0].title, 'A');
  await session.restore(cid, item.id);
  assert.equal((await session.summaries()).length, 3);
});

test('passkeys are found by RP ID and allowCredentials', async () => {
  const { session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  const { passkey } = await createCredential({
    origin: 'https://example.com', rpId: 'example.com', user: { id: 'dXNlcg', name: 'alice' }, challenge: 'AAAA',
  });
  await session.saveItem(cid, { title: 'Example', username: 'alice', urls: ['https://example.com'], passkeys: [passkey] });
  await session.refreshIndex();
  const found = await session.passkeyCandidates('example.com');
  assert.equal(found.length, 1);
  assert.equal(found[0].passkey.privateKey, passkey.privateKey);
  assert.equal((await session.passkeyCandidates('example.com', ['AAAA'])).length, 0);
  assert.equal((await session.passkeyCandidates('other.com')).length, 0);
});

test('extra protection: entries and tags encrypted, lock/unlock with password, disable again', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  await session.saveItem(cid, { title: 'Firewall', username: 'admin', password: 'fw-secret', urls: ['fw.example.com'] });
  await session.saveItem(cid, { title: 'Router', password: 'r-secret' });
  const r = await session.enableProtection(cid, { password: 'master-password-1' });
  assert.match(r.recoveryKey, /^RK-/);
  assert.equal(r.migrated, 2);

  const raw = JSON.stringify([...kv.secrets].map(([n, vs]) => [n, vs.at(-1)]));
  assert.equal(raw.includes('Firewall') || raw.includes('fw-secret') || raw.includes('admin') || raw.includes('fw.example.com'), false, 'nothing readable in Key Vault');
  assert.ok(kv.secrets.has('pws-keyring'));
  assert.equal(kv.deleted.size, 0, 'old plaintext secrets purged');

  let list = await session.summaries({ maxAgeMs: 0 });
  assert.deepEqual(list.map((s) => s.title).sort(), ['Firewall', 'Router']);
  assert.deepEqual(list.find((s) => s.title === 'Firewall').hosts, ['fw.example.com']);
  const fw = await session.getItem(cid, list.find((s) => s.title === 'Firewall').id, { fresh: true });
  assert.equal(fw.password, 'fw-secret');

  await session.lockContainer(cid);
  assert.equal((await session.container(cid)).locked, true);
  assert.equal((await session.summaries({ maxAgeMs: 0 })).length, 0);
  await assert.rejects(session.getItem(cid, fw.id, { fresh: true }), { name: 'ContainerLockedError' });
  await assert.rejects(session.unlockContainer(cid, { password: 'wrong-password' }), { name: 'UnlockError' });
  const via = await session.unlockContainer(cid, { code: r.recoveryKey });
  assert.equal(via.via, 'recovery');
  list = await session.summaries({ maxAgeMs: 0 });
  assert.equal(list.length, 2);

  // New entries are encrypted too, and the protection can be removed again.
  await session.saveItem(cid, { title: 'Neu', password: 'n' });
  const info = await session.protectionInfo(cid, 'localhost');
  assert.equal(info.protected, true);
  assert.equal(info.methods.password, true);
  const invite = await session.updateProtection(cid, { type: 'createInvite', label: 'Kim' });
  assert.match(invite.inviteCode, /^IN-/);
  const d = await session.disableProtection(cid);
  assert.deepEqual(d.failed, []);
  assert.equal(kv.secrets.has('pws-keyring'), false);
  const plain = JSON.stringify([...kv.secrets].map(([, vs]) => vs.at(-1).tags));
  assert.ok(plain.includes('Firewall') && plain.includes('Neu'));
  assert.equal((await session.summaries({ maxAgeMs: 0 })).length, 3);
});

test('move between containers', async () => {
  const kvA = fakeKeyVault('kv-a.vault.azure.net');
  const kvB = fakeKeyVault('kv-b.vault.azure.net');
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`,
    store: new MemoryStore(),
    fetch: (input, init) => (new URL(input).hostname.startsWith('kv-a') ? kvA : kvB).fetch(input, init),
    actor: () => 'bob@contoso.com',
  });
  await session.refreshContainers({ configured: [{ name: 'A', vaultUrl: 'kv-a' }, { name: 'B', vaultUrl: 'kv-b' }], discover: false });
  const saved = await session.saveItem('kv-a.vault.azure.net', { title: 'Moved', password: 'x' });
  await session.moveItem('kv-a.vault.azure.net', 'kv-b.vault.azure.net', saved.id);
  // Entries only – pws-container (vault marker) is not an entry.
  const entries = (kv) => [...kv.secrets.keys()].filter((n) => n !== 'pws-container').length;
  assert.equal(entries(kvA), 0);
  assert.equal(kvA.deleted.size, 1);
  assert.equal(entries(kvB), 1);
});

test('folders of a Key Vault container: plain, then encrypted once protected; not listed as entries', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  await session.addFolder(cid, ' Kunden / Contoso ');
  await session.addFolder(cid, 'Kunden/Fabrikam');
  assert.deepEqual(await session.folders(cid), ['Kunden/Contoso', 'Kunden/Fabrikam']);
  const index = await session.refreshIndex();
  assert.equal(index[cid].items.length, 0, 'the folder secret is not an entry');
  await session.enableProtection(cid, { password: 'master-password-1' });
  await session.addFolder(cid, 'Intern');
  assert.equal(kv.secrets.get('pws-folders').at(-1).value.includes('Intern'), false, 'folder names are encrypted when protected');
  await session.removeFolder(cid, 'Kunden');
  assert.deepEqual(await session.folders(cid), ['Intern']);
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('entry icons and container logo in Key Vault (plain, then sealed when protected)', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  const saved = await session.saveItem(cid, { title: 'Contoso', icon: PNG });
  assert.equal((await session.getItem(cid, saved.id, { fresh: true })).icon, PNG);
  const summary = (await session.summaries({ maxAgeMs: 0 })).find((s) => s.id === saved.id);
  assert.equal(summary.hasIcon, true, 'list knows that an icon exists without loading values');
  const svg = await session.saveItem(cid, { title: 'Bad', icon: 'data:image/svg+xml;base64,PHN2Zz4=' });
  assert.equal(svg.icon, '', 'SVG and other non-raster data is dropped');

  assert.equal(await session.containerLogo(cid), null);
  await session.setContainerLogo(cid, PNG);
  assert.equal(await session.containerLogo(cid), PNG);
  await session.enableProtection(cid, { password: 'master-password-1' });
  await session.setContainerLogo(cid, PNG);
  assert.equal(kv.secrets.get('pws-container').at(-1).value.includes('iVBOR'), false, 'logo encrypted when protected');
  assert.equal(JSON.parse(kv.secrets.get('pws-container').at(-1).value).format, 'kvpwsafe-container', 'vault marked as container');
  assert.equal(await session.containerLogo(cid), PNG);
  await session.setContainerLogo(cid, null);
  assert.equal(await session.containerLogo(cid), null);
  assert.equal((await session.refreshIndex())[cid].items.length, 2, 'logo secret is not an entry');
});

test('duplicate: copy in the same container, new id, "(Kopie)", without passkeys', async () => {
  const { session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  const pk = { credentialId: 'cred-1', rpId: 'example.com', userHandle: 'dQ', userName: 'u', privateKey: 'k', publicKey: 'p', signCount: 0, created: '' };
  const item = await session.saveItem(cid, { title: 'Router', username: 'admin', password: 'pw', folder: 'Netz', passkeys: [pk] });
  const copy = await session.duplicateItem(cid, item.id);
  assert.notEqual(copy.id, item.id);
  assert.equal(copy.title, 'Router (Kopie)');
  assert.equal(copy.password, 'pw');
  assert.equal(copy.folder, 'Netz');
  assert.equal(copy.passkeys.length, 0);
  assert.equal((await session.summaries()).length, 2);
});

test('backup: encrypted file, wrong password rejected, restore brings back deleted and changed entries', async () => {
  const { createBackup, openBackup, generateBackupPassword, readBackupHeader, BackupPasswordError } = await import('../extension/core/backup.js');
  const kvA = fakeKeyVault('kv-a.vault.azure.net');
  const kvB = fakeKeyVault('kv-b.vault.azure.net');
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`,
    store: new MemoryStore(),
    fetch: (input, init) => (new URL(input).hostname.startsWith('kv-a') ? kvA : kvB).fetch(input, init),
    actor: () => 'owner@contoso.com',
  });
  await session.refreshContainers({ configured: [{ name: 'A', vaultUrl: 'kv-a' }, { name: 'B', vaultUrl: 'kv-b' }], discover: false });
  const a = 'kv-a.vault.azure.net';
  const one = await session.saveItem(a, { title: 'One', password: 'pw1' });
  const two = await session.saveItem(a, { title: 'Two', password: 'pw2' });

  const data = await session.backupSecrets(a);
  assert.equal(data.vault, a);
  assert.equal(data.isProtected, false);
  const password = generateBackupPassword();
  assert.match(password, /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
  const file = await createBackup({ ...data, password, createdBy: 'owner@contoso.com', iterations: 1000 });
  assert.ok(!file.includes('pw1'), 'secrets are not readable in the file');
  assert.equal(readBackupHeader(file).count, data.secrets.length);
  await assert.rejects(openBackup(file, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA'), BackupPasswordError);
  const tampered = JSON.stringify({ ...JSON.parse(file), vault: 'kv-x.vault.azure.net' });
  await assert.rejects(openBackup(tampered, password), BackupPasswordError, 'header is authenticated');
  const opened = await openBackup(file, password.toLowerCase().replace(/-/g, ' '));

  // Same vault: one deleted (soft delete), one changed → both come back with the backup state.
  await session.deleteItem(a, one.id);
  const current = await session.getItem(a, two.id);
  await session.saveItem(a, { ...current, password: 'changed' }, { expectedVersion: current.version });
  const r = await session.restoreSecrets(a, { vault: opened.header.vault, secrets: opened.secrets, isProtected: opened.header.protected });
  assert.equal(r.failed.length, 0);
  assert.equal(r.recovered, 1);
  assert.equal(r.restored, 2);
  assert.equal((await session.getItem(a, one.id, { fresh: true })).password, 'pw1');
  assert.equal((await session.getItem(a, two.id, { fresh: true })).password, 'pw2');
  assert.equal((await session.history(a, two.id)).length, 3, 'changed state stays in the history');

  // Another vault: entries copied, the target keeps its own marker.
  const markerB = kvB.secrets.get('pws-container')?.at(-1)?.value;
  const rb = await session.restoreSecrets('kv-b.vault.azure.net', { vault: a, secrets: opened.secrets, isProtected: false });
  assert.equal(rb.failed.length, 0);
  assert.equal(kvB.secrets.get('pws-container')?.at(-1)?.value, markerB);
  assert.equal((await session.summaries()).filter((s) => s.containerId === 'kv-b.vault.azure.net').length, 2);
  await assert.rejects(session.restoreSecrets('kv-b.vault.azure.net', { vault: a, secrets: opened.secrets, isProtected: true }), /denselben Key Vault/);
});

test('credit card and certificate entries: stored completely, lists show only last digits / file name', async () => {
  const { kv, session } = await setup();
  const cid = 'kv-team.vault.azure.net';
  const card = await session.saveItem(cid, { type: 'card', title: 'Firmen-Visa', card: { holder: 'Kim Muster', number: '4111 1111-1111 1111', expiry: '12/28', cvc: '123', pin: '9876' } });
  const pfx = Buffer.alloc(3000, 7).toString('base64');
  const cert = await session.saveItem(cid, { type: 'certificate', title: 'VPN', password: 'geheim', cert: { fileName: 'vpn.pfx', data: pfx } });
  const readCard = await session.getItem(cid, card.id, { fresh: true });
  assert.deepEqual(readCard.card, { holder: 'Kim Muster', number: '4111111111111111', expiry: '12/28', cvc: '123', pin: '9876' });
  const readCert = await session.getItem(cid, cert.id, { fresh: true });
  assert.equal(readCert.cert.data, pfx);
  assert.equal(readCert.cert.size, 3000);
  assert.equal(readCert.password, 'geheim');
  const summaries = await session.summaries();
  assert.equal(summaries.find((s) => s.id === card.id).username, '•••• 1111');
  assert.equal(summaries.find((s) => s.id === cert.id).username, 'vpn.pfx');
  const tags = kv.secrets.get(card.id).at(-1).tags;
  assert.ok(!JSON.stringify(tags).includes('4111111111111111'), 'full card number never in tags');
  // A certificate that does not fit into one Key Vault secret is refused.
  await assert.rejects(session.saveItem(cid, { type: 'certificate', title: 'Zu groß', cert: { fileName: 'big.pfx', data: Buffer.alloc(20000, 1).toString('base64') } }), /zu groß/);
});
