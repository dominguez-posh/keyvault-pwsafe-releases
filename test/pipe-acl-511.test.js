// #511: the app's pipe. Its own access list (current user only, nobody over the network) instead of Node's default
// (read for Everyone and anonymous, full for SYSTEM and administrators), and a name another process holds already means
// no server at all (Node creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE), noted in the diagnosis log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { BrowserBridge, protectPipe } from '../desktop/bridge.js';

const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));
const win = process.platform === 'win32';
const skip = !win || !existsSync(exe);
let n = 0;
const testPipe = () => `\\\\.\\pipe\\kv511-test-${process.pid}-${++n}`;
const sddl = (pipe) => execFileSync(exe, ['--pipe-acl-show', pipe], { encoding: 'utf8', windowsHide: true }).trim();

/** One request over the pipe like a host does: hello, answered by the bridge. */
function hello(pipe) {
  return new Promise((resolve, reject) => {
    const c = net.connect(pipe, () => c.write(`${JSON.stringify({ id: 1, cmd: 'hello', origin: 'chrome-extension://x/' })}\n`));
    c.setEncoding('utf8');
    c.once('data', (d) => { c.destroy(); resolve(JSON.parse(d.split('\n')[0])); });
    c.on('error', reject);
  });
}

test('#511: the pipe gets its own access list – current user only, network denied – and still works', { skip }, async () => {
  const pipe = testPipe();
  const bridge = new BrowserBridge({ path: pipe, handlers: { hello: () => 'hi' }, approve: async () => true });
  await bridge.start();
  try {
    assert.match(sddl(pipe), /\(A;;FR;;;WD\)/, 'before: Node\'s default list lets Everyone read (what the fix replaces)');
    const logs = [];
    assert.equal(await protectPipe(pipe, exe, (l) => logs.push(l)), true);
    assert.match(logs[0], /BRIDGE pipe ACL set/);
    const after = sddl(pipe);
    assert.match(after, /^D:P\(D;;[^;]+;;;NU\)\(A;;[^;]+;;;S-1-5-21-[\d-]+\)$/, `protected list: deny network, allow one user (${after.replace(/S-1-5-21-[\d-]+/, 'S-1-5-21-…')})`);
    assert.doesNotMatch(after, /;;;(WD|AN|BA|SY)\)/, 'no Everyone, anonymous, administrators or SYSTEM');
    for (let i = 0; i < 5; i++) assert.equal((await hello(pipe)).result, 'hi', 'the app answers as before');
    assert.equal(sddl(pipe), after, 'the list holds for the instances Node creates later');
  } finally {
    bridge.stop();
  }
});

test('#511: a pipe name another process holds already: the app gets no server (no second instance beside it)', { skip: !win }, async () => {
  const pipe = testPipe();
  const squatter = spawn(process.execPath, ['-e', `require('net').createServer(() => {}).listen(${JSON.stringify(pipe)}, () => console.log('up')); setTimeout(() => {}, 20000)`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((r) => squatter.stdout.once('data', r));
    const bridge = new BrowserBridge({ path: pipe, handlers: {}, approve: async () => true });
    await assert.rejects(bridge.start(), { code: 'EADDRINUSE' });
  } finally {
    squatter.kill();
  }
});

test('#511: without the helper the list is not set, and the log says so', async () => {
  const logs = [];
  assert.equal(await protectPipe('\\\\.\\pipe\\x', null, (l) => logs.push(l)), !win);
  if (win) assert.match(logs[0], /BRIDGE pipe ACL not set: Keevault-Update\.exe missing/);
});

test('#511: the app logs a held pipe name, starts no server and sets the list after a successful start', () => {
  const src = readFileSync(fileURLToPath(new URL('../desktop/main/browser.js', import.meta.url)), 'utf8');
  const start = src.slice(src.indexOf('const server = new BrowserBridge'), src.indexOf('await protectPipe(server.path'));
  assert.match(start, /catch \(e\) \{[\s\S]*diag\(`BRIDGE no pipe server: [\s\S]*return;\s*\}\s*setBridge\(server\);/, 'no server on failure, logged');
  assert.match(src, /await protectPipe\(server\.path, helperExe\(\), diag, server\);/, 'the bridge is passed, so early connections are closed');
});

test('#511 review: connections accepted before the list was set are closed once it is; later ones work', { skip }, async () => {
  const pipe = testPipe();
  const bridge = new BrowserBridge({ path: pipe, handlers: { hello: () => 'hi' }, approve: async () => true });
  await bridge.start();
  try {
    // Someone the default list let in, already approved (hello answered) before the list is set.
    const early = net.connect(pipe);
    early.setEncoding('utf8');
    early.on('error', () => {});
    const closed = new Promise((r) => early.once('close', r));
    const first = new Promise((r) => early.once('data', r));
    early.write(`${JSON.stringify({ id: 1, cmd: 'hello', origin: 'chrome-extension://x/' })}\n`);
    assert.match(await first, /"result":"hi"/);
    const logs = [];
    assert.equal(await protectPipe(pipe, exe, (l) => logs.push(l), bridge), true);
    await Promise.race([closed, new Promise((_, no) => setTimeout(() => no(new Error('early connection still open')), 5000))]);
    assert.ok(logs.some((l) => /BRIDGE closed [1-9]\d* connection\(s\) accepted before the pipe ACL was set/.test(l)), logs.join(' | '));
    assert.equal(bridge.clients.size, 0);
    assert.equal((await hello(pipe)).result, 'hi', 'a new connection after the list is answered');
  } finally {
    bridge.stop();
  }
});
