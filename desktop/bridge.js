// Browser integration for file containers (like KeePassXC-Browser): the extension talks native messaging to a
// small host process, which relays to this app over a named pipe (Windows) or Unix socket. Only extension IDs in
// the host manifest can start the host; each browser has to be approved once in the app.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const HOST_NAME = 'com.kvpwsafe.desktop';
// Firefox identifies extensions by their gecko ID (manifest browser_specific_settings), not by an origin.
export const GECKO_ID = 'keevault@keevault.de';
const run = promisify(execFile);

// Program to start from outside the app (browser launcher, passkey provider). The MSIX's Keevault.exe under
// WindowsApps can't be started directly from outside the package, only via its execution alias.
export const launchPath = () => (process.windowsStore
  ? path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'keevault.exe')
  : process.execPath);

// KVPWSAFE_DEV_PIPE: development runs (not packaged, set by main.js) use their own pipe – otherwise a dev instance
// started from the repository takes over the pipe of the installed app and answers its browser extension and AI
// agents with its own (empty) approvals.
export function pipePath(userData) {
  const dev = process.env.KVPWSAFE_DEV_PIPE ? '-dev' : '';
  if (process.platform === 'win32') return `\\\\.\\pipe\\kvpwsafe-${os.userInfo().username.replace(/[^\w.-]/g, '_')}${dev}`;
  return path.join(userData, 'bridge.sock');
}

// Host process, started by the browser via the launcher with ELECTRON_RUN_AS_NODE=1. It lives as long as the
// extension keeps its port open: while the app is not running it says so ("offline"), answers requests at once with
// AppOffline and connects as soon as the app is back ("online"). "launch" starts the app.
// launch: { cmd, args } – how to start the app (packaged: the exe or the MSIX alias; development: electron + folder).
export const hostScript = (pipe, launch = { cmd: process.execPath, args: [] }) => HOST_SCRIPT
  .replace('__PIPE__', JSON.stringify(pipe))
  .replace('__LAUNCH__', JSON.stringify(launch));

const HOST_SCRIPT = `// Keevault native messaging host (generated). Relays between the browser and the desktop app.
const net = require('net');
const { spawn } = require('child_process');
const PIPE = __PIPE__;
const LAUNCH = __LAUNCH__;
const RETRY_MS = 1500;
const origin = process.argv.find((a) => a.startsWith('chrome-extension://')) || process.argv.find((a) => /^[\w.-]+@[\w.-]+$/.test(a)) || '';
let socket = null;
let state = 'unknown';
let input = Buffer.alloc(0);
const waiting = [];
function send(msg) {
  const json = Buffer.from(JSON.stringify(msg));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}
const offlineReply = (msg) => send({ id: msg.id, ok: false, error: { name: 'AppOffline', message: 'Keevault is not running' } });
function launch() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(LAUNCH.cmd, LAUNCH.args, { detached: true, stdio: 'ignore', env, windowsHide: false }).unref();
}
function connect() {
  const s = net.connect(PIPE);
  let lines = '';
  let done = false;
  s.setEncoding('utf8');
  s.on('connect', () => {
    socket = s;
    state = 'online';
    send({ event: 'online' });
    for (const m of waiting.splice(0)) s.write(JSON.stringify(m) + '\\n');
  });
  s.on('data', (d) => {
    lines += d;
    let i;
    while ((i = lines.indexOf('\\n')) >= 0) {
      const line = lines.slice(0, i);
      lines = lines.slice(i + 1);
      if (line) send(JSON.parse(line));
    }
  });
  const lost = () => {
    if (done) return;
    done = true;
    if (socket === s) socket = null;
    if (state !== 'offline') {
      state = 'offline';
      send({ event: 'offline' });
      for (const m of waiting.splice(0)) offlineReply(m);
    }
    setTimeout(connect, RETRY_MS);
  };
  s.on('error', lost);
  s.on('close', lost);
}
function forward(msg) {
  if (!msg) return;
  if (msg.cmd === 'launch') {
    try {
      launch();
      send({ id: msg.id, ok: true, result: true });
    } catch (e) {
      send({ id: msg.id, ok: false, error: { name: 'Error', message: e.message } });
    }
    return;
  }
  if (msg.cmd === 'hello') msg.origin = origin;
  if (socket) socket.write(JSON.stringify(msg) + '\\n');
  else if (state === 'unknown') waiting.push(msg);
  else offlineReply(msg);
}
connect();
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const len = input.readUInt32LE(0);
    if (input.length < 4 + len) break;
    forward(JSON.parse(input.subarray(4, 4 + len).toString('utf8')));
    input = input.subarray(4 + len);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function browserDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts')];
  }
  return [path.join(home, '.config/google-chrome/NativeMessagingHosts'), path.join(home, '.config/microsoft-edge/NativeMessagingHosts'),
    path.join(home, '.config/chromium/NativeMessagingHosts')];
}

const REGISTRY = ['HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'];
const FIREFOX_REGISTRY = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts';
const firefoxDir = () => (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts')
  : path.join(os.homedir(), '.mozilla/native-messaging-hosts'));

/** Writes host script, launcher and manifest and registers them for Edge and Chrome (current user only). */
export async function registerNativeHost({ userData, extensionIds, launch }) {
  const dir = path.join(userData, 'native-host');
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'host.cjs');
  await fs.writeFile(script, hostScript(pipePath(userData), launch));
  let launcher;
  if (process.platform === 'win32') {
    launcher = path.join(dir, 'host.cmd');
    await fs.writeFile(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${launchPath()}" "${script}" %*\r\n`);
  } else {
    launcher = path.join(dir, 'host.sh');
    await fs.writeFile(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const manifest = {
    name: HOST_NAME,
    description: 'Keevault',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const manifestPath = path.join(dir, `${HOST_NAME}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  // Firefox: same host, own manifest format (allowed_extensions with gecko IDs).
  const firefoxManifest = { name: HOST_NAME, description: 'Keevault', path: launcher, type: 'stdio', allowed_extensions: [GECKO_ID] };
  const firefoxManifestPath = path.join(dir, `${HOST_NAME}.firefox.json`);
  await fs.writeFile(firefoxManifestPath, JSON.stringify(firefoxManifest, null, 2));
  if (process.platform === 'win32') {
    for (const key of REGISTRY) await run('reg', ['add', `${key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
    await run('reg', ['add', `${FIREFOX_REGISTRY}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', firefoxManifestPath, '/f'], { windowsHide: true }).catch(() => {});
  } else {
    for (const d of browserDirs()) {
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
    }
    await fs.mkdir(firefoxDir(), { recursive: true });
    await fs.writeFile(path.join(firefoxDir(), `${HOST_NAME}.json`), JSON.stringify(firefoxManifest, null, 2));
  }
}

export async function unregisterNativeHost() {
  if (process.platform === 'win32') {
    for (const key of [...REGISTRY, FIREFOX_REGISTRY]) await run('reg', ['delete', `${key}\\${HOST_NAME}`, '/f'], { windowsHide: true }).catch(() => {});
  } else {
    for (const d of [...browserDirs(), firefoxDir()]) await fs.rm(path.join(d, `${HOST_NAME}.json`), { force: true });
  }
}

/**
 * Pipe server. handlers: { [cmd]: (args) => result }, approve(origin) → Promise<boolean>.
 * Protocol: newline-delimited JSON { id, cmd, ...args } → { id, ok, result | error }; events { event }.
 */
export class BrowserBridge {
  constructor({ userData, handlers, approve, path: pipe }) {
    this.path = pipe || pipePath(userData);
    this.handlers = handlers;
    this.approve = approve;
    this.clients = new Set();
    this.server = null;
  }

  async start() {
    if (this.server) return;
    if (process.platform !== 'win32') await fs.rm(this.path, { force: true });
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, resolve);
    });
  }

  stop() {
    for (const c of this.clients) c.socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  broadcast(event) {
    for (const c of this.clients) if (c.approved) c.socket.write(`${JSON.stringify({ event })}\n`);
  }

  accept(socket) {
    const client = { socket, approved: false, origin: '' };
    this.clients.add(client);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line) this.handle(client, line);
      }
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  async handle(client, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (body) => client.socket.write(`${JSON.stringify({ id: msg.id, ...body })}\n`);
    try {
      if (msg.cmd === 'hello') {
        client.origin = String(msg.origin || '');
        client.approved = await this.approve(client.origin);
        if (!client.approved) {
          reply({ ok: false, error: { name: 'NotApproved', message: 'Browser not approved in Keevault' } });
          return;
        }
      }
      if (!client.approved) {
        reply({ ok: false, error: { name: 'NotApproved', message: 'hello first' } });
        return;
      }
      const handler = this.handlers[msg.cmd];
      if (!handler) throw new Error(`Unknown command ${msg.cmd}`);
      reply({ ok: true, result: await handler(msg, client) });
    } catch (e) {
      reply({ ok: false, error: { name: e.name, message: e.message } });
    }
  }
}
