import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlsFitPage, isStandardHttps, bastionFrameAllowed } from '../extension/core/match.js';
import { matchesForPage, newestMatchForPage, savedLoginForPage } from '../extension/core/pagefit.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vaultOf = (items) => ({
  matchesForHost: async () => items.map((i) => ({ containerId: 'c', id: i.id, updated: i.updated || 0 })),
  getItem: async (_c, id) => items.find((i) => i.id === id),
});

test('save prompt: on http and on a foreign port a saved login is neither compared nor offered for an update', async () => {
  const saved = { id: 'own', username: 'anna', password: 'Stored-1', title: 'Shop', urls: ['https://shop.example/'] };
  const vault = vaultOf([saved]);
  const found = (origin, user = 'anna') => savedLoginForPage(vault, { origin }, user);
  assert.equal(await found('http://shop.example'), null);
  assert.equal(await found('https://shop.example:8443'), null);
  assert.equal(await found('http://shop.example:8080'), null);
  // Its own page: this is what tells the refusals above from a helper that finds nothing at all.
  assert.deepEqual(await found('https://shop.example'), { containerId: 'c', id: 'own', item: saved });
  assert.equal(await found('https://shop.example', 'bert'), null);
});

test('save prompt: an entry for another port does not hide the one that fits, whatever the order', async () => {
  const other = { id: 'other', username: 'anna', password: 'Other-1', urls: ['https://shop.example:8443/'] };
  const own = { id: 'own', username: 'anna', password: 'Stored-1', urls: ['https://shop.example/'] };
  for (const items of [[other, own], [own, other]]) {
    assert.equal((await savedLoginForPage(vaultOf(items), { origin: 'https://shop.example' }, 'anna')).id, 'own');
  }
});

test('fill shortcut: filters first, then takes the newest that fits', async () => {
  const vault = vaultOf([
    { id: 'old', updated: 1, urls: ['https://shop.example/'] },
    { id: 'new', updated: 3, urls: ['https://shop.example/'] },
    { id: 'newest-other-port', updated: 9, urls: ['https://shop.example:8443/'] },
  ]);
  assert.equal((await newestMatchForPage(vault, 'https://shop.example/login')).id, 'new');
  assert.equal((await newestMatchForPage(vault, 'https://shop.example:8443/')).id, 'newest-other-port');
  assert.equal(await newestMatchForPage(vault, 'http://shop.example/'), null);
  assert.equal(await newestMatchForPage(vault, 'chrome://settings/'), null);
});

test('service worker: the shortcut and the save prompt go through the page checks', () => {
  const bg = readFileSync(fileURLToPath(new URL('../extension/background.js', import.meta.url)), 'utf8');
  const part = (from, to) => bg.slice(bg.indexOf(from), bg.indexOf(to, bg.indexOf(from)));
  const shortcut = part('chrome.commands.onCommand.addListener', '// ---');
  assert.match(shortcut, /newestMatchForPage\(vault, tab\.url\)/);
  assert.doesNotMatch(shortcut, /matchesForHost/);
  const capture = part('async function capture(', 'async function pendingCapture(');
  assert.match(capture, /savedLoginForPage\(vault, sender, username\)/);
  assert.doesNotMatch(capture, /matchesForHost/);
});

test('field menu: on standard https an entry naming another port shows neither title nor user name', async () => {
  const items = {
    plain: { id: 'plain', urls: ['https://shop.example/'] },
    ported: { id: 'ported', urls: ['https://shop.example:8443/'] },
    gone: { id: 'gone', urls: ['https://shop.example/'] },
  };
  const vault = {
    matchesForHost: async () => Object.values(items).map((i) => ({ containerId: 'c', id: i.id, title: i.id })),
    getItem: async (_c, id) => {
      if (id === 'gone') throw new Error('no access');
      return items[id];
    },
  };
  const ids = async (origin) => (await matchesForPage(vault, { origin })).map((m) => m.id);
  assert.deepEqual(await ids('https://shop.example'), ['plain']);
  assert.deepEqual(await ids('https://shop.example:8443'), ['ported']);
  assert.deepEqual(await ids('http://shop.example'), []);
});

test('sign-in data: an http page only for an entry with an http URL', () => {
  assert.equal(urlsFitPage(['https://shop.example/'], 'http://shop.example/'), false);
  assert.equal(urlsFitPage(['shop.example'], 'http://shop.example/'), false);
  assert.equal(urlsFitPage(['http://shop.example/'], 'http://shop.example/'), true);
  assert.equal(urlsFitPage(['http://shop.example/'], 'http://login.shop.example/'), true);
});

test('sign-in data: an https page fits https, a bare host and an http URL of the entry', () => {
  assert.equal(urlsFitPage(['https://shop.example/login'], 'https://shop.example/account'), true);
  assert.equal(urlsFitPage(['shop.example'], 'https://www.shop.example/'), true);
  assert.equal(urlsFitPage(['http://shop.example/'], 'https://shop.example/'), true);
});

test('sign-in data: the port must be the entry\'s', () => {
  assert.equal(urlsFitPage(['https://shop.example/'], 'https://shop.example:8443/'), false);
  assert.equal(urlsFitPage(['https://shop.example:8443/'], 'https://shop.example/'), false);
  assert.equal(urlsFitPage(['https://shop.example:8443/'], 'https://shop.example:8443/'), true);
  assert.equal(urlsFitPage(['https://shop.example:8443/'], 'https://shop.example:9443/'), false);
  assert.equal(urlsFitPage(['http://router.local:8080/'], 'http://router.local:8080/'), true);
  assert.equal(urlsFitPage(['http://router.local:8080/'], 'http://router.local:8081/'), false);
  assert.equal(urlsFitPage(['http://router.local/'], 'http://router.local:8080/'), false);
});

test('sign-in data: other hosts, other schemes and broken input never fit', () => {
  assert.equal(urlsFitPage(['https://shop.example/'], 'https://shop.example.evil.test/'), false);
  assert.equal(urlsFitPage(['https://shop.example/'], 'https://other.example/'), false);
  assert.equal(urlsFitPage(['ftp://shop.example/'], 'https://shop.example/'), false);
  assert.equal(urlsFitPage(['https://shop.example/'], 'file:///shop.example/'), false);
  assert.equal(urlsFitPage(['https://shop.example/'], 'not a url'), false);
  assert.equal(urlsFitPage(['http://[broken'], 'https://shop.example/'), false);
  assert.equal(urlsFitPage(undefined, 'https://shop.example/'), false);
});

test('standard https: no http, no own port', () => {
  assert.equal(isStandardHttps('https://shop.example/x'), true);
  assert.equal(isStandardHttps('https://shop.example:443/'), true);
  assert.equal(isStandardHttps('https://shop.example:8443/'), false);
  assert.equal(isStandardHttps('http://shop.example/'), false);
  assert.equal(isStandardHttps('nope'), false);
});

test('Bastion frames: only inside the portal, portal.azure.net never on its own', () => {
  assert.equal(bastionFrameAllowed({ host: 'bst-1.bastion.azure.com', frameId: 0, topIsPortal: false }), true);
  assert.equal(bastionFrameAllowed({ host: 'portal.azure.com', frameId: 0, topIsPortal: true }), true);
  assert.equal(bastionFrameAllowed({ host: 'bst-1.bastion.azure.com', frameId: 7, topIsPortal: true }), true);
  assert.equal(bastionFrameAllowed({ host: 'reactblade.portal.azure.net', frameId: 7, topIsPortal: true }), true);
  assert.equal(bastionFrameAllowed({ host: 'reactblade.portal.azure.net', frameId: 7, topIsPortal: false }), false);
  assert.equal(bastionFrameAllowed({ host: 'reactblade.portal.azure.net', frameId: 0, topIsPortal: false }), false);
  assert.equal(bastionFrameAllowed({ host: 'bst-1.bastion.azure.com', frameId: 7, topIsPortal: false }), false);
});
