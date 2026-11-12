// Starts the desktop app. Removes ELECTRON_RUN_AS_NODE, which VS Code sets for its terminals and which
// would make Electron behave like plain Node.js. For --smoke-test runs, all main-process modules are first
// parsed with Electron's own engine: a syntax error would otherwise pop up an error dialog on the desktop.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { onlyProblem } from '../desktop/smoke-areas.js';
import { helperExeProblem } from './helper-exe-fresh.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);

const problem = onlyProblem(args);
if (problem) {
  console.error(`SMOKE FAIL: ${problem}`);
  process.exit(1);
}
const { default: electron } = await import('electron');

if (args.includes('--smoke-test')) {
  // #526: the clipboard and typing checks run through windows/out/Keevault-Update.exe – never with a stale one.
  const stale = helperExeProblem(root);
  if (stale) {
    console.error(`SMOKE FAIL: ${stale}`);
    process.exit(1);
  }
  // desktop with its subfolders (main/, main/api/, passkey/) – without the window's own code (renderer/), which
  // the main process never loads.
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'renderer' ? [] : walk(p)) : [p];
  });
  const files = ['desktop', 'extension/core'].flatMap((d) => walk(join(root, d))).filter((f) => /\.(m|c)?js$/.test(f));
  const failed = files.filter((file) => {
    const r = spawnSync(electron, ['--check', file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    if (r.status !== 0) console.error(r.stderr.split('\n').filter((l) => !/NODE_TLS|trace-warnings/.test(l)).slice(0, 6).join('\n'));
    return r.status !== 0;
  });
  if (failed.length) {
    console.error(`SMOKE FAIL: syntax errors in ${failed.length} file(s), app not started`);
    process.exit(1);
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// #517: the demo smoke run starts with TLS switched off from the environment and a TLS key log; the app must ignore
// both (desktop/smoke-tls-env.js checks it). The key log file must stay empty.
if (args.includes('--smoke-test') && args.includes('--demo')) {
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  env.KVPWSAFE_SMOKE_KEYLOG = env.SSLKEYLOGFILE = join(tmpdir(), `kvpwsafe-smoke-keylog-${process.pid}.txt`);
}
const child = spawn(electron, ['.', ...args], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
