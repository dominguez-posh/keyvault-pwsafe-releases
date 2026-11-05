// The API of the main process: everything the renderer may call (window.pwsafe.invoke). The functions live in the
// files next to this one, by subject; a new function goes into the file of its subject and is covered by a smoke check.

import { ipcMain } from 'electron';
import { LockedError } from '../../auth.js';
import { adminApi } from './admin.js';
import { appApi } from './app.js';
import { backupApi } from './backup.js';
import { filesApi } from './files.js';
import { foldersApi } from './folders.js';
import { integrationsApi } from './integrations.js';
import { itemsApi } from './items.js';
import { reportsApi } from './reports.js';
import { vaultsApi } from './vaults.js';
import { lockNow } from '../session.js';

export const api = {
  ...appApi,
  ...vaultsApi,
  ...itemsApi,
  ...filesApi,
  ...foldersApi,
  ...backupApi,
  ...adminApi,
  ...integrationsApi,
  ...reportsApi,
};

ipcMain.handle('api', async (event, method, args) => {
  if (!event.senderFrame?.url.startsWith('app://pwsafe/')) return { ok: false, error: { message: 'Nicht erlaubt' } };
  const fn = Object.hasOwn(api, method) ? api[method] : null;
  if (!fn) return { ok: false, error: { message: `Unknown function ${method}` } };
  try {
    return { ok: true, result: await fn(...(Array.isArray(args) ? args : [])) };
  } catch (e) {
    if (e instanceof LockedError && method !== 'unlock') await lockNow();
    return { ok: false, error: { name: e.name, message: e.message, status: e.status } };
  }
});
