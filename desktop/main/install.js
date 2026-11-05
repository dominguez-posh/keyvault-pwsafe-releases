// Detects a second installation of the app (MSI next to the per-user setup).

import { app } from 'electron';
import path from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';

/**
 * A second copy installed another way – the per-machine MSI next to the per-user EXE or the other way round. Both
 * appear as "Keevault" in the Start menu and only one of them is kept up to date, so people end up in an old version.
 * Returns { dir, version, kind } of the other copy, or null.
 */
export async function otherInstallation() {
  if (process.platform !== 'win32' || !app.isPackaged) return null;
  const own = path.dirname(process.execPath).toLowerCase().replace(/\\+$/, '');
  const machineDir = await new Promise((resolve) => {
    execFileCb('reg', ['query', 'HKLM\\Software\\Keevault', '/v', 'InstallDir'], { windowsHide: true }, (err, out) => {
      resolve(err ? null : (/InstallDir\s+REG_SZ\s+(.+)/i.exec(String(out))?.[1] || '').trim() || null);
    });
  });
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    machineDir && { dir: machineDir, kind: 'msi' },
    { dir: path.join(local, 'Programs', 'KeyVault PwSafe', 'Keevault'), kind: 'nsis' },
    { dir: path.join(local, 'Programs', 'Keevault'), kind: 'nsis' },
  ].filter(Boolean);
  for (const c of candidates) {
    const dir = c.dir.replace(/[\\/]+$/, '');
    if (dir.toLowerCase() === own) continue;
    try {
      if (!statSync(path.join(dir, 'Keevault.exe')).isFile()) continue;
    } catch {
      continue;
    }
    let version = '';
    try {
      // Electron reads into app.asar like a folder.
      version = JSON.parse(readFileSync(path.join(dir, 'resources', 'app.asar', 'package.json'), 'utf8')).version || '';
    } catch {
      // unknown version
    }
    return { dir, version, kind: c.kind };
  }
  return null;
}
