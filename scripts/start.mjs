// Starts the desktop app. Removes ELECTRON_RUN_AS_NODE, which VS Code sets for its terminals and which
// would make Electron behave like plain Node.js. For --smoke-test runs, all main-process modules are first
// parsed with Electron's own engine: a syntax error would otherwise pop up an error dialog on the desktop.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--smoke-test')) {
  const dirs = ['desktop', 'desktop/passkey', 'extension/core'];
  const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => /\.(m|c)?js$/.test(f)).map((f) => join(root, d, f)));
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
const child = spawn(electron, ['.', ...args], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
