import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAGES, appStage, extensionFeedChannel, reportedStage, featureOn, featuresAt, FEATURE_STAGES } from '../extension/core/channel.js';
import { kindFrom, stampCommit } from '../desktop/build-kind.js';

// #420 part A: release stages Dev → Early Access → Prod. A Dev build's stage is fixed in the build, the extension learns
// the stage from the app and unlocks only new functions with it; without an app it is Prod.

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const boom = () => { throw new Error('git must not run'); };

test('a Dev build is recognised from the stamp and is no Developer build', () => {
  assert.deepEqual(kindFrom({ kind: 'dev', commit: stampCommit('abc1234def') }, { packaged: true, git: boom }), { developer: false, dev: true, commit: 'abc1234' });
  assert.equal(kindFrom({ kind: 'release' }, { packaged: true, git: boom }).dev, undefined);
  assert.equal(kindFrom(undefined, { packaged: true, git: boom }).developer, true);
});

test('the stage of a Dev build ignores setting and policy; other builds follow the effective setting', () => {
  for (const setting of ['stable', 'beta', undefined, 'dev', 'x']) assert.equal(appStage({ dev: true }, setting), 'dev');
  assert.equal(appStage({ developer: false }, 'beta'), 'beta');
  assert.equal(appStage({ developer: true }, 'beta'), 'beta');
  assert.equal(appStage({}, 'stable'), 'stable');
  // A setting value "dev" never makes a release build a Dev build.
  assert.equal(appStage({ developer: false }, 'dev'), 'stable');
  assert.equal(appStage(undefined, undefined), 'stable');
});

test('extension policy feed (#455): Early Access and Dev get the Early Access feed, Prod the stable one', () => {
  assert.equal(extensionFeedChannel('stable'), 'stable');
  assert.equal(extensionFeedChannel('beta'), 'beta');
  assert.equal(extensionFeedChannel('dev'), 'beta');
  assert.equal(extensionFeedChannel(undefined), 'stable');
});

test('feature switches: unknown claims count as Prod, unlisted functions are always on', () => {
  assert.deepEqual(STAGES, ['stable', 'beta', 'dev']);
  for (const claim of [undefined, null, '', 'DEV', 'admin', 42, {}]) assert.equal(reportedStage(claim), 'stable');
  const table = { onlyDev: 'dev', earlyToo: 'beta', broken: 'nightly' };
  assert.equal(featureOn('onlyDev', 'stable', table), false);
  assert.equal(featureOn('onlyDev', 'beta', table), false);
  assert.equal(featureOn('onlyDev', 'dev', table), true);
  assert.equal(featureOn('earlyToo', 'stable', table), false);
  assert.equal(featureOn('earlyToo', 'beta', table), true);
  assert.equal(featureOn('earlyToo', 'dev', table), true);
  assert.equal(featureOn('earlyToo', 'nonsense', table), false, 'an odd claim is Prod');
  assert.equal(featureOn('broken', 'dev', table), false, 'an unknown stage in the table keeps the function off');
  assert.equal(featureOn('fill', 'stable', table), true, 'a normal function does not depend on the stage');
  assert.deepEqual(featuresAt('beta', table), { onlyDev: false, earlyToo: true, broken: false });
  // Only new, optional functions stand behind a switch; every entry names a real stage below Prod.
  for (const [name, stage] of Object.entries(FEATURE_STAGES)) assert.ok(['beta', 'dev'].includes(stage), name);
  assert.ok(Object.isFrozen(FEATURE_STAGES));
});

function fakeChrome(helloResult) {
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      lastError: null,
      connectNative: () => ({
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onDisconnect: { addListener: () => {} },
        postMessage: (m) => setTimeout(() => listeners.forEach((fn) => fn({ id: m.id, ok: true, result: m.cmd === 'hello' ? helloResult : true })), 0),
      }),
    },
  };
  return listeners;
}

test('the extension takes the stage from hello and falls back to Prod without the app', async () => {
  const listeners = fakeChrome({ version: '0.10.0', stage: 'dev', caps: ['copy'] });
  const desktop = await import(`${new URL('../extension/lib/desktop.js', import.meta.url).href}?stage420`);
  assert.equal(desktop.appStage(), 'stable', 'no hello yet: Prod');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  await desktop.app.copy('x');
  assert.equal(desktop.appStage(), 'dev');
  listeners.forEach((fn) => fn({ event: 'offline' }));
  assert.equal(desktop.appStage(), 'stable', 'app gone: Prod again');
});

test('wiring: hello reports the stage, a Dev build neither offers nor saves a channel, and never reads the public feeds', () => {
  assert.match(src('desktop/main/browser.js'), /stage: appStageNow\(\)/);
  const settings = src('desktop/renderer/app/settings.js');
  assert.match(settings, /\.\.\.\(devStage \? \{\} : \{ updateChannel:/);
  assert.match(settings, /devStage\s*\n?\s*\? h\('p', \{ class: 'muted small', id: 'dev-stage-note' \}/);
  assert.match(src('desktop/main/api/app.js'), /buildKind\(\)\.dev && patch && Object\.hasOwn\(patch, 'updateChannel'\)/);
  const updater = src('desktop/updater.js');
  assert.match(updater, /if \(this\.kind !== 'nsis' \|\| this\.devStage\) return;/);
  assert.match(updater, /this\.kind === 'dev' \|\| this\.devStage \|\|/);
  assert.match(updater, /this\.kind === 'nsis' && !this\.devStage && feed !== this\.feed/);
  // Both policy paths of the extension (#455 switch, #494 reinstall) use the same stage-aware channel.
  assert.doesNotMatch(src('desktop/main/extension-reinstall.js'), /const currentChannel =/);
  assert.match(src('desktop/main/extension-channel.js'), /export const currentChannel = \(\) => extensionFeedChannel\(appStageNow\(\)\)/);
});

/** The method `name` of the Updater class, taken from the source and run with a stand-in for electron-updater. */
function updaterMethod(name, autoUpdater) {
  const s = src('desktop/updater.js');
  const start = s.indexOf(`  async ${name}() {`);
  assert.ok(start > 0, `${name} not found`);
  const end = s.indexOf('\n  }\n', start);
  return new Function('autoUpdater', `return { ${s.slice(start, end + 4)} }.${name};`)(autoUpdater);
}

test('review N1: installNow and check refuse in a Dev build before anything is downloaded or read', async () => {
  for (const name of ['installNow', 'check']) {
    let downloads = 0;
    const method = updaterMethod(name, { downloadUpdate: async () => { downloads++; } });
    const calls = [];
    const self = {
      kind: 'nsis', devStage: true, state: { status: 'ready' },
      set: (p) => calls.push(['set', p]), install: () => calls.push(['install']), latest: async () => { calls.push(['latest']); return null; },
    };
    await assert.rejects(method.call(self), /Dev-Kanal/, name);
    assert.equal(downloads, 0, name);
    assert.deepEqual(calls, [], `${name} touched nothing`);
    assert.notEqual(self.manualInstall, true, name);
  }
  // A release build (devStage false) still installs: the guard is the only difference.
  let downloads = 0;
  const install = updaterMethod('installNow', { downloadUpdate: async () => { downloads++; } });
  await install.call({ kind: 'nsis', devStage: false, state: { status: 'idle' }, set: () => {}, install: () => {} });
  assert.equal(downloads, 1);
});
