// #500: "Passwörter älter als X Monate" counts only a real password change. The date is stamped on every save that changes
// the password – window, extension, MCP or a restored version – and an edit of the title or notes keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { stampPasswordChange } from '../extension/core/model.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const CID = 'kv-team.vault.azure.net';
const NOW = '2026-11-10T09:00:00.000Z';

async function member(kv, who = 'alice@contoso.com') {
  const s = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => who, viewer: () => `oid-${who}` });
  await s.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return s;
}

test('stampPasswordChange: new password → now, same password → stored date, a date from the input never counts', () => {
  const stored = { password: 'alt', passwordChanged: '2025-01-01T00:00:00.000Z' };
  assert.equal(stampPasswordChange({ password: 'neu' }, stored, NOW), NOW);
  assert.equal(stampPasswordChange({ password: 'neu', passwordChanged: '2020-01-01T00:00:00.000Z' }, stored, NOW), NOW, 'a new password is always now');
  assert.equal(stampPasswordChange({ password: 'alt', passwordChanged: '' }, stored, NOW), stored.passwordChanged);
  assert.equal(stampPasswordChange({ password: 'alt', passwordChanged: '2030-01-01T00:00:00.000Z' }, stored, NOW), stored.passwordChanged, 'the stored date wins over one sent along');
  assert.equal(stampPasswordChange({ password: 'alt', passwordChanged: '2026-11-09T00:00:00.000Z' }, { password: 'alt', passwordChanged: '' }, NOW), '', 'no stored date: none from the input either');
  // Review 0.9.33: a new entry and an unreadable stored entry take no date from the input.
  assert.equal(stampPasswordChange({ password: 'x', passwordChanged: '2020-01-01T00:00:00.000Z' }, null, NOW), NOW, 'a new entry with a password: now');
  assert.equal(stampPasswordChange({ password: '', passwordChanged: '2026-11-01T00:00:00.000Z' }, null, NOW), '', 'a new entry without a password: no date');
  assert.equal(stampPasswordChange({ password: 'x', passwordChanged: '2026-11-01T00:00:00.000Z' }, { password: null, passwordChanged: '2025-01-01T00:00:00.000Z' }, NOW), '2025-01-01T00:00:00.000Z', 'stored entry unreadable: the stored date stays');
  assert.equal(stampPasswordChange({ password: 'x', passwordChanged: 'p' }, { password: null }, NOW), '', 'stored entry unreadable: nothing is claimed');
  assert.equal(stampPasswordChange({ password: '' }, { password: 'alt' }, NOW), NOW, 'removing the password is a change');
  // Implausible stored dates are dropped: in the future, before 2000, not a date.
  for (const bad of ['2027-01-01T00:00:00.000Z', '1999-12-31T00:00:00.000Z', 'p', '']) {
    assert.equal(stampPasswordChange({ password: 'alt' }, { password: 'alt', passwordChanged: bad }, NOW), '', `kept "${bad}"`);
  }
  assert.equal(stampPasswordChange({ password: 'alt' }, { password: 'alt', passwordChanged: '2026-11-10T09:02:00Z' }, NOW), '2026-11-10T09:02:00.000Z', 'a few minutes of clock skew are fine');
});

test('file vault: a new entry and a password change stamp now; a date sent along is ignored', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FileContainers } = await import('../desktop/files.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-pwchanged-'));
  let paths = [];
  const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
  try {
    const { id } = await containers.create(path.join(dir, 'T.kvpws'), 'T', { password: 'Smoke-Pass-1234' }, 'me');
    const old = '2020-01-01T00:00:00.000Z';
    const before = Date.now();
    const a = await containers.saveItem(id, { type: 'login', title: 'A', password: 'p1', passwordChanged: old });
    assert.ok(Date.parse(a.passwordChanged) >= before - 1000, `new entry stamped now: ${a.passwordChanged}`);
    const b = await containers.saveItem(id, { ...a, notes: 'x', passwordChanged: old });
    assert.equal(b.passwordChanged, a.passwordChanged, 'a notes edit keeps the stored date, not the one sent');
    const c = await containers.saveItem(id, { ...b, password: 'p2', passwordChanged: old });
    assert.ok(Date.parse(c.passwordChanged) >= Date.parse(a.passwordChanged), `changed password stamped now: ${c.passwordChanged}`);
  } finally {
    containers.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session: a save without the window (e.g. MCP) stamps a changed password; a notes edit does not', async () => {
  const kv = fakeKeyVault(CID);
  const s = await member(kv);
  const created = Date.now();
  const e = await s.saveItem(CID, { title: 'Firewall', password: 'fw-1', passwordChanged: '2020-01-01T00:00:00.000Z' });
  const first = await s.getItem(CID, e.id, { fresh: true });
  assert.ok(Date.parse(first.passwordChanged) >= created - 1000, `a new password is stamped now, never the date sent along: ${first.passwordChanged}`);
  await s.saveItem(CID, { ...first, notes: 'nur Notiz', passwordChanged: '2020-01-01T00:00:00.000Z' });
  assert.equal((await s.getItem(CID, e.id, { fresh: true })).passwordChanged, first.passwordChanged, 'editing the notes is no password change');
  const before = Date.now();
  await s.saveItem(CID, { ...(await s.getItem(CID, e.id, { fresh: true })), password: 'fw-2', passwordChanged: '' });
  const changed = await s.getItem(CID, e.id, { fresh: true });
  assert.ok(Date.parse(changed.passwordChanged) >= before - 1000, `stamped: ${changed.passwordChanged}`);
  await s.saveItem(CID, { ...changed, title: 'Firewall neu', passwordChanged: '' });
  assert.equal((await s.getItem(CID, e.id, { fresh: true })).passwordChanged, changed.passwordChanged, 'a later title edit keeps the date');
});
