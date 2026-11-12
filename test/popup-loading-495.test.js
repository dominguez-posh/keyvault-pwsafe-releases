// #495: the popup shows a loading state at once and, where the service worker already holds it, the last list marked
// "wird aktualisiert". That list is only the in-memory snapshot of the app (entry metadata, no secrets), cleared with
// every app event (change, lock, offline); nothing is stored anywhere new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let onMessage = null;
let opened = true;
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.0.0' }),
    connectNative: () => ({
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onDisconnect: { addListener: () => {} },
      postMessage: (msg) => {
        const results = {
          hello: { version: 'test', opened },
          snapshot: { version: 'test', opened, pinSet: true, containers: opened ? [{ id: 'kv-team', name: 'Team' }, { id: 'kv-locked', name: 'Zu', locked: true }] : [],
            summaries: opened ? [{ id: 'pws-1', containerId: 'kv-team', type: 'login', title: 'GitHub', hosts: ['github.com'] }] : [] },
        };
        setTimeout(() => onMessage({ id: msg.id, ok: true, result: results[msg.cmd] }), 0);
      },
      disconnect: () => {},
    }),
    lastError: null,
  },
};

const { cachedSnapshot, connect, onEvent, snapshot } = await import('../extension/lib/desktop.js');
const { peekState, withCounts } = await import('../extension/lib/popup-peek.js');
connect();
onMessage({ event: 'online' });
const OPTS = { settings: { language: 'de' }, features: { history: true, assets: false, move: true, passkeyMove: false }, extensionId: 'x', version: '1.0.0' };

test('#495 nothing to show before the app answered once', () => {
  assert.equal(cachedSnapshot(), null);
  assert.equal(peekState(cachedSnapshot(), OPTS), null);
});

test('#495 after a snapshot the last list is there without waiting, in the shape of state/items', async () => {
  await snapshot();
  const peek = peekState(cachedSnapshot(), OPTS);
  assert.equal(peek.state.open, true);
  assert.equal(peek.state.cached, true);
  assert.equal(peek.state.demo, false);
  assert.deepEqual(peek.state.containers.map((c) => c.count), [1, null], 'counts per vault, none for a locked one');
  assert.equal(peek.state.canHistory, true);
  assert.equal(peek.state.canAssets, false);
  assert.deepEqual(peek.items.map((s) => s.title), ['GitHub']);
});

test('#495 every app event (change, lock, offline) clears it', async () => {
  const seen = [];
  onEvent((e) => seen.push(e));
  await snapshot();
  assert.ok(cachedSnapshot());
  onMessage({ event: 'changed' });
  assert.equal(cachedSnapshot(), null, 'a change or lock clears the last list');
  assert.deepEqual(seen, ['changed']);
});

test('#495 a locked app gives nothing to show', () => {
  assert.equal(peekState({ opened: false, containers: [], summaries: [] }, OPTS), null);
  assert.equal(peekState(null, OPTS), null);
  assert.deepEqual(withCounts({ containers: [{ id: 'a' }], summaries: [{ containerId: 'a' }, { containerId: 'b' }] }).map((c) => c.count), [1]);
});

test('#495 the popup page carries the loading state itself; peek is a page command and never in the demo', () => {
  const html = readFileSync(new URL('../extension/popup/popup.html', import.meta.url), 'utf8');
  assert.match(html, /<main id="view" class="view">\s*<!--|<main id="view" class="view">\s*<div class="loading-state"/);
  assert.match(html, /class="loading-step">Verbinde mit Keevault …</);
  const css = readFileSync(new URL('../extension/popup/popup.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.loading-bar span \{ animation: none;/);
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /const pageCommands = \{\n  state: [^\n]+\n[^\n]+\n  peek: async \(\) => \(demo \? null : peekState\(cachedSnapshot\(\)/);
  const popup = readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /step\?\.\(t\('Lade Tresore …'\)\)/);
  assert.match(popup, /setView\(errorView\(e\.message, load\)\)/);
});
