// #511 hardening (Konrad's review of #505/#511): the relay (Keevault-Update.exe, windows/Setup/NativeHost.cs) opens the
// app's pipe with impersonation level Identification only, and takes the pipe only from a process that has the app's
// image path AND runs as this user in this session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));
const win = process.platform === 'win32';
const skip = !win || !existsSync(exe);
let n = 0;
const pipeName = () => `kv511h-${process.pid}-${++n}`;

/** A pipe server in this Node process (the stand-in for the app: same user, same session, image = node.exe). */
async function nodePipe() {
  const name = pipeName();
  const server = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => server.listen(`\\\\.\\pipe\\${name}`, r));
  return { name, close: () => new Promise((r) => server.close(r)) };
}

/** The relay's check of the other end, as --pipe-peer prints it. → { status, out } */
function peer(name, server, extra = []) {
  const r = spawnSync(exe, ['--pipe-peer', name, '--server', server, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const fields = Object.fromEntries(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: r.status, ...fields, stderr: r.stderr };
}

const ownSid = () => (win ? execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[\d-]+/)[0] : '');

test('#511 relay check: path, user and session of the pipe server are read and must all match', { skip }, async () => {
  const app = await nodePipe();
  try {
    const ok = peer(app.name, process.execPath);
    assert.equal(ok.status, 0, `the app itself is taken: ${JSON.stringify(ok)}`);
    assert.equal(ok.sid, ownSid(), 'the server process\'s user SID is read (TokenUser)');
    assert.match(ok.session, /^\d+$/, 'the server session is read (GetNamedPipeServerSessionId)');
    assert.equal(ok.refused, '');

    const otherUser = peer(app.name, process.execPath, ['--expect-sid', 'S-1-5-21-1-2-3-1001']);
    assert.equal(otherUser.status, 2, 'right path, another user: refused');
    assert.equal(otherUser.refused, 'user');

    const otherSession = peer(app.name, process.execPath, ['--expect-session', String(Number(ok.session) + 7)]);
    assert.equal(otherSession.status, 2, 'right path and user, another session: refused');
    assert.equal(otherSession.refused, 'session');

    const otherPath = peer(app.name, 'C:\\Program Files\\Keevault\\Keevault.exe');
    assert.equal(otherPath.status, 2, 'another program: refused as before (#505)');
    assert.equal(otherPath.refused, 'path');
  } finally {
    await app.close();
  }
});

test('#511 relay: the connect loop uses the same check with this user\'s SID and session', () => {
  const src = readFileSync(fileURLToPath(new URL('../windows/Setup/NativeHost.cs', import.meta.url)), 'utf8');
  const loop = src.slice(src.indexOf('private static void ConnectLoop()'), src.indexOf('private static void ReadPipe('));
  assert.match(loop, /Refusal\(PeerOf\(s\.SafePipeHandle\.DangerousGetHandle\(\)\), server, OwnSid\(\), OwnSession\(\)\)/);
  assert.match(loop, /ok = refusal == null;/);
});

/**
 * #511: the relay connects with impersonation level Identification. A PowerShell pipe server stands in for the app
 * (the relay is told it is the app) and impersonates the client after its first line: with Identification it may
 * only identify it, never act as it.
 */
test('#511 relay: the app\'s end can identify the browser\'s user, not impersonate it', { skip, timeout: 60_000 }, async () => {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const dir = mkdtempSync(join(tmpdir(), 'kv511h-'));
  const name = pipeName();
  const script = join(dir, 'server.ps1');
  writeFileSync(script, [
    'param($name)',
    '$s = New-Object System.IO.Pipes.NamedPipeServerStream($name, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None)',
    '[Console]::Out.WriteLine("up"); [Console]::Out.Flush()',
    '$s.WaitForConnection()',
    '$r = New-Object System.IO.StreamReader($s)',
    '$null = $r.ReadLine()',
    '$level = [ref]"none"',
    'try { $s.RunAsClient({ $level.Value = [System.Security.Principal.WindowsIdentity]::GetCurrent($true).ImpersonationLevel.ToString() }) } catch { $level.Value = "error" }',
    '[Console]::Out.WriteLine("level=" + $level.Value); [Console]::Out.Flush()',
    '$s.Dispose()',
  ].join('\r\n'));
  const server = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  server.stdout.setEncoding('utf8');
  const level = new Promise((resolve) => server.stdout.on('data', (d) => { out += d; const m = out.match(/level=(\w+)/); if (m) resolve(m[1]); }));
  const relay = spawn(exe, ['--native-host', '--pipe', `\\\\.\\pipe\\${name}`, '--server', ps, '--launch', 'none', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, KV_RELAY_OPTIONS: join(dir, 'none.txt') } });
  let serverErr = '';
  let relayErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  relay.stderr.on('data', (d) => { relayErr += d; });
  try {
    await new Promise((r) => { const on = () => { if (out.includes('up')) r(); else server.stdout.once('data', on); }; on(); });
    // Only once the relay is online: in between a request is answered "offline" at once and never reaches the pipe.
    let fromRelay = '';
    await new Promise((r) => { relay.stdout.on('data', (d) => { fromRelay += d.toString('latin1'); if (fromRelay.includes('"online"')) r(); }); });
    const json = Buffer.from(JSON.stringify({ id: 1, cmd: 'hello', origin: '' }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length, 0);
    relay.stdin.write(Buffer.concat([len, json]));
    const got = await Promise.race([level, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
    assert.equal(got, 'Identification', `impersonation level the app's end gets: ${got} (server: ${out.trim()} ${serverErr.trim()}; relay: ${relayErr.trim()})`);
  } finally {
    relay.kill();
    server.kill();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* cleaned later */ }
  }
});
