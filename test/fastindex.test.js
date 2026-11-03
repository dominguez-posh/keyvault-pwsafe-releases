import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeIndex, decodeIndex, unpack } from '../extension/core/fastindex.js';
import { summaryFromSecret, serializeItem, normalizeItem } from '../extension/core/model.js';

test('fast index keeps every list field: server connections, Microsoft/Sophos login, linked login', async () => {
  const summary = (name, input) => summaryFromSecret({ name, tags: serializeItem(normalizeItem(input)).tags, attributes: { updated: 1700000000 } }, 'kv');
  const list = [
    summary('win', { type: 'server', title: 'WIN', server: { kind: 'windows', host: '10.0.0.1', mgmtUrl: 'https://idrac.contoso.local' } }),
    summary('ms', { type: 'login', title: 'MS', msAdmin: true, sophos: true, loginLink: 'kv/win' }),
  ];
  const { header, shards } = await encodeIndex(list);
  const back = await decodeIndex('kv', header, shards);
  for (const s of list) {
    const b = back.find((x) => x.id === s.id);
    for (const k of ['methods', 'msAdmin', 'sophos', 'loginLinked', 'title', 'type', 'hosts']) assert.deepEqual(b[k], s[k], `${s.id}.${k}`);
  }
  assert.deepEqual(back.find((x) => x.id === 'win').methods, ['rdp', 'mgmt']);
  // A row of an older version (ends after the time): no methods instead of none at all.
  assert.deepEqual(unpack('kv', ['old', 'server', 'Old', '', '', '', '', 0, '', 1]).methods, []);
});
