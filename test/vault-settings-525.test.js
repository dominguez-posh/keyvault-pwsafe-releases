// #525: the export lock must not open by failing. Settings that can't be read (network error) refuse the export and the
// move into the personal vault instead of answering with stored or default settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readVaultSettings, storedVaultSettings, writeVaultSettings } from '../extension/core/vault-settings.js';
import { setLanguage } from '../extension/core/i18n.js';
import { setup } from './fixtures/fake-keyvault.js';

async function withAccess(access) {
  const s = await setup();
  const stored = await s.session.store.get('containers');
  stored[0].access = access;
  await s.session.store.set('containers', stored);
  return s;
}

const cid = 'kv-team.vault.azure.net';
const MANAGER = { read: true, write: true, manage: true, admin: false };
const offline = (session) => {
  const real = session.readContainerMeta;
  session.readContainerMeta = async () => { throw new TypeError('fetch failed'); };
  session.vaultSettingsCache?.clear();
  return () => { session.readContainerMeta = real; };
};
const unknown = (e) => e.name === 'VaultSettingsUnknown' && /nicht lesen/.test(e.message) && e.message.includes('„Team“');

test('#525: a read error with nothing stored refuses a strict read (it gave the defaults: export open)', async () => {
  const { session } = await withAccess(MANAGER);
  offline(session);
  assert.deepEqual(await storedVaultSettings(session), {}, 'nothing stored for the vault');
  await assert.rejects(readVaultSettings(session, cid, { strict: true }), unknown);
  await assert.rejects(readVaultSettings(session, cid, { strict: true, fresh: true }), unknown);
});

test('#525: stored settings without the lock are not an answer either – the lock may have been set since', async () => {
  const { session } = await withAccess(MANAGER);
  await writeVaultSettings(session, cid, { look: { color: 'green' } });
  assert.equal((await storedVaultSettings(session))[cid].protect.noExport, false);
  const back = offline(session);
  await assert.rejects(readVaultSettings(session, cid, { strict: true }), unknown);
  assert.equal((await readVaultSettings(session, cid)).look.color, 'green', 'without strict the stored ones still show (look, contact)');
  back();
  assert.equal((await readVaultSettings(session, cid, { strict: true })).protect.noExport, false, 'readable again: the real answer');
});

test('#525: a readable vault answers a strict read as before – with settings, without any, and for other vault kinds', async () => {
  const { session } = await withAccess(MANAGER);
  assert.equal((await readVaultSettings(session, cid, { strict: true })).protect.noExport, false, 'no settings in the vault: the defaults');
  await writeVaultSettings(session, cid, { protect: { noExport: true } });
  assert.equal((await readVaultSettings(session, cid, { strict: true })).protect.noExport, true);
  assert.equal((await readVaultSettings(session, { kind: 'file', id: 'f1' }, { strict: true })).protect.noExport, false);
});

test('#525: the message is there in English', async () => {
  const { session } = await withAccess(MANAGER);
  offline(session);
  setLanguage('en');
  try {
    await assert.rejects(readVaultSettings(session, cid, { strict: true }), /cannot be read right now.*stay locked/);
  } finally {
    setLanguage('de');
  }
});

test('#525: export and every move into the personal vault decide on a strict read', () => {
  const rules = readFileSync(new URL('../desktop/main/vault-rules.js', import.meta.url), 'utf8');
  assert.match(rules, /strictRulesOf = \(containerId\) => readVaultSettings\(vault, containerId, \{ strict: true \}\)/);
  assert.match(rules, /export async function checkExport\(containerId\) \{\n\s*const \{ protect \} = await strictRulesOf\(containerId\);/);
  assert.match(rules, /const rules = await strictRulesOf\(fromId\);[^\n]*\n\s*if \(rules\?\.protect\.noExport\) throw/);
  assert.doesNotMatch(rules, /strictRulesOf\([^)]*\)\.catch/, 'no catch turns the refusal back into "open"');
  // The callers: CSV export, move / plan / move with assets / passkey move in the window, and the bridge (extension).
  const items = readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  assert.match(items, /await checkExport\(containerId\);/);
  assert.equal((items.match(/await checkLeaveToPersonal\(/g) || []).length, 4);
  assert.match(readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8'), /checkMove: checkLeaveToPersonal/);
  const bridge = readFileSync(new URL('../desktop/browser-items.js', import.meta.url), 'utf8');
  assert.ok((bridge.match(/await checkMove\(/g) || []).length >= 2, 'bridge: plan and move ask the app rules');
});
