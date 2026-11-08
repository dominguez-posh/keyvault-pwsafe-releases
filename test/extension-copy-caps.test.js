import { test } from 'node:test';
import assert from 'node:assert/strict';

// #347: the extension asks the app for the copy capability and never falls back to the browser's clipboard.
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

// A fresh module instance per test (its state is module-wide).
const fresh = (tag) => import(`${new URL('../extension/lib/desktop.js', import.meta.url).href}?${tag}`);

test('copy: app with the capability → one copy command; hello carries the extension version', async () => {
  const sent = [];
  const listeners = fakeChrome({ version: '0.9.28', caps: ['copy'] }, sent);
  const desktop = await fresh('new');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  assert.equal(await desktop.app.copy('x'), true);
  assert.deepEqual(sent.map((m) => m.cmd), ['hello', 'copy']);
  assert.equal(sent[0].extVersion, '9.9.9');
});

test('copy: app without the capability (older than 0.9.27) → clear error, no copy command, no page clipboard', async () => {
  const sent = [];
  const listeners = fakeChrome({ version: '0.9.26' }, sent);
  globalThis.navigator ??= {};
  const desktop = await fresh('old');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  await assert.rejects(desktop.app.copy('x'), /zu alt|too old/);
  assert.deepEqual(sent.map((m) => m.cmd), ['hello'], 'the value never goes to an app that cannot protect it');
});

test('passkeySign: app without the capability (before 0.9.29) → clear error, no command, no local key use (#439)', async () => {
  const sent = [];
  const listeners = fakeChrome({ version: '0.9.28', caps: ['copy'] }, sent);
  const desktop = await fresh('nosign');
  desktop.connect();
  listeners.forEach((fn) => fn({ event: 'online' }));
  await assert.rejects(desktop.app.passkeySign({ pin: '1' }), /zu alt|too old/);
  assert.deepEqual(sent.map((m) => m.cmd), ['hello']);
});
