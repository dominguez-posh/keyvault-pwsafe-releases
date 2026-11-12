// #526: a locked Windows session refuses the clipboard to every process. The smoke run must stop at once in a locked
// session, name a lock during the run as the cause, and keep the display on while it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCKED_AT_START, watchSmokeSession } from '../desktop/smoke-session.js';

function fakes(state) {
  const listeners = {};
  const started = [];
  return {
    monitor: { getSystemIdleState: () => state, on: (name, fn) => { listeners[name] = fn; } },
    blocker: { start: (type) => { started.push(type); return 1; } },
    listeners,
    started,
  };
}

test('locked at the start: the run stops, nothing is started', () => {
  const f = fakes('locked');
  const errors = [];
  assert.equal(watchSmokeSession({ ...f, errors }).lockedAtStart, true);
  assert.deepEqual(f.started, []);
  assert.deepEqual(errors, []);
});

test('unlocked: display kept on, a lock during the run becomes an error with the stage', () => {
  const f = fakes('active');
  const errors = [];
  const r = watchSmokeSession({ ...f, errors, stage: () => 'features/clipboard', now: () => new Date(2026, 10, 11, 20, 44, 5) });
  assert.equal(r.lockedAtStart, false);
  assert.deepEqual(f.started, ['prevent-display-sleep']);
  assert.deepEqual(errors, []);
  f.listeners['lock-screen']();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /gesperrt \(20:44:05, Teil features\/clipboard\)/);
});

test('the smoke run uses it before its first check and stops with the cause', () => {
  const src = readFileSync(new URL('../desktop/main/smoke.js', import.meta.url), 'utf8');
  const at = src.indexOf("smokeGuard.note('checks');");
  const use = src.indexOf('watchSmokeSession(', at);
  assert.ok(at > 0 && use > at && use < src.indexOf('areaSelection()', at), 'watchSmokeSession runs right after the checks start');
  assert.match(src.slice(use, use + 300), /lockedAtStart\) throw new Error\(LOCKED_AT_START\)/);
  assert.ok(LOCKED_AT_START.includes('entsperrte Sitzung'));
});
