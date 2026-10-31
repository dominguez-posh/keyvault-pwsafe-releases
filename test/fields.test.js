import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeField, normalizeItem, serializeItem, FIELD_FILE_MAX_BYTES } from '../extension/core/model.js';

test('old fields keep working (hidden flag becomes the type)', () => {
  assert.equal(normalizeField({ name: 'a', value: 'b' }).type, 'text');
  const h = normalizeField({ name: 'a', value: 'b', hidden: true });
  assert.equal(h.type, 'hidden');
  assert.equal(h.hidden, true);
});

test('known types are kept, unknown fall back to text', () => {
  for (const type of ['multiline', 'url', 'email', 'phone', 'number', 'date', 'totp']) assert.equal(normalizeField({ name: 'x', value: '1', type }).type, type);
  assert.equal(normalizeField({ name: 'x', value: '1', type: 'evil' }).type, 'text');
});

test('file fields: valid base64 within the limit, metadata cleaned', () => {
  const data = Buffer.from('Hallo Welt').toString('base64');
  const f = normalizeField({ name: 'Info', value: data, type: 'file', fileName: 'info.txt', mime: 'text/plain' });
  assert.deepEqual({ type: f.type, fileName: f.fileName, mime: f.mime, hidden: f.hidden }, { type: 'file', fileName: 'info.txt', mime: 'text/plain', hidden: false });
  assert.equal(normalizeField({ name: 'x', value: 'not base64!', type: 'file' }), null);
  assert.equal(normalizeField({ name: 'x', value: 'QQ==', type: 'file', mime: 'bad mime' }).mime, 'application/octet-stream');
  const big = Buffer.alloc(FIELD_FILE_MAX_BYTES + 100).toString('base64');
  assert.equal(normalizeField({ name: 'x', value: big, type: 'file' }), null);
});

test('an entry with a maximum-size attachment still fits into one secret', () => {
  const value = Buffer.alloc(FIELD_FILE_MAX_BYTES, 65).toString('base64');
  const item = normalizeItem({ title: 'T', fields: [{ name: 'Datei', value, type: 'file', fileName: 'a.txt' }] });
  assert.equal(item.fields.length, 1);
  assert.doesNotThrow(() => serializeItem(item));
});
