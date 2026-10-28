import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryState, daysUntil, expiringEntries, passwordReport, hibpParts, hibpCount } from '../extension/core/health.js';

const now = Date.parse('2026-10-28T10:00:00Z');

test('expiry: state and days', () => {
  assert.equal(expiryState('', now), '');
  assert.equal(expiryState('2027-10-28', now), '');
  assert.equal(expiryState('2026-11-20', now), 'soon');
  assert.equal(expiryState('2026-10-28', now), 'soon', 'today still counts as soon, not expired');
  assert.equal(expiryState('2026-10-27', now), 'expired');
  assert.equal(expiryState('nonsense', now), '');
  assert.equal(daysUntil('2026-11-07', now), 10);
  const due = expiringEntries([{ title: 'b', expires: '2026-11-05' }, { title: 'a', expires: '2026-10-01' }, { title: 'c', expires: '2030-01-01' }, { title: 'd' }], now);
  assert.deepEqual(due.map((x) => `${x.entry.title}:${x.state}`), ['a:expired', 'b:soon']);
});

test('password report: weak, reused, old; notes skipped', () => {
  const items = [
    { key: 'a', title: 'A', type: 'login', password: 'abc', updated: '2026-10-01T00:00:00Z' },
    { key: 'b', title: 'B', type: 'login', password: 'Tr0ub4dor&3-long-enough-xx', updated: '2024-01-01T00:00:00Z' },
    { key: 'c', title: 'C', type: 'login', password: 'Tr0ub4dor&3-long-enough-xx', updated: '2026-10-01T00:00:00Z' },
    { key: 'd', title: 'D', type: 'login', password: 'V3ry-$trong-and-unique-passw0rd!', passwordChanged: '2026-10-01T00:00:00Z', updated: '2020-01-01T00:00:00Z' },
    { key: 'n', title: 'N', type: 'note', password: 'abc' },
    { key: 'e', title: 'E', type: 'login', password: '', updated: '2026-10-01T00:00:00Z' },
  ];
  const r = passwordReport(items, now);
  assert.equal(r.counts.checked, 4);
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.ok(by.a.weak, 'short password is weak');
  assert.ok(by.b.reused && by.c.reused, 'same password twice is reused');
  assert.ok(by.b.old && !by.c.old, 'only the one unchanged for over a year is old');
  assert.ok(!by.d, 'passwordChanged counts, not the last edit of the entry');
  assert.ok(!by.n && !by.e, 'notes and empty passwords are not reported');
  assert.deepEqual([r.counts.weak, r.counts.reused, r.counts.old, r.counts.pwned], [1, 2, 1, 0]);
  const leaked = passwordReport([{ key: 'x', title: 'X', type: 'login', password: 'V3ry-$trong-and-unique-passw0rd!', pwnedCount: 12, updated: '2026-10-01T00:00:00Z' }], now);
  assert.equal(leaked.items[0].pwned, 12);
  assert.equal(leaked.counts.pwned, 1);
});

test('HIBP: k-anonymity split and range parsing', async () => {
  const { prefix, suffix } = await hibpParts('password');
  assert.equal(prefix, '5BAA6');
  assert.equal(suffix, '1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  const range = '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0';
  assert.equal(hibpCount(range, suffix), 9545824);
  assert.equal(hibpCount(range, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), 0);
});
