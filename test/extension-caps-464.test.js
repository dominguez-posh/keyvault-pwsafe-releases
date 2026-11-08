import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #464: the popup shows history, assets and moving only when the app reports the capability; an older app (no caps) hides
// them without an error, and the extension sends none of the commands to it.

function fakeChrome(helloResult, sent) {
  const msgListeners = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      lastError: null,
      connectNative: () => ({
        onMessage: { addListener: (fn) => msgListeners.push(fn) },
        onDisconnect: { addListener: () => {} },
        postMessage: (m) => {
          sent.push(m);
          setTimeout(() => msgListeners.forEach((fn) => fn({ id: m.id, ok: true, result: m.cmd === 'hello' ? helloResult : true })), 0);
        },
      }),
    },
  };
  return msgListeners;
}

const fresh = (tag) => import(`${new URL('../extension/lib/desktop.js', import.meta.url).href}?${tag}`);

test('app with all capabilities: features on, commands go through', async () => {
  const sent = [];
  const listeners = fakeChrome({ version: '0.9.30', caps: ['passkeySign', 'copy', 'history', 'linkedEntries', 'move', 'movePasskey'] }, sent);
  const desktop = await fresh('new');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  assert.deepEqual(desktop.appFeatures(), { history: false, assets: false, move: false, passkeyMove: false }, 'nothing known before hello');
  await desktop.app.history('A', '1');
  assert.deepEqual(desktop.appFeatures(), { history: true, assets: true, move: true, passkeyMove: true });
  await desktop.app.getVersion('A', '1', 'v1');
  await desktop.app.linkedEntries('A', '1');
  await desktop.app.planMove('A', 'B', '1');
  await desktop.app.moveItem('A', 'B', '1');
  await desktop.app.moveWithAssets('A', 'B', '1', { expected: ['1'] });
  await desktop.app.movePasskey({ from: { containerId: 'A', id: '1' }, to: { containerId: 'B', id: '2' }, credentialId: 'c' });
  assert.deepEqual(sent.map((m) => m.cmd), ['hello', 'history', 'version', 'linkedEntries', 'planMove', 'move', 'moveWithAssets', 'movePasskey']);
  assert.deepEqual(sent.find((m) => m.cmd === 'moveWithAssets').expected, ['1']);
});

test('older app without the capabilities: features off, a call fails clearly and sends no command', async () => {
  const sent = [];
  const listeners = fakeChrome({ version: '0.9.28', caps: ['passkeySign', 'copy'] }, sent);
  const desktop = await fresh('old');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  await desktop.app.copy('x');
  assert.deepEqual(desktop.appFeatures(), { history: false, assets: false, move: false, passkeyMove: false });
  for (const fn of [() => desktop.app.history('A', '1'), () => desktop.app.getVersion('A', '1', 'v'), () => desktop.app.linkedEntries('A', '1'),
    () => desktop.app.planMove('A', 'B', '1'), () => desktop.app.moveItem('A', 'B', '1'), () => desktop.app.moveWithAssets('A', 'B', '1'), () => desktop.app.movePasskey({})]) {
    await assert.rejects(fn(), /zu alt/);
  }
  assert.deepEqual(sent.map((m) => m.cmd), ['hello', 'copy'], 'none of the new commands reached the old app');
});

test('popup: each function appears only with its flag, and without the flag nothing is requested', () => {
  const popup = readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /st\.canHistory \? \{ load:/);
  assert.match(popup, /const hasAssets = st\.canAssets && item\.type === 'login'/);
  assert.match(popup, /st\.canMove && mayWrite \? \{ icon: 'move'/);
  assert.match(popup, /onMovePasskey: st\.canMovePasskey && mayWrite/);
  assert.match(popup, /onMovePasskey: item && st\.canMovePasskey/);
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /const features = demo \? \{[^}]*\} : appFeatures\(\)/);
  assert.match(bg, /canHistory: features\.history, canAssets: features\.assets, canMove: features\.move, canMovePasskey: features\.passkeyMove/);
});
