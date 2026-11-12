// #505: the extension's connection to the app. A lost host is started again by itself with backoff (never a loop), the
// backoff starts over once the app is reachable, and a request still connects at once instead of waiting for the timer.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.timers.enable({ apis: ['setTimeout', 'Date'] });

const ports = [];
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.0.0' }),
    connectNative: () => {
      const port = { message: [], disconnect: [], sent: [] };
      port.api = {
        onMessage: { addListener: (fn) => port.message.push(fn) },
        onDisconnect: { addListener: (fn) => port.disconnect.push(fn) },
        postMessage: (msg) => port.sent.push(msg),
      };
      ports.push(port);
      return port.api;
    },
    lastError: null,
  },
};

const { connect, onEvent, status } = await import('../extension/lib/desktop.js');
const events = [];
onEvent((e) => events.push(e));
const last = () => ports[ports.length - 1];
const lose = (p = last()) => p.disconnect.forEach((fn) => fn());
const say = (msg, p = last()) => p.message.forEach((fn) => fn(msg));

test('connect opens one port only', () => {
  connect();
  connect();
  assert.equal(ports.length, 1);
});

test('a lost host is started again by itself, with growing waits', () => {
  lose();
  assert.equal(events.at(-1), 'offline');
  mock.timers.tick(999);
  assert.equal(ports.length, 1, 'not before 1 s');
  mock.timers.tick(1);
  assert.equal(ports.length, 2, 'new port after 1 s without any request');
  lose();
  mock.timers.tick(1999);
  assert.equal(ports.length, 2, 'second wait is longer');
  mock.timers.tick(1);
  assert.equal(ports.length, 3);
});

test('a missing host costs at most one attempt per minute', () => {
  for (let i = 0; i < 12; i++) {
    lose();
    mock.timers.tick(60_000);
  }
  const before = ports.length;
  lose();
  mock.timers.tick(59_999);
  assert.equal(ports.length, before, 'wait is capped at one minute, not shorter');
  mock.timers.tick(1);
  assert.equal(ports.length, before + 1);
});

test('the app online again: the next loss retries after 1 s', () => {
  say({ event: 'online' });
  lose();
  mock.timers.tick(1000);
  assert.equal(last().sent.length, 0, 'reconnect sends nothing by itself (no hello, no list)');
  const n = ports.length;
  lose();
  mock.timers.tick(2000);
  assert.equal(ports.length, n + 1);
});

test('a request does not wait for the backoff timer', async () => {
  say({ event: 'online' });
  mock.timers.tick(2100); // the port has been open a while (requests have a 2 s guard against loops)
  lose();
  const before = ports.length;
  const pending = status();
  assert.equal(ports.length, before + 1, 'the request opened a port at once, not after the 1 s backoff');
  say({ event: 'online' });
  const hello = last().sent[0];
  assert.equal(hello?.cmd, 'hello', 'the request goes over the new port');
  say({ id: hello.id, ok: true, result: { version: 't', opened: false } });
  for (let i = 0; i < 5 && !last().sent.some((m) => m.cmd === 'snapshot'); i++) await Promise.resolve();
  const snap = last().sent.find((m) => m.cmd === 'snapshot');
  say({ id: snap.id, ok: true, result: { version: 't', opened: false, containers: [], summaries: [] } });
  assert.equal((await pending).connected, true);
  mock.timers.tick(5000);
  assert.equal(ports.length, before + 1, 'the cancelled backoff timer opens no second port');
});

test('warm start: the port opens at browser start and installation, never in the demo', async () => {
  const { warmStart } = await import('../extension/lib/desktop.js');
  const startup = [];
  chrome.runtime.onStartup = { addListener: (fn) => startup.push(fn) };
  chrome.runtime.onInstalled = { addListener: (fn) => startup.push(fn) };
  say({ event: 'online' });
  mock.timers.tick(2100);
  lose();
  let demo = true;
  warmStart(async () => !demo);
  assert.equal(startup.length, 2, 'onStartup and onInstalled');
  const n = ports.length;
  await startup[0]();
  assert.equal(ports.length, n, 'demo: no port');
  demo = false;
  await startup[1]();
  assert.equal(ports.length, n + 1, 'port opened at once, before any request');
  assert.equal(last().sent.length, 0, 'nothing asked from the app (no hello, no list)');
  const src = (await import('node:fs')).readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /warmStart\(\(\) => ready\.then\(\(\) => !demo\)\)/, 'the worker registers it at its top level');
});
