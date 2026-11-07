// API: file vaults and the personal vault, extra protection (password, passkeys), members of secured files.

import { shell, dialog } from 'electron';
import { t } from '../../../extension/core/i18n.js';
import { FILE_EXTENSION } from '../../../extension/core/filevault.js';
import { RP_ID, smokeTest } from '../boot.js';
import { config, files, opened, setOpened, vault, win } from '../state.js';
import { api } from './index.js';
import { requireFeature } from '../guards.js';
import { passkeyCeremony, registerPasskey } from '../passkey-window.js';
import { bindPersonalKeys, confirmPersonalRecovery, createPersonal, personalEntries, personalInfo, renewPersonalRecovery, usePersonal } from '../personal.js';
import { actor, changed, cleanEmail, send } from '../session.js';

async function protectionCtx(containerId) {
  const c = await vault.container(containerId);
  const info = await vault.protectionInfo(containerId, RP_ID);
  return { c, info };
}

export const filesApi = {
  // File containers
  async chooseNewFile(name) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Neuen Datei-Tresor speichern'),
      defaultPath: `${String(name || 'Keevault').replace(/[^\w.-]+/g, '_')}.${FILE_EXTENSION}`,
      filters: [{ name: 'Keevault', extensions: [FILE_EXTENSION] }],
    });
    return canceled ? null : filePath;
  },
  /** { path, name, password?, passkeyLabel? } → { id, recoveryKey } */
  async createFile({ path: filePath, name, password, passkeyLabel }) {
    const passkey = passkeyLabel ? await registerPasskey(name, passkeyLabel) : null;
    const r = await files.create(filePath, name, { password, passkey }, actor());
    setOpened(true);
    return r;
  },
  async openFile() {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('Datei-Tresor öffnen'),
      filters: [{ name: 'Keevault', extensions: [FILE_EXTENSION] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    return files.open(filePaths[0]);
  },
  /** Another vault in a known file, compared with its creator and accepted by the person (#404). */
  acceptFileSwap: ({ path: filePath, id }) => files.acceptSwap(String(filePath || ''), String(id || '')),
  /** A known file refused for a changed grant, put back from the state seen here (#446). */
  repairFile: (id) => files.repair(String(id || '')),
  renameFile: (id, name) => files.rename(id, name),
  showFile: async (id) => {
    const c = (await files.containers()).find((x) => x.id === id);
    if (c) shell.showItemInFolder(c.path);
  },

  // Protection (Key Vault containers optional, file containers always)
  protectionInfo: (containerId) => vault.protectionInfo(containerId, RP_ID),
  unlockContainer: async (containerId, params) => {
    const r = await vault.unlockContainer(containerId, params);
    // Personal vault opened with the master password: bind its key to this device and the PIN for next time.
    if ((await vault.container(containerId).catch(() => null))?.personal) await bindPersonalKeys().catch(() => {});
    changed();
    return r;
  },
  personalInfo: () => personalInfo(),
  async choosePersonalFolder() {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: t('Ordner für den persönlichen Tresor'), properties: ['openDirectory'] });
    if (canceled || !filePaths[0]) return null;
    return personalInfo(filePaths[0]);
  },
  /** Whether this personal vault opens with the PIN on this device (else the renderer offers to bind it). */
  personalBound: async (containerId) => {
    const entry = personalEntries().find((e) => e.id === containerId);
    return !!entry && !!config.get().personalDeviceKeys?.[entry.path];
  },
  createPersonal: (opts) => createPersonal(opts),
  usePersonal: (opts) => usePersonal(opts),
  renewPersonalRecovery: (id, password) => renewPersonalRecovery(id, password),
  confirmPersonalRecovery: (id) => confirmPersonalRecovery(id),
  /** After unlocking the personal vault with the master password: bind its key to this device and the PIN. */
  async bindPersonalWithPin(pin) {
    await api.verifyPin(String(pin || ''));
    await bindPersonalKeys({ force: true });
    return true;
  },
  async unlockContainerPasskey(containerId) {
    const { c, info } = await protectionCtx(containerId);
    if (!info.passkeys.length) throw new Error(t('Für diese App ist kein Passkey registriert'));
    const prf = await passkeyCeremony({ mode: 'evaluate', containerName: c.name, passkeys: info.passkeys, autoStart: !smokeTest });
    const r = await vault.unlockContainer(containerId, { credentialId: prf.credentialId, prfOutput: prf.prfOutput });
    changed();
    return r;
  },
  async enableProtection(containerId, { password, passkeyLabel }) {
    await requireFeature(containerId, 'protection');
    const c = await vault.container(containerId);
    const passkey = passkeyLabel ? await registerPasskey(c.name, passkeyLabel) : null;
    const r = await vault.enableProtection(containerId, { password, passkey }, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  updateProtection: (containerId, op) => vault.updateProtection(containerId, op),
  async addContainerPasskey(containerId, label) {
    const { c, info } = await protectionCtx(containerId);
    const passkey = await registerPasskey(c.name, label, info.passkeys.map((p) => p.credentialId));
    return vault.updateProtection(containerId, { type: 'addPasskey', passkey });
  },
  disableProtection: async (containerId) => {
    await requireFeature(containerId, 'protection');
    const r = await vault.disableProtection(containerId, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  lockContainer: async (containerId) => {
    await vault.lockContainer(containerId);
    changed();
  },

  // Secured files (passkey only, members with roles)
  /** { path, name, email, attachment } → { id } */
  async createSecureFile({ path: filePath, name, email, attachment }) {
    const passkey = await registerPasskey(name, cleanEmail(email), [], attachment);
    const r = await files.createSecure(filePath, name, { email: cleanEmail(email), passkey });
    config.update({ fileEmail: cleanEmail(email) });
    setOpened(true);
    changed();
    return r;
  },
  async requestFileAccess(containerId, { email, attachment }) {
    const c = await vault.container(containerId);
    const passkey = await registerPasskey(c.name, cleanEmail(email), [], attachment);
    config.update({ fileEmail: cleanEmail(email) });
    return files.requestAccess(containerId, { email: cleanEmail(email), passkey });
  },
  fileMembers: (containerId) => files.members(containerId, RP_ID),
  async fileMemberOp(containerId, op) {
    if (op.type === 'addCredential') {
      const c = await vault.container(containerId);
      const info = await files.protectionInfo(containerId, RP_ID);
      const me = (await files.members(containerId, RP_ID)).members.find((m) => m.me);
      const passkey = await registerPasskey(c.name, me.email, info.passkeys.map((p) => p.credentialId), op.attachment);
      return files.memberOp(containerId, { type: 'addCredential', passkey });
    }
    return files.memberOp(containerId, op);
  },
  async migrateFile(containerId, { email, attachment }) {
    const c = await vault.container(containerId);
    const passkey = await registerPasskey(c.name, cleanEmail(email), [], attachment);
    config.update({ fileEmail: cleanEmail(email) });
    return files.migrate(containerId, { email: cleanEmail(email), passkey });
  },
};
