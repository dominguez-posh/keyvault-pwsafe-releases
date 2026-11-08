// #397: partial smoke runs. What needs no Electron is checked here; the run itself is the Smoke-Tester's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FEATURE_AREAS, FLOW_AREAS, SMOKE_AREAS, areaSelection, onlyAreas, onlyProblem, smokePlan } from '../desktop/smoke-areas.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const script = (name, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), ...args], { encoding: 'utf8', timeout: 20_000 });
const demo = (...more) => ['--demo', '--smoke-test', ...more];

test('the list of feature areas is the list of steps, in their order', () => {
  const steps = [...read('../desktop/smoke-features.js').matchAll(/await step\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(steps, FEATURE_AREAS);
});

test('every flow area is asked for in the smoke run, and the run reports what did not run', () => {
  const smoke = read('../desktop/main/smoke.js');
  const asked = [...smoke.matchAll(/areas\.runs\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(asked, FLOW_AREAS);
  assert.match(smoke, /errors\.push\(\.\.\.areas\.missing\(\)\)/);
  assert.match(read('../desktop/smoke-features.js'), /if \(!ctx\.areas\.runs\(area\)\) return;/);
});

test('a full run runs everything and misses a skipped or an unlisted area', () => {
  const full = areaSelection(demo());
  assert.equal(full.partial, false);
  for (const name of SMOKE_AREAS) assert.equal(full.runs(name), true);
  assert.deepEqual(full.missing(), []);
  full.runs('newstep');
  assert.deepEqual(full.missing(), ['area "newstep" is missing in desktop/smoke-areas.js']);
  const short = areaSelection(demo());
  short.runs('clipboard');
  assert.ok(short.missing().includes('area "mainmenu" did not run'));
});

test('a partial run runs its areas and what they need, and fails when one did not run', () => {
  const only = areaSelection(demo('--only=vaultsearch,clipboard'));
  assert.equal(only.partial, true);
  assert.deepEqual(only.names, ['secured', 'clipboard', 'vaultsearch']);
  assert.equal(only.runs('mainmenu'), false);
  assert.equal(only.runs('clipboard'), true);
  assert.equal(only.runs('secured'), true);
  assert.deepEqual(only.missing(), ['area "vaultsearch" did not run']);
  assert.equal(only.runs('vaultsearch'), true);
  assert.deepEqual(only.missing(), []);
});

test('bad arguments are refused, and only known names reach the output', () => {
  assert.equal(onlyProblem(demo()), null);
  assert.equal(onlyProblem(demo('--only=mainmenu,agententer')), null);
  assert.match(onlyProblem(demo('--only=nosuch')), /unknown area "nosuch"\. Areas: shortcuts, .*machinesetup$/);
  for (const bad of ['--only=', '--only=mainmenu,', '--only=a b', '--only=$(calc)', '--only=::stop-commands::x', '--only=MAINMENU', `--only=${'a'.repeat(33)}`]) {
    const said = onlyProblem(demo(bad));
    assert.match(said, /unknown area /, bad);
    assert.ok(!said.slice(0, said.indexOf('. Areas:')).includes(bad.slice('--only='.length)) || bad === '--only=', bad);
  }
  assert.match(onlyProblem(['--smoke-test', '--only=mainmenu']), /needs --demo/);
  assert.match(onlyProblem(['--demo', '--only=mainmenu']), /needs --demo --smoke-test/);
  assert.match(onlyProblem(demo('--only=mainmenu', '--view=share')), /exclude each other/);
});

test('an unknown area ends with exit 1 and the list before anything starts', () => {
  for (const r of [script('smoke.mjs', '--only=nosuch'), script('start.mjs', ...demo('--only=nosuch'))]) {
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^SMOKE FAIL: unknown area "nosuch"\. Areas: .*mainmenu, .*agententer/);
    assert.doesNotMatch(r.stdout, /SMOKE OK/);
  }
});

test('npm run smoke: two runs as before, a partial run without the normal start and its "SMOKE OK"', () => {
  assert.deepEqual(smokePlan([], {}), [['--smoke-test'], ['--demo', '--smoke-test']]);
  assert.deepEqual(smokePlan(['--screenshot=x.png'], {}), [['--smoke-test'], ['--demo', '--smoke-test', '--screenshot=x.png']]);
  assert.deepEqual(smokePlan(['--only=mainmenu'], {}), [['--demo', '--smoke-test', '--only=mainmenu']]);
  assert.deepEqual(smokePlan([], { KVPWSAFE_SMOKE_ONLY: 'mainmenu' }), [['--demo', '--smoke-test', '--only=mainmenu']]);
  assert.deepEqual(smokePlan([], { KVPWSAFE_SMOKE_ONLY: '' }), [['--smoke-test'], ['--demo', '--smoke-test']]);
  assert.match(JSON.parse(read('../package.json')).scripts.smoke, /^node scripts\/smoke\.mjs$/);
  assert.equal(onlyAreas(['--demo']), null);
});
