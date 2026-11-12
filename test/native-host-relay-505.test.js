// #505: the small native messaging host (Keevault-Update.exe --native-host, windows/Setup/NativeHost.cs) relays like
// host.cjs: the browser's origin goes into every hello (whatever the extension wrote there is replaced, #466), events and
// answers pass through, without the app requests are answered at once. New: only the configured program may serve the
// pipe; another process holding the pipe name gets nothing. Chrome and Edge start the exe directly with only the origin;
// its options come from native-host/relay.txt (KV_RELAY_OPTIONS here).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayOptions } from '../desktop/bridge.js';

const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));
const skip = process.platform !== 'win32' || !existsSync(exe);
const dir = mkdtempSync(join(tmpdir(), 'kv505-'));
after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still held by the scanner: the temp folder is cleaned later */ } });
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

let n = 0;
/** A pipe server like the app's BrowserBridge: records the lines, answers each request with its id. */
async function appPipe() {
  const pipe = `\\\\.\\pipe\\kv505-test-${process.pid}-${++n}`;
  const lines = [];
  const clients = [];
  const server = net.createServer((socket) => {
    clients.push(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        lines.push(msg);
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, result: { echo: msg } })}\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(pipe, r));
  return { pipe, lines, clients, close: () => new Promise((r) => { clients.forEach((c) => c.destroy()); server.close(r); }) };
}

/** Starts the relay like Chrome/Edge do (the exe directly, origin and parent window as arguments) and speaks native
 * messaging. switchArgs: the explicit --native-host form with the options on the command line instead. */
function relay(config, { switchArgs = false } = {}) {
  const options = join(dir, `relay-${++n}.txt`);
  writeFileSync(options, relayOptions(config));
  const args = switchArgs
    ? ['--native-host', '--pipe', config.pipe, '--server', config.server, '--launch', config.launch.cmd, ...config.launch.args.flatMap((a) => ['--launch-arg', a]), ORIGIN]
    : [ORIGIN, '--parent-window=0'];
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, KV_RELAY_OPTIONS: switchArgs ? join(dir, 'none.txt') : options } });
  const got = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      got.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const exited = new Promise((r) => child.on('exit', r));
  return {
    got, exited, stderr: () => stderr,
    send(msg) {
      const json = Buffer.from(JSON.stringify(msg));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(json.length, 0);
      child.stdin.write(Buffer.concat([len, json]));
    },
    async waitFor(fn, ms = 10_000) {
      const end = Date.now() + ms;
      while (!got.some(fn)) {
        if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(got)}; stderr ${stderr}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
      }
      return got.find(fn);
    },
    end() { child.stdin.end(); },
    kill() { child.kill(); },
  };
}

test('#505 relay: online, the origin is written into hello, answers and events pass through', { skip }, async () => {
  const app = await appPipe();
  const r = relay({ pipe: app.pipe, launch: { cmd: 'none', args: [] }, server: process.execPath });
  try {
    await r.waitFor((m) => m.event === 'online');
    r.send({ id: 1, cmd: 'hello', origin: 'chrome-extension://evil/', extVersion: '1.2.3', text: 'ä € 😀 "q" \\ \n' });
    const answer = await r.waitFor((m) => m.id === 1);
    assert.equal(app.lines[0].origin, ORIGIN, 'origin from the browser, not from the extension');
    assert.equal(app.lines[0].text, 'ä € 😀 "q" \\ \n', 'text unchanged');
    assert.equal(answer.ok, true);
    r.send({ id: 2, cmd: 'snapshot' });
    await r.waitFor((m) => m.id === 2);
    assert.equal(app.lines[1].origin, undefined, 'only hello gets the origin');
    app.clients[0].write('{"event":"changed"}\n');
    await r.waitFor((m) => m.event === 'changed');
  } finally {
    r.kill();
    await app.close();
  }
});

test('#505 relay: without the app requests fail at once, the app coming later turns it online', { skip }, async () => {
  const pipe = `\\\\.\\pipe\\kv505-late-${process.pid}`;
  const r = relay({ pipe, launch: { cmd: 'none', args: [] }, server: process.execPath });
  let server = null;
  try {
    await r.waitFor((m) => m.event === 'offline');
    const t0 = Date.now();
    r.send({ id: 7, cmd: 'snapshot' });
    const reply = await r.waitFor((m) => m.id === 7);
    assert.equal(reply.error?.name, 'AppOffline');
    assert.ok(Date.now() - t0 < 1000, 'answered at once');
    server = net.createServer(() => {});
    await new Promise((res) => server.listen(pipe, res));
    await r.waitFor((m) => m.event === 'online', 6000);
  } finally {
    r.kill();
    server?.close();
  }
});

test('#505 relay: a pipe served by another program gets nothing (check of the other end)', { skip }, async () => {
  const app = await appPipe();
  const r = relay({ pipe: app.pipe, launch: { cmd: 'none', args: [] }, server: 'C:\\Program Files\\Keevault\\Keevault.exe' });
  try {
    await r.waitFor((m) => m.event === 'offline');
    r.send({ id: 3, cmd: 'hello' });
    assert.equal((await r.waitFor((m) => m.id === 3)).error?.name, 'AppOffline');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(app.lines.length, 0, 'nothing reached the foreign pipe server');
    assert.ok(!r.got.some((m) => m.event === 'online'));
    assert.match(r.stderr(), /not served by the Keevault app/);
  } finally {
    r.kill();
    await app.close();
  }
});

test('#505 relay: launch starts the app, the end of stdin ends the relay', { skip }, async () => {
  // wscript: a start without any window on the desktop (the app itself is started through explorer.exe kvpwsafe://open).
  const marker = join(dir, 'launched.txt');
  const script = join(dir, 'launch.js');
  writeFileSync(script, `new ActiveXObject('Scripting.FileSystemObject').CreateTextFile(${JSON.stringify(marker)}).Close();`);
  const r = relay({ pipe: `\\\\.\\pipe\\kv505-none-${process.pid}`, launch: { cmd: 'wscript.exe', args: [script] }, server: process.execPath });
  r.send({ id: 9, cmd: 'launch' });
  assert.equal((await r.waitFor((m) => m.id === 9)).ok, true);
  for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(marker), 'the app was started');
  r.end();
  const code = await Promise.race([r.exited, new Promise((res) => setTimeout(() => res('timeout'), 5000))]);
  assert.notEqual(code, 'timeout', 'relay ends with the browser port');
});

test('#505 relay: the explicit --native-host switch with options on the command line works as well', { skip }, async () => {
  const app = await appPipe();
  const r = relay({ pipe: app.pipe, launch: { cmd: 'none', args: [] }, server: process.execPath }, { switchArgs: true });
  try {
    await r.waitFor((m) => m.event === 'online');
    r.send({ id: 1, cmd: 'hello' });
    await r.waitFor((m) => m.id === 1);
    assert.equal(app.lines[0].origin, ORIGIN);
  } finally {
    r.kill();
    await app.close();
  }
});

test('#505 registration: Chrome/Edge start the exe directly, its options in relay.txt, Firefox keeps host.cjs', () => {
  assert.equal(relayOptions({ pipe: '\\\\.\\pipe\\kvpwsafe-u', launch: { cmd: 'C:\\Windows\\explorer.exe', args: ['kvpwsafe://open'] }, server: 'C:\\K 100%\\Keevault.exe\r\nserver=C:\\evil.exe' }),
    'pipe=\\\\.\\pipe\\kvpwsafe-u\r\nserver=C:\\K 100%\\Keevault.exeserver=C:\\evil.exe\r\nlaunch=C:\\Windows\\explorer.exe\r\nlaunch-arg=kvpwsafe://open\r\n', 'line breaks cannot add options');
  const bridge = readFileSync(fileURLToPath(new URL('../desktop/bridge.js', import.meta.url)), 'utf8');
  assert.match(bridge, /chromeHost = relay\.exe;/);
  assert.match(bridge, /path: chromeHost,/);
  assert.match(bridge, /const firefoxManifest = \{ name: HOST_NAME, description: 'Keevault', path: launcher,/);
  assert.match(bridge, /path\.join\(dir, 'relay\.txt'\)/);
  const cs = readFileSync(fileURLToPath(new URL('../windows/Setup/NativeHost.cs', import.meta.url)), 'utf8');
  assert.match(cs, /"KeyVault PwSafe", "native-host", "relay\.txt"/, 'the relay reads the file the installed app writes (userData pinned in boot.js)');
  const browser = readFileSync(fileURLToPath(new URL('../desktop/main/browser.js', import.meta.url)), 'utf8');
  assert.match(browser, /const relayExe = viaShell \? helperExe\(\) : null;/, 'only the installed app (not MSIX, not development)');
  assert.match(browser, /server: process\.execPath/, 'the app itself must serve the pipe');
});
