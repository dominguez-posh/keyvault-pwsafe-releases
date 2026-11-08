import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealApp, realKeevaultApps } from '../scripts/smoke-real-app.mjs';

// #346: the extension smoke stops only for the real app, not for the native messaging host, an agent's MCP server or
// Electron's child processes (all Keevault.exe).
const EXE = '"C:\\Program Files\\Keevault\\Keevault.exe"';

test('#346: only the main process of the app counts as the running app', () => {
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: EXE }), true);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: `${EXE} --hidden` }), true);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: '' }), true, 'command line unreadable: counts as the app');
  assert.equal(isRealApp({ name: 'KeyVault PwSafe.exe', commandLine: '"C:\\Program Files\\KeyVault PwSafe\\KeyVault PwSafe.exe"' }), true);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: `${EXE} "C:\\Users\\a\\AppData\\Roaming\\KeyVault PwSafe\\native-host\\host.cjs" chrome-extension://abc/` }), false);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: `${EXE} C:/Users/a/AppData/Roaming/KeyVault PwSafe/mcp/keevault-mcp.cjs` }), false);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: `${EXE} --type=renderer --user-data-dir=x` }), false);
  assert.equal(isRealApp({ name: 'Keevault.exe', commandLine: `${EXE} --type=gpu-process` }), false);
  assert.equal(isRealApp({ name: 'msedge.exe', commandLine: '"msedge.exe" --profile-directory=Default' }), false);
  assert.equal(isRealApp({ name: 'Keevault-Update.exe', commandLine: '"Keevault-Update.exe" --clipboard-clear' }), false);
});

test('#346: helpers alone (app closed) block nothing, the app beside them does', () => {
  const helpers = [
    { pid: 11, name: 'Keevault.exe', commandLine: `${EXE} "C:\\x\\native-host\\host.cjs" chrome-extension://abc/` },
    { pid: 12, name: 'Keevault.exe', commandLine: `${EXE} C:\\x\\mcp\\keevault-mcp.cjs` },
  ];
  assert.deepEqual(realKeevaultApps(helpers), []);
  assert.deepEqual(realKeevaultApps([...helpers, { pid: 13, name: 'Keevault.exe', commandLine: EXE }, { pid: 14, name: 'Keevault.exe', commandLine: `${EXE} --type=renderer` }]), [13]);
});
