// #511 review of #478 (Konrad): a look-alike vault name that differs only in invisible or compatibility characters
// still counts as the same name, and while the vault search still runs (first start) no new vault is ticked in advance
// and hidden vaults are not taken over – the preview says to import again shortly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importPlan, newVaultsOf } from '../desktop/settings-file.js';

const src = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('#511: names that only look different to the machine are the same name (NFKC, no format characters, no white space)', () => {
  const current = { containers: [{ name: 'Team Finanzen', vaultUrl: 'https://kv-team.vault.azure.net/' }] };
  const looks = [
    'Team​Finanzen', // zero-width space
    'Team Fi⁠nanzen', // word joiner
    '‮Team Finanzen', // right-to-left override
    'Ｔｅａｍ Ｆｉｎａｎｚｅｎ', // full-width letters
    'Team Finanzen', // no-break space
    'Team　Finanzen', // ideographic space
    'TeamFinanzen', // the space left out
    ' team  finanzen\t', // case and extra white space
    '﻿Team Finanzen', // byte order mark
  ];
  const file = { containers: [
    ...looks.map((name, i) => ({ name, vaultUrl: `https://kv-look${i}.vault.azure.net/` })),
    { name: 'Team Finanzen 2', vaultUrl: 'https://kv-other.vault.azure.net/' },
    { name: '​ ‍', vaultUrl: 'https://kv-team.vault.azure.net.example/' }, // nothing visible: shown as its host
  ] };
  const list = newVaultsOf(file, current);
  for (let i = 0; i < looks.length; i++) assert.equal(list.find((c) => c.id === `kv-look${i}.vault.azure.net`)?.clash, true, `${JSON.stringify(looks[i])} marked as look-alike`);
  assert.equal(list.find((c) => c.id === 'kv-other.vault.azure.net').clash, false, 'another name is no look-alike');
  // A name of nothing visible counts as none: compared by its host, which is "kv-team" like the user's vault host.
  assert.equal(list.find((c) => c.id === 'kv-team.vault.azure.net.example').clash, false);
  const hostClash = newVaultsOf({ containers: [{ name: '​', vaultUrl: 'https://teamfinanzen.vault.azure.net/' }] }, current);
  assert.equal(hostClash[0].clash, true, 'an invisible name falls back to the host, which is compared the same way');
  // Known vaults by name (file vaults, discovered Key Vaults) are compared the same way.
  const known = newVaultsOf({ containers: [{ name: 'Ｐｒｉｖａｔ', vaultUrl: 'https://kv-p.vault.azure.net/' }] }, {}, { knownIds: [{ id: 'f-1', name: 'pri​vat' }] });
  assert.equal(known[0].clash, true);
});

test('#511: while the vault search runs, hidden vaults are not taken over', () => {
  const current = { containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }], hiddenContainers: [] };
  // kv-mine is the user's, but not found yet: the list does not know it.
  const file = { hiddenContainers: ['kv-mine.vault.azure.net'], theme: 'dark' };
  const done = importPlan(file, current, { knownIds: [] });
  assert.deepEqual(done.take.hiddenContainers, ['kv-mine.vault.azure.net'], 'search through: a vault the user does not have may be hidden (as before)');
  const running = importPlan(file, current, { knownIds: [], complete: false });
  assert.ok(!Object.hasOwn(running.take, 'hiddenContainers'), 'search running: nothing hidden');
  assert.ok(running.refused.includes('hiddenContainers'));
  assert.equal(running.take.theme, 'dark', 'other settings are taken as usual');
});

test('#511: the preview knows the search is running; the window ticks nothing then and says to import again', () => {
  const copy = src('desktop/main/settings-copy.js');
  const offer = copy.slice(copy.indexOf('async function offer('), copy.indexOf('export async function settingsCopyStatus'));
  assert.match(offer, /const complete = vaultListComplete\(\);\s*const known = await knownIds\(\);/, 'state read before the list');
  assert.match(offer, /importPlan\(read\.settings, config\.get\(\), \{ knownIds: known, complete \}\)/);
  assert.match(offer, /discovering: !complete/);
  const take = copy.slice(copy.indexOf('export async function takeImport('), copy.indexOf('export function exportContent'));
  assert.match(take, /const complete = vaultListComplete\(\);\s*const patch = importPlan\(settings, [^\n]*, complete \}\)\.take;/, 'applying checks again');
  const win = src('desktop/renderer/app/settings-file.js');
  assert.match(win, /checked: !c\.clash && !preview\.discovering/);
  assert.match(win, /preview\.discovering \? h\('p', \{[^}]*dataset: \{ discovering: '1' \} \}, t\('Tresorsuche läuft noch – bitte gleich erneut importieren'\)\)/);
  assert.match(src('extension/core/i18n-en.js'), /'Tresorsuche läuft noch – bitte gleich erneut importieren': '/);
});

test('#511: a refresh counts as a running search until all tenants are through, also when it fails', () => {
  const s = src('desktop/main/session.js');
  const refresh = s.slice(s.indexOf('export async function refreshAll('), s.indexOf('let vaultListRuns'));
  assert.match(refresh, /const listed = vaultListRun\(\);\s*try \{/);
  assert.match(refresh, /if \(!quick\) listed\(\);/, 'full refresh: through once the list is');
  assert.match(refresh, /completeInBackground\(vault, quick \? options : null, listed\);/, 'quick refresh: through after the background search');
  assert.match(refresh, /catch \(e\) \{\s*listed\(\);\s*throw e;/);
  const bg = s.slice(s.indexOf('function completeInBackground('), s.indexOf('// Vaults without a resource ID'));
  assert.match(bg, /try \{\s*if \(options\) await session\.refreshContainers\(options\);\s*\} finally \{\s*listed\(\);/);
  assert.match(s, /export const vaultListComplete = \(\) => vaultListRuns === 0;/);
});
