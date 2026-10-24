// Network for everything that carries secrets or tokens (Entra ID, Key Vault, Resource Manager, Graph, updates):
// an in-memory session, so Chromium never writes these responses to a disk cache, plus "no-store" on every request.
// Versions before 0.6.1 used the default session, whose HTTP cache on disk could hold Key Vault responses –
// purgeDiskCaches() removes those caches before Chromium opens them.

import { app, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const PARTITION = 'keevault-net'; // without "persist:" → memory only

export function secureFetch(url, init = {}) {
  return session.fromPartition(PARTITION).fetch(url, { ...init, cache: 'no-store' });
}

/** Before app "ready": HTTP caches of this and earlier profile folders (product renames, development). */
export function purgeDiskCaches() {
  const appData = app.getPath('appData');
  const dirs = new Set([app.getPath('userData'), ...['KeyVault PwSafe', 'Keevault', 'keyvault-pwsafe'].map((d) => path.join(appData, d))]);
  for (const dir of dirs) {
    try {
      fs.rmSync(path.join(dir, 'Cache'), { recursive: true, force: true });
    } catch {
      // In use by a second instance: cleared again on its next start.
    }
  }
}
