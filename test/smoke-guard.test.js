// #377: a smoke run always ends with a verdict. The child processes run in Node's "warn" mode, the mode Electron's main
// process showed in the hanging run: a rejected promise only prints a warning and the process lives on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSmokeGuard, SMOKE_DEADLINE_MS, SLOWEST_RUN_ON_RECORD_MS } from '../desktop/main/smoke-guard.js';

const guardUrl = new URL('../desktop/main/smoke-guard.js', import.meta.url).href;
const noFolder = join(tmpdir(), `kvpwsafe-no-such-folder-${process.pid}`, 'demo.png');

function child(body, { timeout = 15_000, env = {} } = {}) {
  const code = `
    import fs from 'node:fs/promises';
    import { startSmokeGuard } from ${JSON.stringify(guardUrl)};
    setInterval(() => {}, 1000); // lives on like a main process with a window
    const guard = startSmokeGuard({ exit: (c) => process.exit(c) });
    const missing = ${JSON.stringify(noFolder)};
    ${body}
  `;
  return spawnSync(process.execPath, ['--unhandled-rejections=warn', '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout, env: { ...process.env, ...env },
  });
}

function inProcess(env = {}) {
  const exits = [];
  const lines = [];
  const handlers = {};
  const guard = startSmokeGuard({ exit: (c) => exits.push(c), log: (l) => lines.push(l), env, on: (name, fn) => { handlers[name] = fn; } });
  return { guard, exits, lines, handlers };
}

test('the old way hangs: a failed write in an unguarded async callback leaves the process alive', () => {
  const code = `
    import fs from 'node:fs/promises';
    setInterval(() => {}, 1000);
    setTimeout(async () => { await fs.writeFile(${JSON.stringify(noFolder)}, 'x'); process.exit(0); }, 0);
  `;
  const r = spawnSync(process.execPath, ['--unhandled-rejections=warn', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 2000 });
  assert.equal(r.status, null, 'still running when the timeout killed it');
  assert.match(r.stderr, /ENOENT/);
});

test('a screenshot that cannot be written ends the run with exit 1 and the reason', () => {
  const r = child(`setTimeout(() => guard.run(async () => { guard.note('screenshot'); await fs.writeFile(missing, 'x'); }), 0);`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^SMOKE FAIL\n/);
  assert.match(r.stdout, /run stopped at screenshot: .*ENOENT/);
});

test('a rejected promise outside the body ends the run with exit 1', () => {
  const r = child(`guard.note('checks'); Promise.reject(new Error('stray')); `);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^SMOKE FAIL\nunhandled rejection, last stage checks: .*stray/);
});

test('a body that never answers ends at the deadline, set from outside', () => {
  const r = child(`guard.note('features/x'); guard.run(() => new Promise(() => {}));`, { env: { KVPWSAFE_SMOKE_DEADLINE_MS: '300' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^SMOKE FAIL\nrun did not finish within 0\.3 s, last stage: features\/x/);
});

test('a good run says SMOKE OK, exits 0 and leaves no timer behind', () => {
  const r = child(`guard.run(async () => {});`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'SMOKE OK\n');
});

test('findings are in every verdict, and only the first verdict counts', async () => {
  const { guard, exits, lines, handlers } = inProcess();
  guard.collect(() => ['features/x: wrong', 'window visible on the desktop: "Keevault"']);
  await guard.run(async () => { throw new Error('write failed'); });
  handlers.unhandledRejection(new Error('later'));
  await guard.run(async () => {});
  assert.deepEqual(exits, [1]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SMOKE FAIL\nfeatures\/x: wrong\nwindow visible on the desktop: "Keevault"\nrun stopped at start: Error: write failed/);
});

test('findings alone fail the run', async () => {
  const { guard, exits, lines } = inProcess();
  guard.collect(() => ['features/x: wrong']);
  await guard.run(async () => {});
  assert.deepEqual(exits, [1]);
  assert.deepEqual(lines, ['SMOKE FAIL\nfeatures/x: wrong']);
});

test('an invalid deadline value does not switch the deadline off', async () => {
  const { guard, exits } = inProcess({ KVPWSAFE_SMOKE_DEADLINE_MS: 'nonsense' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, []);
  await guard.run(async () => {}); // clears the timer
});

test('#397: the deadline is 5 minutes, the slowest run on record ends in time and a hanging one does not', async (t) => {
  assert.equal(SMOKE_DEADLINE_MS, 5 * 60_000);
  assert.ok(SLOWEST_RUN_ON_RECORD_MS < SMOKE_DEADLINE_MS);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = inProcess();
  t.mock.timers.tick(SLOWEST_RUN_ON_RECORD_MS);
  assert.deepEqual(slow.exits, [], 'still running');
  await slow.guard.run(async () => {});
  assert.deepEqual(slow.lines, ['SMOKE OK']);

  const hanging = inProcess();
  hanging.guard.note('features/x');
  t.mock.timers.tick(SMOKE_DEADLINE_MS);
  assert.deepEqual(hanging.exits, [1]);
  assert.match(hanging.lines[0], /^SMOKE FAIL\nrun did not finish within 300 s, last stage: features\/x/);
});

test('#397: a partial run never says SMOKE OK, a failed one says what it was', async () => {
  const partial = (argv) => {
    const exits = [];
    const lines = [];
    return { exits, lines, guard: startSmokeGuard({ exit: (c) => exits.push(c), log: (l) => lines.push(l), env: {}, on: () => {}, argv }) };
  };
  const good = partial(['--demo', '--smoke-test', '--only=mainmenu']);
  await good.guard.run(async () => {});
  assert.deepEqual(good.exits, [0]);
  assert.match(good.lines[0], /^SMOKE PARTIAL OK: only mainmenu\. Not a full run/);
  assert.doesNotMatch(good.lines[0], /SMOKE OK/);

  const bad = partial(['--demo', '--smoke-test', '--only=vaultsearch']);
  bad.guard.collect(() => ['features/vaultsearch: wrong']);
  await bad.guard.run(async () => {});
  assert.deepEqual(bad.exits, [1]);
  assert.equal(bad.lines[0], 'SMOKE FAIL\nfeatures/vaultsearch: wrong\npartial run, not a full run: only secured, vaultsearch');
});

test('the app uses the guard: every way out of the smoke run goes through it', () => {
  const smoke = readFileSync(new URL('../desktop/main/smoke.js', import.meta.url), 'utf8');
  assert.match(smoke, /once\('did-finish-load', \(\) => setTimeout\(\(\) => smokeGuard\.run\(async \(\) => \{/);
  assert.doesNotMatch(smoke, /app\.exit\(/);
  assert.doesNotMatch(smoke, /setTimeout\(async/);
  assert.match(smoke, /smokeGuard\.collect\(\(\) => \[\.\.\.errors, \.\.\.missingFiles\.map\(.*\.\.\.windowViolations\]\)/);
});

test('boot.js starts it for smoke runs only', () => {
  const boot = readFileSync(new URL('../desktop/main/boot.js', import.meta.url), 'utf8');
  const lines = boot.split(/\r?\n/).filter((line) => line.includes('startSmokeGuard('));
  assert.deepEqual(lines, ['export const smokeGuard = smokeTest ? startSmokeGuard({ exit: (code) => app.exit(code) }) : null;']);
});
