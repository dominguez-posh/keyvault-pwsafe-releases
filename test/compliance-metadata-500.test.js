// #500 review (0.9.33): opening the compliance view reads no secret value – each read would count in the read alert of
// #486. The age of the passwords comes from the tag pc of the listing; older entries are estimated from their versions,
// and reading them is only done when asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { passwordChangedTag, serializeItem } from '../extension/core/model.js';
import { entryMetadata } from '../extension/core/compliance-entries.js';
import { entryRow, olderThan } from '../extension/core/compliance.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const CID = 'kv-team.vault.azure.net';

async function member(kv) {
  const s = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => 'alice@contoso.com', viewer: () => 'oid-alice' });
  await s.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return s;
}

test('serializeItem: the tag pc carries the password change (seconds), "c…" from the creation, none without a password', () => {
  const at = '2026-03-01T10:00:00.000Z';
  assert.deepEqual(passwordChangedTag(serializeItem({ title: 'A', password: 'x', passwordChanged: at }).tags), { at: Date.parse(at), source: 'password' });
  assert.deepEqual(passwordChangedTag(serializeItem({ title: 'B', password: 'x', created: at }).tags), { at: Date.parse(at), source: 'created' });
  assert.equal(serializeItem({ title: 'C', password: '' }).tags.pc, undefined);
  assert.equal(serializeItem({ type: 'note', title: 'N', notes: 'n' }).tags.pc, undefined);
  assert.equal(passwordChangedTag({ pc: 'evil' }), null);
  // Key Vault allows 15 tags: pc is left out rather than breaking the save.
  const full = serializeItem({ title: 'F', username: 'u', password: 'x', urls: ['https://a.example'], totp: 'JBSWY3DPEHPK3PXP', folder: 'X', favorite: true,
    icon: 'data:image/png;base64,iVBORw0KGgo=', expires: '2030-01-01', msAdmin: true, sophos: true, loginLink: 'pws-1', privateOwner: 'oid', passkeys: [{ rpId: 'a.example', credentialId: 'c', privateKey: 'k', userHandle: 'h' }] }).tags;
  assert.ok(Object.keys(full).length <= 15, `${Object.keys(full).length} tags`);
});

test('compliance metadata: no secret value read; old entries estimated from the oldest version', async () => {
  const kv = fakeKeyVault(CID);
  const s = await member(kv);
  const a = await s.saveItem(CID, { title: 'Firewall', password: 'fw-1' });
  await s.saveItem(CID, { type: 'note', title: 'Notiz', notes: 'n' });
  // An entry saved by an older version: no pc tag.
  const old = serializeItem({ title: 'Alt', password: 'p' });
  delete old.tags.pc;
  await s.kv(await s.container(CID)).setSecret('pws-alt', old.value, { contentType: old.contentType, tags: old.tags });

  kv.calls.length = 0;
  const meta = await entryMetadata(s, CID);
  const reads = kv.calls.filter((c) => /^GET \/secrets\/[^/]+\/?$/.test(c) || /^GET \/secrets\/[^/]+\/v/.test(c) && !c.endsWith('/versions'));
  assert.deepEqual(reads, [], `secret values read: ${reads.join(', ')}`);
  assert.ok(kv.calls.includes('GET /secrets/pws-alt/versions'), 'the old entry is estimated from its versions');
  assert.ok(!kv.calls.includes(`GET /secrets/${a.id}/versions`), 'an entry with the tag needs no version list');

  const by = Object.fromEntries(meta.entries.map((e) => [e.summary.title, e]));
  assert.equal(by.Firewall.estimated, false);
  assert.ok(Date.parse(by.Firewall.passwordChanged) > Date.now() - 60_000);
  assert.equal(by.Notiz.hasPassword, false);
  assert.equal(by.Alt.estimated, true);
  assert.ok(by.Alt.oldestVersion > 0);
  const rows = meta.entries.map((e) => entryRow({ ...e.summary, hasPassword: e.hasPassword, passwordChanged: e.passwordChanged, created: e.created, estimated: e.estimated }, { oldestVersion: e.oldestVersion }));
  const row = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.equal(row.Firewall.source, 'password');
  assert.equal(row.Alt.source, 'version');
  assert.equal(row.Alt.estimated, true);
  assert.equal(row.Notiz.hasPassword, false);
  assert.equal(olderThan(rows, 1, Date.now() + 40 * 86_400_000).length, 2, 'both passwords count as older than a month 40 days later');
});

test('compliance API: opens from metadata; reading all entries only on request', async () => {
  const { readFile } = await import('node:fs/promises');
  const api = await readFile(new URL('../desktop/main/api/compliance.js', import.meta.url), 'utf8');
  assert.match(api, /entryMetadata\(vault, c\.id/);
  assert.match(api, /readAll && e\.estimated/);
  const ui = await readFile(new URL('../desktop/renderer/app/compliance.js', import.meta.url), 'utf8');
  assert.match(ui, /liest alle diese Einträge, kann eine Warnung auslösen/);
  assert.match(ui, /call\('complianceEntries', c\.id, \{ readAll \}\)/);
});
