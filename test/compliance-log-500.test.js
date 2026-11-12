// #500 part 2: compliance with a Log Analytics workspace – fixed KQL, the read history of a person, titles instead of
// technical names (masked where the admin may not see them) and the report export without secret values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complianceCsv, entryRow, leaverRows, dayStart } from '../extension/core/compliance.js';
import { complianceQuery, queryRequest, queryRows, readsOf, timeRange, withEntryLabels, REPORT_KINDS } from '../extension/core/compliance-log.js';

const VAULT = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-pwsafe/providers/Microsoft.KeyVault/vaults/kv-team';
const WS = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-logs/providers/Microsoft.OperationalInsights/workspaces/law-keevault';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const RANGE = timeRange(Date.parse('2026-10-01T00:00:00Z'), NOW, NOW);
const KEEVAULT = '0f1e2d3c-4b5a-4968-8776-655443322110';

test('time range: ISO, never in the future, at most two years', () => {
  assert.deepEqual(RANGE, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-10T12:00:00.000Z' });
  assert.equal(timeRange(NOW - 1000, NOW + 86_400_000, NOW).to, new Date(NOW).toISOString());
  assert.throws(() => timeRange(NOW, NOW - 1, NOW), /Zeitraum/);
  assert.throws(() => timeRange(NOW - 800 * 86_400_000, NOW, NOW), /Zeitraum/);
  assert.throws(() => timeRange('nonsense', NOW, NOW), /Zeitraum/);
});

test('KQL: every report reads only this vault\'s audit log in the range, named in the first line', () => {
  for (const kind of REPORT_KINDS) {
    const q = complianceQuery(kind, VAULT, { range: RANGE, clientIds: [KEEVAULT] });
    assert.ok(q.startsWith(`// keevault:${kind}\nAzureDiagnostics\n`), kind);
    assert.match(q, /Category == "AuditEvent"/);
    assert.ok(q.includes(`_ResourceId =~ "${VAULT.toLowerCase()}"`), kind);
    assert.ok(q.includes('between (datetime(2026-10-01T00:00:00.000Z) .. datetime(2026-11-10T12:00:00.000Z))'), kind);
  }
  assert.match(complianceQuery('reads', VAULT, { range: RANGE }), /OperationName == "SecretGet"[\s\S]*by Person, Oid, Entry/);
  assert.match(complianceQuery('many', VAULT, { range: RANGE, threshold: 25 }), /where Entries > 25/);
  assert.match(complianceQuery('denied', VAULT, { range: RANGE }), /httpStatusCode_d\) == 403/);
  assert.match(complianceQuery('changes', VAULT, { range: RANGE }), /"SecretSet", "SecretUpdate", "SecretDelete", "SecretPurge"/);
  assert.match(complianceQuery('coverage', VAULT), /summarize First = min\(TimeGenerated\)/);
});

test('KQL: other apps leave Keevault\'s app ID out; nothing unchecked gets into a query', () => {
  const apps = complianceQuery('apps', VAULT, { range: RANGE, clientIds: [KEEVAULT.toUpperCase(), 'demo', '") | evil'] });
  assert.ok(apps.includes(`App !in ("${KEEVAULT}")`), apps);
  assert.doesNotMatch(apps, /evil|demo/);
  assert.match(complianceQuery('apps', VAULT, { range: RANGE, clientIds: ['demo'] }), /where isnotempty\(App\)\n/);
  assert.throws(() => complianceQuery('reads', '/subscriptions/x"|evil', { range: RANGE }));
  assert.throws(() => complianceQuery('reads', VAULT, { range: { from: '2026-01-01") | evil', to: RANGE.to } }), /time range/);
  assert.throws(() => complianceQuery('many', VAULT, { range: RANGE, threshold: '5 | evil' }), /Schwelle/);
  assert.throws(() => complianceQuery('drop', VAULT, { range: RANGE }), /unknown/);
  assert.throws(() => queryRequest('/subscriptions/x/evil', 'q'), /workspace/);
  assert.deepEqual(queryRequest(WS, 'q', RANGE), { path: `${WS}/api/query`, apiVersion: '2017-01-01-preview', body: { query: 'q', timespan: `${RANGE.from}/${RANGE.to}` } });
});

test('read history of one person: matched by UPN or object ID, summed per entry', () => {
  const rows = queryRows({ tables: [{ columns: [{ name: 'Person' }, { name: 'Oid' }, { name: 'Entry' }, { name: 'Reads' }, { name: 'First' }, { name: 'Last' }], rows: [
    ['kim@contoso.com', 'oid-kim', 'pws-1', 3, '2025-11-03T09:00:00Z', '2025-12-01T10:00:00Z'],
    ['oid-kim', 'oid-kim', 'pws-1', 1, '2025-10-01T09:00:00Z', '2025-10-01T09:00:00Z'],
    ['KIM@contoso.com', '', 'pws-2', 2, '2026-01-10T09:00:00Z', '2026-01-15T10:00:00Z'],
    ['alex@contoso.com', 'oid-alex', 'pws-3', 7, '2025-11-05T09:00:00Z', '2026-11-01T10:00:00Z'],
  ] }] });
  const kim = readsOf(rows, { principalId: 'oid-kim', detail: 'kim@contoso.com' });
  assert.deepEqual([...kim.keys()], ['pws-1', 'pws-2']);
  assert.deepEqual(kim.get('pws-1'), { count: 4, first: Date.parse('2025-10-01T09:00:00Z'), last: Date.parse('2025-12-01T10:00:00Z') });
  assert.equal(readsOf(rows, { principalId: 'oid-kim', detail: '' }).size, 1, 'only the object ID known: rows that carry it');
  assert.deepEqual(queryRows({}), []);
});

test('"seitdem geändert" with the log: against the person\'s last read; never read is its own status', () => {
  const rows = [
    entryRow({ id: 'pws-1', title: 'Firewall', password: 'x', passwordChanged: '2025-06-15T00:00:00Z' }),
    entryRow({ id: 'pws-2', title: 'Grafana', password: 'x', passwordChanged: '2026-09-20T00:00:00Z' }),
    entryRow({ id: 'pws-3', title: 'Notfall', password: 'x', created: '2025-09-01T00:00:00Z' }),
  ];
  const reads = new Map([['pws-1', { count: 4, first: 0, last: Date.parse('2025-12-01T10:00:00Z') }], ['pws-2', { count: 2, first: 0, last: Date.parse('2026-01-15T10:00:00Z') }]]);
  const out = leaverRows(rows, { since: dayStart('2026-11-01'), reads });
  assert.deepEqual(Object.fromEntries(out.map((r) => [r.id, r.status])), { 'pws-1': 'unchanged', 'pws-2': 'changed', 'pws-3': 'notread' });
  assert.equal(out.find((r) => r.id === 'pws-1').reads, 4);
});

test('titles instead of technical names; private, protected and unknown entries stay masked', () => {
  const labels = new Map([
    ['pws-1', entryRow({ id: 'pws-1', containerId: 'kv', key: 'kv/pws-1', title: 'Firewall' })],
    ['pws-2', entryRow({ id: 'pws-2', containerId: 'kv', key: 'kv/pws-2', title: 'Gehalt Kim', privateOwnerName: 'Kim' }, { masked: 'private' })],
    ['pws-3', entryRow({ id: 'pws-3', title: 'Geheim' }, { masked: 'protected' })],
  ]);
  const out = withEntryLabels([{ Person: 'a', Entry: 'pws-1' }, { Person: 'a', Entry: 'pws-2' }, { Person: 'a', Entry: 'pws-3' }, { Person: 'a', Entry: 'pws-gone' }, { App: 'x' }], labels);
  assert.deepEqual(out.map((r) => r.entry), ['Firewall', 'Privater Eintrag von Kim', 'Eintrag in geschütztem Tresor', 'Gelöschter oder unbekannter Eintrag', undefined]);
  assert.deepEqual(out.map((r) => r.key || ''), ['kv/pws-1', '', '', '', '']);
  assert.ok(out.every((r) => !('Entry' in r)), 'the technical name does not reach the window');
  assert.doesNotMatch(JSON.stringify(out), /Gehalt|Geheim|pws-gone/);
});

test('report CSV: fixed columns, the log fields only', () => {
  const rows = withEntryLabels(queryRows({ tables: [{ columns: ['TimeGenerated', 'Person', 'OperationName', 'Entry', 'CallerIPAddress', 'requestUri_s'].map((name) => ({ name })),
    rows: [['2026-02-01T07:00:00Z', 'kim@contoso.com', 'SecretGet', 'pws-1', '203.0.113.7', 'https://kv/secrets/pws-1?value=Tz9!']] }] }), new Map());
  const csv = complianceCsv('denied', rows);
  assert.equal(csv.split('\r\n')[0], '﻿"Zeit";"Person";"Vorgang";"Eintrag";"IP-Adresse"');
  assert.match(csv, /"2026-02-01 07:00";"kim@contoso.com";"SecretGet";"Gelöschter oder unbekannter Eintrag";"203.0.113.7"/);
  assert.doesNotMatch(csv, /Tz9|requestUri/);
  for (const kind of ['reads', 'many', 'apps', 'changes', 'leaverlog']) assert.ok(complianceCsv(kind, []).length > 1, kind);
});
