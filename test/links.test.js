import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItemLink, parseItemLink, appLinkFromFragment } from '../extension/core/links.js';

const vault = { vaultUrl: 'https://kv-team.vault.azure.net/', name: 'Team Infrastruktur' };
const id = 'pws-9b7f40d8580b4b659a152517828cee80';

test('entry link: web address with vault and entry only in the fragment', () => {
  const link = buildItemLink(vault, id);
  assert.match(link, /^https:\/\/keevault\.de\/open#/);
  assert.ok(!link.split('#')[0].includes('kv-team'));
  assert.deepEqual(parseItemLink(link), { host: 'kv-team.vault.azure.net', vaultUrl: 'https://kv-team.vault.azure.net/', id, name: 'Team Infrastruktur' });
});

test('the app link from the website carries the same entry', () => {
  const fragment = buildItemLink(vault, id).split('#')[1];
  const app = appLinkFromFragment(fragment);
  assert.match(app, /^kvpwsafe:\/\/item\?/);
  assert.equal(parseItemLink(app).id, id);
});

test('no link for file vaults, foreign hosts or odd ids', () => {
  assert.equal(buildItemLink({ path: 'C:/x.kvault', name: 'Datei' }, id), null);
  assert.equal(buildItemLink({ vaultUrl: 'https://evil.example.com/' }, id), null);
  assert.equal(buildItemLink(vault, '../../etc'), null);
  assert.equal(parseItemLink('https://keevault.de/open#v=evil.example.com&i=' + id), null);
  assert.equal(parseItemLink('kvpwsafe://add?vault=https://kv-team.vault.azure.net/'), null);
});
