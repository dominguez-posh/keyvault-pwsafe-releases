// Smoke check for the PowerShell fallback of auto-type (#352): it compiles and its key plan (real keys with scan
// codes for remote windows, #332) is right. Types nothing, opens no window; skipped under Constrained Language Mode.
// #526: Windows PowerShell started with -EncodedCommand writes progress and errors to stderr as CLIXML ("#< CLIXML"
// followed by XML) – the verdict reads only the marker line on stdout and says why it is missing (error or timeout).

import { execFile } from 'node:child_process';
import { SOURCE } from './autotype.js';

const TIMEOUT_MS = 60_000;

const script = `$ProgressPreference = 'SilentlyContinue'
try { Add-Type -TypeDefinition @'\n${SOURCE}\n'@ -ErrorAction Stop } catch { [Console]::Out.WriteLine('selftest error ' + $_.Exception.Message); exit 1 }
[Console]::Out.WriteLine('selftest ' + [KvAutoType]::SelfTest())`;

/**
 * → null when the check passed or cannot run here (Constrained Language Mode), else what went wrong.
 * stdout/stderr as PowerShell wrote them, error from execFile (killed on timeout), ms how long it took.
 */
export function fallbackVerdict({ stdout = '', stderr = '', error = null, ms = 0 }) {
  if (/language mode|Cannot add type/i.test(`${stdout}${stderr}`)) return null;
  const line = String(stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('selftest '));
  if (line === 'selftest ok') return null;
  if (line) return line.slice('selftest '.length).slice(0, 300);
  if (error?.killed) return `no answer from PowerShell within ${Math.round(ms / 1000)} s (compiling the C# part)`;
  // Neither marker nor timeout: the first readable text, without the CLIXML wrapper of PowerShell 5.1.
  const text = String(stderr).replace(/^#< CLIXML\s*/, '').replace(/<Obj S="progress"[\s\S]*?<\/Obj>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/_x000D__x000A_/g, ' ').replace(/\s+/g, ' ').trim();
  return `no result after ${Math.round(ms / 1000)} s (exit ${error?.code ?? 0})${text ? `: ${text.slice(0, 300)}` : ''}`;
}

export async function autotypeFallbackCheck(fail) {
  if (process.platform !== 'win32') return;
  const started = Date.now();
  const verdict = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => resolve(fallbackVerdict({ stdout, stderr, error, ms: Date.now() - started })));
  });
  if (verdict) fail('autotype', `PowerShell fallback key plan: ${verdict}`);
}
