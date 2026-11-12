// API: settings as a file (#478) – export, import with a preview, the OneDrive question at the first start.

import { app, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from '../../../extension/core/i18n.js';
import { SETTINGS_FILE_NAME } from '../../settings-file.js';
import { smokeTest } from '../boot.js';
import { opened, win } from '../state.js';
import { api } from './index.js';
import { requireOpen } from '../guards.js';
import { refreshAll, send, signedIn } from '../session.js';
import { copyBlocked, exportContent, previewSettingsFile, setSettingsCopy, settingsCopyConsentDue, settingsCopyDecided, settingsCopyStatus, takeImport } from '../settings-copy.js';

// Smoke runs choose no file in a dialog: the test names it (a temporary folder, never a real one).
const testFile = () => (smokeTest && process.env.KVPWSAFE_TEST_SETTINGS_FILE) || null;

export const settingsFileApi = {
  /** Menu "Einstellungen exportieren…": save dialog, only the allowlisted settings. → the path, or null. */
  async exportSettings() {
    requireOpen();
    const { canceled, filePath } = testFile() ? { filePath: testFile() } : await dialog.showSaveDialog(win, {
      title: t('Einstellungen exportieren'),
      defaultPath: path.join(app.getPath('documents'), SETTINGS_FILE_NAME),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, exportContent());
    return filePath;
  },
  /** Menu "Einstellungen importieren…": file selection, checked strictly → the preview (nothing applied yet), or null. */
  async pickSettingsImport() {
    requireOpen();
    let file = testFile();
    if (!file) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: t('Einstellungen importieren'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths[0]) return null;
      file = filePaths[0];
    }
    try {
      return await previewSettingsFile(file);
    } catch {
      throw new Error(t('Die Datei ist keine gültige Keevault-Einstellungsdatei.'));
    }
  },
  /** First start: OneDrive there? Settings of another device in it? → { oneDrive, found, preview? }. */
  settingsCopyStatus: () => settingsCopyStatus(),
  /** Applies a preview the user confirmed (token from the preview; confirmed: the keys ticked there; vaults: the new vaults ticked). */
  async applySettingsImport(token, confirmed, vaults) {
    requireOpen();
    const patch = await takeImport(token, confirmed, vaults);
    if (!patch) throw new Error(t('Der Import ist abgelaufen – bitte die Datei erneut wählen.'));
    await api.updateSettings(patch);
    settingsCopyDecided();
    if (opened && signedIn()) await refreshAll().catch(() => null);
    send({ type: 'changed' });
    return true;
  },
  /** The question "copy in OneDrive?" is due (not answered yet, OneDrive there). */
  settingsCopyConsentDue: () => settingsCopyConsentDue(),
  /** The answer to that question, or the switch in Settings. */
  setSettingsCopy: (on) => setSettingsCopy(on === true),
  /** The folder the copy is not written to because it is a link, or ''. */
  settingsCopyBlocked: () => copyBlocked,
  /** First start: the question is answered without importing (or there was nothing to import). */
  settingsCopyDecided: () => {
    settingsCopyDecided();
    return true;
  },
};
