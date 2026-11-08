// Is the real Keevault app running? The extension smoke must not run beside it (#346): the real extension could bring
// real account data into the test browser. Only the app itself counts: Keevault.exe also runs as the browser's native
// messaging host (native-host\host.cjs, started by Edge or Chrome), as the MCP server of an AI agent
// (mcp\keevault-mcp.cjs) and as Electron's child processes (--type=renderer, gpu-process, ...). Those run without an open
// app and never hold an unlocked vault, so they must not block the run (they are the same helpers as #351 in
// windows/Setup/HelperProcesses.cs).
import { execFileSync } from 'node:child_process';

const APP_EXE = /(^|[\\/])(keevault|keyvault pwsafe)\.exe$/i;
const HELPER_SCRIPT = /[\\/](native-host[\\/]host\.cjs|mcp[\\/]keevault-mcp\.cjs)\b/i;

/** { name, commandLine } of one process → is it the main process of the Keevault app? */
export function isRealApp({ name, commandLine }) {
  if (!APP_EXE.test(String(name || ''))) return false;
  const line = String(commandLine || '');
  if (/(^|\s)--type=/.test(line)) return false; // an Electron child process of some Keevault.exe
  if (HELPER_SCRIPT.test(line)) return false;
  return true;
}

/** Keevault.exe processes with their command lines (Windows); elsewhere no list. */
export function keevaultProcesses() {
  if (process.platform !== 'win32') return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='Keevault.exe' OR Name='KeyVault PwSafe.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  if (!out) return [];
  const list = JSON.parse(out);
  return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine || '' }));
}

/** The running real Keevault apps (process ids), or an empty list. */
export const realKeevaultApps = (list = keevaultProcesses()) => list.filter(isRealApp).map((p) => p.pid);

/** Ends the extension smoke with exit code 2 when the real app runs (#346). */
export function exitIfRealApp() {
  const apps = realKeevaultApps();
  if (!apps.length) return;
  console.error(`EXTENSION SMOKE SKIPPED: die Keevault-App läuft (PID ${apps.join(', ')}). Erst die App schließen (#346).`);
  process.exit(2);
}
