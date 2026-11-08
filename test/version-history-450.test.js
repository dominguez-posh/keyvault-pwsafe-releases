// #450: the timeline of an entry's versions (current, in between, "Added") and the text for unreadable versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineRows } from '../extension/core/ui-history.js';
import EN from '../extension/core/i18n-en.js';

const v = (n, updated, enabled = true) => ({ version: `v${n}`, updated, enabled });
const T0 = Date.parse('2026-01-01T10:00:00Z');

test('oldest version at the creation time becomes the clickable "Added" row', () => {
  const rows = timelineRows([v(3, T0 + 3e6), v(2, T0 + 2e6), v(1, T0 + 1000)], { created: new Date(T0).toISOString(), updated: T0 + 3e6 });
  assert.deepEqual(rows.map((r) => r.kind), ['current', 'version', 'added']);
  assert.equal(rows[2].version.version, 'v1');
});

test('history cut off (file vault keeps 10): "Added" comes from the entry, without a version to open', () => {
  const rows = timelineRows([v(3, T0 + 3e6), v(2, T0 + 2e6)], { created: new Date(T0).toISOString(), updated: T0 + 3e6 });
  assert.deepEqual(rows.map((r) => r.kind), ['current', 'version', 'added']);
  assert.equal(rows[2].version, undefined);
});

test('an entry with one version has the current row and the start', () => {
  const rows = timelineRows([v(1, T0)], { created: new Date(T0).toISOString(), updated: T0 });
  assert.deepEqual(rows.map((r) => r.kind), ['current', 'added']);
});

test('versions locked by a key change stay in the list, marked as not enabled', () => {
  const rows = timelineRows([v(3, T0 + 3e6), v(2, T0 + 2e6, false), v(1, T0 + 1000, false)], { created: new Date(T0).toISOString(), updated: T0 + 3e6 });
  assert.equal(rows[1].version.enabled, false);
  assert.equal(rows.at(-1).version.enabled, false);
});

test('empty or missing list does not throw', () => {
  assert.equal(timelineRows([], { updated: T0 }).length, 1);
  assert.equal(timelineRows(undefined, null).length, 1);
});

test('the unreadable texts are translated', () => {
  assert.ok(EN['Diese Version ist nicht mehr lesbar: Ein Schlüsselwechsel hat ältere Versionen gesperrt. Sie bleibt nur für das Protokoll erhalten.']);
});
