import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBridge, hostScript } from '../desktop/bridge.js';

// Native messaging framing: 4-byte little-endian length + JSON.
function frame(msg) {
  const json = Buffer.from(JSON.stringify(msg));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

function startHost(pipe, origin) {
  const dir = mkdtempSync(join(tmpdir(), 'kvpwsafe-host-'));
  const script = join(dir, 'host.cjs');
  writeFileSync(script, hostScript(pipe));
  const proc = spawn(process.execPath, [script, origin], { stdio: ['pipe', 'pipe', 'inherit'] });
  const messages = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      messages.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
      buf = buf.subarray(4 + len);
    }
  });
  const next = async (n) => {
    for (let i = 0; i < 100 && messages.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    return messages[n - 1];
  };
  return { proc, send: (m) => proc.stdin.write(frame(m)), next };
}

const pipeName = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\kvpwsafe-test-${process.pid}-${Date.now()}`
  : join(mkdtempSync(join(tmpdir(), 'kvpwsafe-sock-')), 'bridge.sock'));

test('browser → host → desktop: approval by origin, commands, events', async () => {
  const pipe = pipeName();
  const seen = [];
  const bridge = new BrowserBridge({
    path: pipe,
    approve: async (origin) => {
      seen.push(origin);
      return origin === 'chrome-extension://good/';
    },
    handlers: {
      hello: async () => ({ version: '1.0' }),
      summaries: async () => [{ id: 'pws-1', title: 'Datei-Eintrag' }],
    },
  });
  await bridge.start();
  try {
    const good = startHost(pipe, 'chrome-extension://good/');
    good.send({ id: 1, cmd: 'hello', origin: 'chrome-extension://forged/' });
    assert.deepEqual(await good.next(1), { id: 1, ok: true, result: { version: '1.0' } });
    assert.deepEqual(seen, ['chrome-extension://good/'], 'the origin comes from the browser (argv), not from the message');
    good.send({ id: 2, cmd: 'summaries' });
    assert.equal((await good.next(2)).result[0].title, 'Datei-Eintrag');
    bridge.broadcast('changed');
    assert.deepEqual(await good.next(3), { event: 'changed' });

    const bad = startHost(pipe, 'chrome-extension://bad/');
    bad.send({ id: 1, cmd: 'summaries' });
    assert.equal((await bad.next(1)).error.name, 'NotApproved');
    bad.send({ id: 2, cmd: 'hello' });
    assert.equal((await bad.next(2)).error.name, 'NotApproved');
    good.proc.kill();
    bad.proc.kill();
  } finally {
    bridge.stop();
  }

  // Desktop app not running: the host reports offline and exits.
  const lonely = startHost(pipeName(), 'chrome-extension://good/');
  lonely.send({ id: 1, cmd: 'hello' });
  assert.deepEqual(await lonely.next(1), { event: 'offline' });
});
