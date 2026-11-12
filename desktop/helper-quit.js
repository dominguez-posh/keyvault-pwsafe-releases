// #513: the browser's and the AI agents' connections (native-host\host.cjs, mcp\keevault-mcp.cjs) run Keevault.exe from
// the installation folder and never end by themselves, so an update had to end them – and "Zugriff verweigert" in
// update.log came from ending processes that were exiting already. Before an update Keevault-Update.exe writes a signal
// file (windows/Setup/UpdateWait.cs); the generated scripts check it every second and quit cleanly when it is newer
// than their own start. An old signal from an earlier update is ignored.

import os from 'node:os';
import path from 'node:path';

/** %LOCALAPPDATA%\keyvault-pwsafe-updater\quit-helpers – the same file as UpdateWait.SignalFile(). */
export function quitSignalFile(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'keyvault-pwsafe-updater', 'quit-helpers');
}

/** The lines the generated helper scripts carry (CommonJS, no dependencies). */
export function quitWatch(file = quitSignalFile()) {
  return [
    '// #513: an update asks this connection to quit (Keevault-Update.exe writes the file): it ends cleanly by itself.',
    '(() => {',
    "  const fs = require('fs');",
    `  const QUIT = ${JSON.stringify(file)};`,
    '  const started = Date.now();',
    '  setInterval(() => {',
    '    fs.stat(QUIT, (err, st) => { if (!err && st.mtimeMs > started) process.exit(0); });',
    '  }, 1000).unref();',
    '})();',
    '',
  ].join('\n');
}
