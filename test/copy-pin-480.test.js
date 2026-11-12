// #480: a vault whose settings want the app PIN for copying – the gate in the main process (desktop/copy-pin.js) and the
// main-process wiring (source checks: copy, export, "Nur für mich", bridge, MCP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { hashPin, PinGuard } from '../desktop/pin.js';
import { CopyPinGate, COPY_PIN_TTL_MS } from '../desktop/copy-pin.js';

async function gate(settings = {}) {
  const s = { appPin: await hashPin('2580'), ...settings };
  const guard = new PinGuard();
  let clock = 1_000_000;
  const g = new CopyPinGate({ settings: () => s, guard, save: () => {}, now: () => clock });
  return { gate: g, guard, s, tick: (ms) => { clock += ms; } };
}
const refused = (fn, name) => assert.throws(fn, (e) => e.name === name);

test('copy PIN: without confirmation no copy; a wrong PIN counts like the other PIN prompts', async () => {
  const { gate: g, guard } = await gate();
  refused(() => g.require('kv-a'), 'CopyPinRequired');
  await assert.rejects(g.confirm('kv-a', '0000'), (e) => e.name === 'PinWrong');
  assert.equal(guard.failures, 1);
  refused(() => g.require('kv-a'), 'CopyPinRequired');
});

test('copy PIN: a confirmation holds for one vault and a minute, locking ends it', async () => {
  const { gate: g, tick } = await gate();
  assert.equal(await g.confirm('kv-a', '2580'), true);
  g.require('kv-a');
  g.require('kv-a'); // user name and password in a row
  refused(() => g.require('kv-b'), 'CopyPinRequired');
  tick(COPY_PIN_TTL_MS);
  refused(() => g.require('kv-a'), 'CopyPinRequired');
  await g.confirm('kv-a', '2580');
  g.clear();
  refused(() => g.require('kv-a'), 'CopyPinRequired');
});

test('copy PIN: no app PIN set – the vault demands one, whatever the personal setting', async () => {
  const { gate: g } = await gate({ appPin: null });
  refused(() => g.require('kv-a'), 'AppPinMissing');
  await assert.rejects(g.confirm('kv-a', '2580'), (e) => e.name === 'AppPinMissing');
});

test('main process: copy, export, "Nur für mich", bridge and saves go through the vault rules', () => {
  const src = (p) => readFileSync(new URL(`../desktop/${p}`, import.meta.url), 'utf8');
  const items = src('main/api/items.js');
  assert.match(items, /async copy\(text, containerId\) \{\s*await checkCopy\(/);
  assert.match(items, /exportPin\.consume\(containerId, pinToken\);\n\s*await checkExport\(containerId\);/);
  assert.match(items, /await checkRequired\(containerId, item\)/);
  assert.match(items, /item: async [^\n]*noteServed\(/);
  const bridge = src('main/browser.js');
  assert.match(bridge, /await checkCopy\(text\)/);
  assert.match(bridge, /noteServed\(containerId, await vault\.getItem/);
  assert.match(bridge, /await checkRequired\(containerId, item\)/);
  assert.match(src('main/private.js'), /if \(on && \(await readVaultSettings\(vault, containerId\)\)\.protect\.private === 'forbid'\) throw[^\n]*\n\s*if \(!config\.get\(\)\.adminTools\)/);
  assert.match(src('main/session.js'), /clearCopyRules\(\)/);
  assert.match(src('mcp.js'), /requireFields\([^\n]*readVaultSettings\(v, c\)\)[^\n]*\n\s*const ok = await this\.confirmWrite/);
});

test('review 0.9.33: the copy PIN also covers TOTP codes; the export lock holds through the personal vault', async () => {
  const { totpMatches, totpCode } = await import('../extension/core/totp.js');
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = Date.now();
  const { code } = await totpCode(secret, now);
  assert.equal(await totpMatches(secret, code, now), true);
  assert.equal(await totpMatches(secret, (await totpCode(secret, now - 30_000)).code, now), true, 'the previous period still counts');
  assert.equal(await totpMatches(secret, (await totpCode(secret, now - 120_000)).code === code ? 'x' : (await totpCode(secret, now - 120_000)).code, now), false);
  assert.equal(await totpMatches('kein base32 !', '123456', now), false);
  const src = (p) => readFileSync(new URL(`../desktop/${p}`, import.meta.url), 'utf8');
  const rules = src('main/vault-rules.js');
  assert.match(rules, /if \(item\.totp && item\.id\) \{/, 'noteServed notes entries with a TOTP');
  assert.match(rules, /served\.get\(digest\(text\)\), \.\.\.\(await totpVaults\(String\(text\)\)\)/, 'checkCopy compares TOTP codes');
  assert.match(rules, /servedTotp\.clear\(\)/);
  assert.match(rules, /if \(rules\?\.protect\.noExport\) throw/);
  const items = src('main/api/items.js');
  assert.match(items, /move: async \(fromId, toId, id, opts\) => \{\n\s*await checkLeaveToPersonal\(fromId, toId\);/);
  assert.match(items, /planMove: async \(fromId, toId, id\) => \{\n\s*await checkLeaveToPersonal\(fromId, toId\);/);
  assert.match(items, /moveWithAssets: async \(fromId, toId, id, opts\) => \{\n\s*await checkLeaveToPersonal\(fromId, toId\);/);
  assert.match(src('main/browser.js'), /checkMove: checkLeaveToPersonal/);
  // The decisions stay in the private repo; the public export has no copy (#524).
  if (existsSync(new URL('../docs/ENTSCHEIDUNGEN.md', import.meta.url))) assert.match(readFileSync(new URL('../docs/ENTSCHEIDUNGEN.md', import.meta.url), 'utf8'), /Export-Sperre[^\n]*persönlichen Tresor/);
});
