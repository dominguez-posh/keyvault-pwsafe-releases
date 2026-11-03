import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, serializeItem, parseItem, summaryFromSecret, resolveLogin } from '../extension/core/model.js';

const store = new Map();
const put = (containerId, id, input) => {
  const item = { ...normalizeItem(input), id, containerId, key: `${containerId}/${id}` };
  store.set(item.key, item);
  return item;
};
const getItem = async (containerId, id) => {
  const item = store.get(`${containerId}/${id}`);
  if (!item) throw new Error('not found');
  return item;
};

put('kv', 'domain', { type: 'login', title: 'Domain-Login', username: 'CONTOSO\\alice', password: 'Dom-Pass-1', totp: 'JBSWY3DPEHPK3PXP' });
put('kv', 'ms', { type: 'login', title: 'Microsoft', username: 'alice@contoso.com', password: 'Ms-Pass-1', msAdmin: true, passkeys: [] });
put('other', 'foreign', { type: 'login', title: 'Fremd', username: 'x', password: 'Foreign-1' });
put('kv', 'note', { type: 'note', title: 'Notiz', notes: 'n' });

test('linked login: user name and password come from the linked entry, own values are not stored', async () => {
  const portal = put('kv', 'portal', { type: 'login', title: 'Intranet', urls: ['https://intranet.contoso.com'], loginLink: 'kv/domain' });
  const r = await resolveLogin(portal, getItem);
  assert.equal(r.username, 'CONTOSO\\alice');
  assert.equal(r.password, 'Dom-Pass-1');
  assert.equal(r.totp, 'JBSWY3DPEHPK3PXP', 'without an own one-time code the linked one is used');
  assert.deepEqual(r.urls, ['https://intranet.contoso.com'], 'the entry keeps its own websites');
  assert.equal(r.linked.title, 'Domain-Login');
  assert.equal(r.linked.microsoft, false);
  // Stored: only the reference, marked in the tags for the list.
  const { value, tags } = serializeItem(portal);
  const doc = JSON.parse(value);
  assert.equal(doc.loginLink, 'kv/domain');
  assert.equal(doc.password, '');
  assert.equal(tags.ln, '1');
  assert.equal(summaryFromSecret({ name: 'portal', tags }, 'kv').loginLinked, true);
  assert.equal(parseItem({ name: 'portal', value }, 'kv').loginLink, 'kv/domain');
});

test('linked login: own one-time code wins (e.g. a Sophos portal MFA), Microsoft link is recognised', async () => {
  const sophos = put('kv', 'vpn', { type: 'login', title: 'VPN', sophos: true, totp: 'GEZDGNBVGY3TQOJQ', loginLink: 'kv/domain' });
  assert.equal((await resolveLogin(sophos, getItem)).totp, 'GEZDGNBVGY3TQOJQ');
  const ext = put('kv', 'ext', { type: 'login', title: 'Partnerportal', urls: ['https://partner.example.com'], loginLink: 'kv/ms' });
  const r = await resolveLogin(ext, getItem);
  assert.equal(r.username, 'alice@contoso.com');
  assert.equal(r.linked.microsoft, true);
  assert.equal(r.linked.msAdmin, true);
});

test('linked login: other vault, itself, a missing entry or a non-login give nothing (shown as not available)', async () => {
  for (const link of ['other/foreign', 'kv/self', 'kv/gone', 'kv/note']) {
    const item = put('kv', 'self', { type: 'login', title: 'x', username: 'stale', password: 'stale', loginLink: link });
    const r = await resolveLogin(item, getItem);
    assert.equal(r.password, '', link);
    assert.equal(r.username, '', link);
    assert.equal(r.linked.missing, true, link);
  }
  // Without a link: unchanged.
  const plain = put('kv', 'plain', { type: 'login', title: 'p', username: 'u', password: 'p' });
  assert.equal(await resolveLogin(plain, getItem), plain);
  // Only logins carry a link; anything else that is not a key is dropped.
  assert.equal(normalizeItem({ type: 'note', loginLink: 'kv/domain' }).loginLink, '');
  assert.equal(normalizeItem({ type: 'login', loginLink: 'no key' }).loginLink, '');
});
