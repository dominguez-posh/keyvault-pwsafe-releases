// Smoke check for the PowerShell fallback of auto-type (#352): it compiles and its key plan (real keys with scan
// codes for remote windows, #332) is right. Types nothing, opens no window; skipped under Constrained Language Mode.

import { execFile } from 'node:child_process';
import { SOURCE } from './autotype.js';

export async function autotypeFallbackCheck(fail) {
  if (process.platform !== 'win32') return;
  const script = `Add-Type -TypeDefinition @'\n${SOURCE}\n'@\n[Console]::Out.WriteLine('selftest ' + [KvAutoType]::SelfTest())`;
  const out = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true }, (e, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
  if (/language mode|Cannot add type/i.test(out)) return;
  if (!/selftest ok/.test(out)) fail('autotype', `PowerShell fallback key plan: ${out.trim().slice(0, 200)}`);
}
