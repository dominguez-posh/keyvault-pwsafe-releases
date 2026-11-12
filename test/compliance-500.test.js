// #500: compliance view for the Verwalter of a vault – password age, "Person ausgeschieden", masking and the CSV export
// (never a secret value).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { complianceCsv, dayStart, entryRow, labelOf, lastPasswordChange, leaverRows, monthsBefore, normalizeMonths, olderThan, removedPrincipals, tableOf } from '../extension/core/compliance.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const SECRET = 'Tz9!kB3#vNq7$Hw2';
const item = (over) => ({ id: 'pws-1', containerId: 'kv', key: 'kv/pws-1', type: 'login', title: 'Firewall', username: 'admin', folder: 'Netz', password: SECRET,
  notes: 'geheime Notiz', totp: 'JBSWY3DPEHPK3PXP', fields: [{ name: 'PIN', value: '4711', secret: true }], passkeys: [{ privateKey: 'pk' }],
  created: '2025-01-01T00:00:00Z', updated: '2026-11-01T00:00:00Z', ...over });

test('months: choices and free input, calendar months back', () => {
  assert.equal(normalizeMonths('6'), 6);
  assert.equal(normalizeMonths(0), null);
  assert.equal(normalizeMonths(241), null);
  assert.equal(normalizeMonths('x'), null);
  assert.equal(new Date(monthsBefore(Date.parse('2026-03-31T00:00:00Z'), 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(monthsBefore(NOW, 12)).toISOString().slice(0, 10), '2025-11-10');
  assert.equal(dayStart('2026-01-02'), Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(dayStart('02.01.2026'), null);
});

test('only a real password change counts: passwordChanged, else creation, else oldest version', () => {
  assert.deepEqual(lastPasswordChange(item({ passwordChanged: '2026-02-01T00:00:00Z' })), { at: Date.parse('2026-02-01T00:00:00Z'), source: 'password' });
  assert.deepEqual(lastPasswordChange(item({})), { at: Date.parse('2025-01-01T00:00:00Z'), source: 'created' }, 'updated (a title edit) is not used');
  assert.equal(lastPasswordChange(item({ created: '' }), 1700000000000).source, 'version');
  assert.equal(lastPasswordChange(item({ created: '', updated: '' })).at, 0);
  assert.equal(lastPasswordChange({ type: 'note', updated: '2026-01-01T00:00:00Z' }).source, 'updated', 'entries without password: last change');
});

test('age filter: older than X months, oldest first, unknown dates kept, notes left out', () => {
  const rows = [
    entryRow(item({ id: 'a', title: 'A', passwordChanged: '2026-09-01T00:00:00Z' })),
    entryRow(item({ id: 'b', title: 'B', passwordChanged: '2025-02-01T00:00:00Z' })),
    entryRow(item({ id: 'c', title: 'C' })), // created 2025-01-01
    entryRow(item({ id: 'd', title: 'D', created: '', updated: '' })),
    entryRow({ id: 'n', type: 'note', title: 'N', notes: 'x', updated: '2020-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(olderThan(rows, 12, NOW).map((r) => r.id), ['c', 'b', 'd']);
  assert.deepEqual(olderThan(rows, 3, NOW).map((r) => r.id), ['c', 'b', 'd']);
  assert.deepEqual(olderThan(rows, 1, NOW).map((r) => r.id), ['c', 'b', 'a', 'd']);
  assert.equal(olderThan(rows, 12, NOW)[0].ageDays, 678);
  assert.throws(() => olderThan(rows, 0, NOW), /1 bis 240/);
});

test('"seitdem geändert": password changed after the day the person left', () => {
  const rows = [
    entryRow(item({ id: 'fw', passwordChanged: '2025-06-15T00:00:00Z' })),
    entryRow(item({ id: 'graf', passwordChanged: '2026-09-20T00:00:00Z' })),
    entryRow(item({ id: 'nf' })),
  ];
  const out = leaverRows(rows, { since: dayStart('2026-01-01') });
  assert.deepEqual(Object.fromEntries(out.map((r) => [r.id, r.status])), { fw: 'unchanged', nf: 'unchanged', graf: 'changed' });
  assert.deepEqual(out.map((r) => r.status), ['unchanged', 'unchanged', 'changed'], 'the work list first');
  assert.ok(leaverRows(rows, { since: NOW }).every((r) => r.status === 'unchanged'), 'left today: nothing changed yet');
});

test('a row carries metadata only; other people\'s private entries are masked', () => {
  const row = entryRow(item({}));
  for (const k of ['password', 'notes', 'totp', 'fields', 'passkeys']) assert.equal(k in row, false, k);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(SECRET.replace(/[$!#]/g, '\\$&')));
  const hidden = entryRow(item({ privateOwner: 'oid-kim', privateOwnerName: 'Kim' }), { masked: 'private' });
  assert.equal(hidden.title, '');
  assert.equal(hidden.username, '');
  assert.equal(hidden.key, '', 'no way to open it');
  assert.equal(labelOf(hidden), 'Privater Eintrag von Kim');
  assert.equal(labelOf(entryRow(item({}), { masked: 'protected' })), 'Eintrag in geschütztem Tresor');
});

test('CSV export: fixed columns, never a secret value, formulas defused', () => {
  const rows = [entryRow(item({ title: '=HYPERLINK("x")' })), entryRow(item({ id: 'p', privateOwner: 'o', privateOwnerName: 'Kim', title: 'Privat' }), { masked: 'private' })];
  for (const [kind, list] of [['old', olderThan(rows, 1, NOW)], ['leaver', leaverRows(rows, { since: NOW })]]) {
    const text = complianceCsv(kind, list, 'Tresor Team');
    assert.ok(text.startsWith('﻿"Tresor Team"\r\n'));
    for (const secret of [SECRET, 'geheime Notiz', 'JBSWY3DPEHPK3PXP', '4711', 'Privat"']) assert.equal(text.includes(secret), false, `${kind}: ${secret}`);
    assert.match(text, /"'=HYPERLINK\(""x""\)"/);
    assert.equal(tableOf(kind, list).headers.length, text.split('\r\n')[1].split(';').length);
  }
});

test('former members from the activity log: deleted assignments on this vault only', () => {
  const vault = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-team';
  const ev = (over) => ({ operationName: { value: 'Microsoft.Authorization/roleAssignments/delete' }, status: { value: 'Succeeded' }, eventTimestamp: '2026-10-10T00:00:00Z',
    resourceId: `${vault}/providers/Microsoft.Authorization/roleAssignments/x`, properties: { responseBody: JSON.stringify({ properties: { principalId: '11111111-2222-4333-8444-555555555555' } }) }, ...over });
  const out = removedPrincipals([ev({}), ev({ status: { value: 'Started' } }), ev({ resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-other/x' }),
    ev({ operationName: { value: 'Microsoft.Authorization/roleAssignments/write' } }), ev({ properties: { responseBody: 'not json' } }), ev({ eventTimestamp: '2026-10-20T00:00:00Z' })], vault);
  assert.equal(out.length, 1);
  assert.equal(out[0].removedAt, Date.parse('2026-10-20T00:00:00Z'));
});

test('the main process checks admin mode and the Verwalter role; the menus offer it only then', () => {
  const api = readFileSync(new URL('../desktop/main/api/compliance.js', import.meta.url), 'utf8');
  assert.match(api, /if \(config\.get\(\)\.adminTools !== true\) throw/);
  assert.match(api, /if \(!c\.access\?\.admin && !c\.access\?\.manage\) throw/);
  assert.match(api, /entryRow\(/, 'entries leave the main process as metadata rows');
  const ui = readFileSync(new URL('../desktop/renderer/app/compliance.js', import.meta.url), 'utf8');
  assert.match(ui, /adminMode\(\) && c\?\.kind === 'keyvault' && !c\.personal && !c\.error && !!\(c\.access\?\.admin \|\| c\.access\?\.manage\)/);
});
