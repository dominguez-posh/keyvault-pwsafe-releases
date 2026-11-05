// API: encrypted backup and restore (owners of the subscription).

import { dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { t } from '../../../extension/core/i18n.js';
import { BACKUP_EXTENSION, createBackup, generateBackupPassword, openBackup, readBackupHeader } from '../../../extension/core/backup.js';
import { vault, win } from '../state.js';
import { backupSheetHtml, lastBackup, pendingRestore, printHtml, setLastBackup, setPendingRestore } from '../backup.js';
import { requireOpen, requireSubscriptionOwner } from '../guards.js';
import { actor, changed, send } from '../session.js';

export const backupApi = {
  // Encrypted backups: only for owners of the vault's subscription. The password is generated here, handed to the
  // renderer once for display/printing and forgotten when the dialog closes.
  backupAllowed: async (containerId) => {
    try {
      await requireSubscriptionOwner(containerId);
      return { allowed: true };
    } catch (e) {
      return { allowed: false, reason: e.message };
    }
  },
  async createBackup(containerId) {
    requireOpen();
    const c = await requireSubscriptionOwner(containerId);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Backup speichern'),
      defaultPath: `${String(c.name || 'Tresor').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXTENSION}`,
      filters: [{ name: t('Keevault-Backup'), extensions: [BACKUP_EXTENSION] }],
    });
    if (canceled || !filePath) return null;
    const data = await vault.backupSecrets(containerId, (done, total) => send({ type: 'progress', done, total }));
    const password = generateBackupPassword();
    const content = await createBackup({ ...data, password, createdBy: actor() });
    await fs.writeFile(filePath, content, 'utf8');
    setLastBackup({ password, vault: c.id, name: c.name, file: path.basename(filePath), created: JSON.parse(content).created, count: data.secrets.length, by: actor() });
    return { ...lastBackup, filePath };
  },
  async printBackupSheet() {
    if (!lastBackup) throw new Error(t('Das Passwort wurde bereits verworfen'));
    await printHtml(backupSheetHtml(lastBackup));
    return true;
  },
  forgetBackupPassword() {
    setLastBackup(null);
    return true;
  },
  async chooseBackupFile(containerId) {
    requireOpen();
    await requireSubscriptionOwner(containerId);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('Backup öffnen'),
      filters: [{ name: t('Keevault-Backup'), extensions: [BACKUP_EXTENSION] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const text = await fs.readFile(filePaths[0], 'utf8');
    const header = readBackupHeader(text);
    setPendingRestore({ containerId, text });
    return { ...header, file: path.basename(filePaths[0]) };
  },
  async restoreBackup(containerId, password) {
    requireOpen();
    await requireSubscriptionOwner(containerId);
    if (!pendingRestore || pendingRestore.containerId !== containerId) throw new Error(t('Bitte die Backup-Datei erneut auswählen'));
    const { header, secrets } = await openBackup(pendingRestore.text, password);
    const r = await vault.restoreSecrets(containerId, { vault: header.vault, secrets, isProtected: header.protected }, (done, total) => send({ type: 'progress', done, total }));
    setPendingRestore(null);
    changed();
    return r;
  },
};
