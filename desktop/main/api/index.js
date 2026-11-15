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
import { releaseApi } from './release.js';
import { reportsApi } from './reports.js';
import { settingsFileApi } from './settings-file.js';
import { vaultsApi } from './vaults.js';
import { loggingApi } from './logging.js';
import { complianceApi } from './compliance.js';
import { vaultSettingsApi } from './vault-settings.js';
import { windowHelloApi } from './window-hello.js';
import { unlockApi } from './unlock.js';
import { lockNow } from '../session.js';
import { windowLocked } from '../state.js';
import { t } from '../../../extension/core/i18n.js';
import { diag } from '../diag.js';
import { maskForLog, uiMessage } from '../../../extension/core/azure-errors.js';

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
  ...releaseApi,
  ...settingsFileApi,
  ...loggingApi,
  ...complianceApi,
  ...vaultSettingsApi,
  ...windowHelloApi,
  ...unlockApi,
};

/**
 * #507: what the window may call while the session is open for the browser extension only – the lock screen and what it
 * offers (PIN, unlock, lock, language, updates, answers to open questions, Windows requests), nothing that reads vaults.
 * #512: unlockWithHello – Windows Hello, asked and checked by the main process; it lifts only the window lock.
 */
export const WINDOW_LOCKED_API = new Set(['state', 'verifyPin', 'unlock', 'lock', 'signOut', 'updateSettings', 'log', 'titleBarDim', 'updateState',
  'checkForUpdates', 'installUpdate', 'openExternal', 'otherInstallation', 'openAppsSettings', 'answerQuestion', 'windowsRequests', 'windowsDecision',
  'unlockWithHello',
  // #537 stage 6: the reset needs the recovery stick's PRF (equal to the master password); then `unlock` lifts the lock.
  'stickResetAvailable', 'resetMasterPasswordWithStick']);

/** Refused while the window is locked alone: the session stays open for the extension (no lockNow). */
export const windowLockedRefusal = (method) => (windowLocked && !WINDOW_LOCKED_API.has(method)
  ? { ok: false, error: { name: 'WindowLocked', message: t('Das Fenster ist gesperrt – bitte mit der PIN entsperren') } }
  : null);

ipcMain.handle('api', async (event, method, args) => {
  if (!event.senderFrame?.url.startsWith('app://pwsafe/')) return { ok: false, error: { message: 'Nicht erlaubt' } };
  const fn = Object.hasOwn(api, method) ? api[method] : null;
  if (!fn) return { ok: false, error: { message: `Unknown function ${method}` } };
  const refused = windowLockedRefusal(method);
  if (refused) return refused;
  try {
    const list = Array.isArray(args) ? args : [];
    // #537 2b (Konrad M1): an entry just written leaves sealed when its vault has "Immer bestätigen" (access.js).
    return { ok: true, result: await (await import('../access.js')).answerFor('window', method, list, await fn(...list)) };
  } catch (e) {
    if (e instanceof LockedError && method !== 'unlock') await lockNow();
    // Raw Azure/Graph text (subscription, resource group, object ID, UPN) never reaches the window: log only, masked.
    if (e?.name === 'AzureError') diag(`AZURE ${method} ${e.status} ${e.code || ''} ${maskForLog(e.message)}`);
    return { ok: false, error: { name: e.name, message: uiMessage(e), status: e.status, ...(e.name === 'FreshProofRequired' ? { purpose: e.purpose } : {}), ...(e.name === 'AccessConfirmRequired' ? { access: e.access } : {}) } };
  }
});
