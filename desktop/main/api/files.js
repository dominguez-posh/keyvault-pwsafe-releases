// API: file vaults and the personal vault, extra protection (password, passkeys), members of secured files.

import { app, shell, dialog } from 'electron';
import { t } from '../../../extension/core/i18n.js';
import { FILE_EXTENSION } from '../../../extension/core/filevault.js';
import { RP_ID, smokeTest } from '../boot.js';
import { config, files, opened, setOpened, vault, win } from '../state.js';
import { api } from './index.js';
import { pinGuard, requireFeature } from '../guards.js';
import { requireVaultUse } from '../access.js';
import { passkeyCeremony, registerPasskey } from '../passkey-window.js';
import { bindPersonalKeys, confirmPersonalRecovery, createPersonal, personalEntries, personalInfo, renewPersonalRecovery, usePersonal } from '../personal.js';
import { actor, changed, cleanEmail, send } from '../session.js';
import { OlderStateAcceptance } from '../../file-accept-older.js';
import { adoptLineage, checkSecret, consumeFresh, isMigrated, openSecuredLater, rememberDk, rotate } from '../unlock.js';
import { ckFingerprint, unlockWithPassword } from '../../../extension/core/protect.js';
import {
  linkAfterPasskey, memberKeyForNew, memberKeyOrNull, opensWithMemberKey, passkeyOnlyPolicy, renewMemberIdentity,
  unlockSecuredWithMemberKey,
} from '../member-key.js';
import { breakGlassCredentials, registerBreakGlass, requireActiveMember, withoutForeignCodes } from '../break-glass.js';

// #537 (Konrad): changing the master password, the recovery key or the sticks of the personal vault – whose master
// password is the app's – needs a fresh master password or recovery key, not just the unlocked app (PIN, later Hello).
const FRESH_OPS = new Set(['setPassword', 'rekey', 'newRecovery', 'addPasskey', 'addEscrow', 'removeEntry']);
/** #537 2b: the only protection operation that needs no 'share' confirmation in a vault with "Immer bestätigen". */
export const PROTECTION_FREE_OPS = new Set(['removeEntry']);
async function requireFreshForPersonal(containerId, opType) {
  if (!isMigrated() || !FRESH_OPS.has(opType)) return;
  if ((await vault.container(containerId).catch(() => null))?.personal) consumeFresh('personal-keyring');
}

// #435: one per app run, holding the one-time tokens of the dialog (main process only).
let olderStates = null;
const older = () => (olderStates ??= new OlderStateAcceptance(files));
function requireAdminMode() {
  if (config.get().adminTools !== true) throw new Error(t('Einen älteren Stand nimmst du nur im Admin-Modus an.'));
  if (!config.get().appPin) throw new Error(t('Dafür ist eine App-PIN nötig.'));
}

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
  /**
   * { path, name, password?, passkeyLabel? } → { id, recoveryKey }. #539 (Lucas 13.11.2026): new shared file vaults only in
   * the secured format (createSecureFile) – the old format with a shared password is no longer created; only the smoke
   * run makes one (legacy: true) to test opening and converting old files. The personal vault has its own path.
   */
  async createFile({ path: filePath, name, password, passkeyLabel, legacy }) {
    if (!(smokeTest && !app.isPackaged && legacy === true)) throw new Error(t('Neue geteilte Datei-Tresore gibt es nur im abgesicherten Format (mit Benutzern und Rollen).'));
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
  /**
   * #435: an older state of a secured file taken on purpose. Admin mode, then the dialog's token; the app PIN (with its
   * attempt lock) and a passkey with user verification; written only after the wait, with the vault name typed.
   */
  acceptOlderPrepare: async (id) => {
    requireAdminMode();
    return older().prepare(String(id || ''));
  },
  async acceptOlderUnlock(token, pin) {
    requireAdminMode();
    older().check(String(token || ''));
    // #537 (#521): only the master password itself once it is set up – not the PIN wrapper, not Windows Hello.
    await api.verifyPin(String(pin || ''), isMigrated() ? 'password' : undefined);
    pinGuard.consume(); // the PIN confirmed this step – it opens nothing afterwards
    const { name, passkeys } = await older().passkeys(String(token || ''), RP_ID);
    if (!passkeys.length) throw new Error(t('In diesem älteren Stand hat kein Admin des hier bekannten Stands einen Passkey für diese App.')); // #527
    const prf = await passkeyCeremony({ mode: 'evaluate', containerName: name, passkeys, autoStart: !smokeTest });
    return older().unlock(String(token || ''), { credentialId: prf.credentialId, prfOutput: prf.prfOutput });
  },
  async acceptOlderCommit(token, name) {
    requireAdminMode();
    const id = await older().commit(String(token || ''), String(name || ''));
    changed();
    return id;
  },
  renameFile: (id, name) => files.rename(id, name),
  showFile: async (id) => {
    const c = (await files.containers()).find((x) => x.id === id);
    if (c) shell.showItemInFolder(c.path);
  },

  // Protection (Key Vault containers optional, file containers always)
  protectionInfo: async (containerId) => {
    const info = await vault.protectionInfo(containerId, RP_ID);
    // #539: a secured file that opens with the app's master password here (own app credential, allowed).
    return info?.secure ? { ...info, memberKey: await opensWithMemberKey(containerId), passkeyOnlyPolicy: passkeyOnlyPolicy() } : info;
  },
  unlockContainer: async (containerId, params) => {
    const personal = !!(await vault.container(containerId).catch(() => null))?.personal;
    const entry = personal ? personalEntries().find((e) => e.id === containerId) : null;
    // #537: the personal vault's master password is the app's. One that differs (a vault adopted here) becomes the app's
    // only with a fresh current one (H2) – checked before the vault opens, so nothing changes without it.
    let adopt = false;
    let known = null;
    let checkedFp = null;
    const withPassword = !!entry && isMigrated() && typeof params?.password === 'string';
    if (withPassword) {
      // Konrad (check of 11001ce): the file as it is now, not the keyring in memory – and its key fingerprint, which the
      // opened vault must match below (the unlock reads the file again; a swap in between is refused).
      await entry.vault.load();
      const pre = await unlockWithPassword(entry.vault.keyring, params.password).catch(() => null);
      checkedFp = pre ? await ckFingerprint(pre.ck) : null;
      known = await checkSecret(params.password, { kind: 'password' }).catch(() => null);
      if (known) rememberDk(known.dk);
      else if (pre) {
        consumeFresh('personal-adopt');
        adopt = true;
      }
    }
    const r = await vault.unlockContainer(containerId, params);
    if (withPassword && (!checkedFp || !entry.vault.ck || (await ckFingerprint(entry.vault.ck)) !== checkedFp)) {
      entry.vault.lock();
      changed();
      throw new Error(t('Die Datei des persönlichen Tresors hat sich beim Entsperren geändert. Bitte erneut versuchen.'));
    }
    // Personal vault opened with the master password: bind its key to this device and the PIN (or the device key) for next time.
    if (personal) {
      if (adopt) await rotate(params.password, [{ entry, ck: entry.vault.ck }]);
      // The lineage follows only the app's own master password (known), never a foreign one without a fresh MP.
      else if (known && entry.vault.ck) await adoptLineage(entry, entry.vault.ck);
      await bindPersonalKeys().catch(() => {});
      if (known && entry?.vault?.ck) openSecuredLater(); // #539: the app's master password opens the secured files, too
    }
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
  async renewPersonalRecovery(id, password) {
    await requireFreshForPersonal(id, 'rekey');
    return renewPersonalRecovery(id, password);
  },
  confirmPersonalRecovery: (id) => confirmPersonalRecovery(id),
  /** After unlocking the personal vault with the master password: bind its key to this device and the PIN. */
  async bindPersonalWithPin(pin) {
    await api.verifyPin(String(pin || ''));
    await bindPersonalKeys({ force: true });
    return true;
  },
  /**
   * opts.breakGlass (#539 Etappe 10): only the emergency sticks of a secured file ("Mit Notfall-Stick öffnen"); without
   * it they are left out, so the everyday unlock never asks for the stick in the safe.
   */
  async unlockContainerPasskey(containerId, opts = {}) {
    const { c, info } = await protectionCtx(containerId);
    const emergency = info.secure ? breakGlassCredentials(containerId) : new Set();
    const passkeys = info.passkeys.filter((p) => emergency.has(p.credentialId) === (opts?.breakGlass === true));
    if (!passkeys.length) throw new Error(opts?.breakGlass === true ? t('Diese Datei hat keinen Notfall-Stick für diese App') : t('Für diese App ist kein Passkey registriert'));
    const prf = await passkeyCeremony({ mode: 'evaluate', containerName: c.name, passkeys, autoStart: !smokeTest });
    const r = await vault.unlockContainer(containerId, { credentialId: prf.credentialId, prfOutput: prf.prfOutput });
    changed();
    // #539: a passkey member of a secured file gets the same identity at the master password too (unless passkeys only).
    if (info.secure && !r?.pending && !emergency.has(prf.credentialId)) linkAfterPasskey(containerId).then((linked) => linked && changed());
    return r;
  },
  /** #539: a secured file with the app's master password (the member key in the personal vault). */
  async unlockContainerMemberKey(containerId) {
    const r = await unlockSecuredWithMemberKey(containerId);
    changed();
    return r;
  },
  /** #539 "master password compromised": only right after changing the master password (see member-key.js). */
  async renewMemberIdentity() {
    const r = await renewMemberIdentity();
    changed();
    return r;
  },
  async enableProtection(containerId, { password, passkeyLabel, passkeyOwner }) {
    await requireFeature(containerId, 'protection');
    const c = await vault.container(containerId);
    // passkeyOwner: name left at its default, it then says what was registered (#531).
    const owner = typeof passkeyOwner === 'string' && passkeyOwner ? passkeyOwner : undefined;
    const passkey = passkeyLabel || owner ? await registerPasskey(c.name, passkeyLabel || null, [], undefined, { owner }) : null;
    const r = await vault.enableProtection(containerId, { password, passkey }, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  async updateProtection(containerId, op) {
    await requireFreshForPersonal(containerId, op?.type);
    // #537 2b (Konrad): allowlist – with the rule every change of who or what opens the vault (password, key change,
    // sticks, invites, passkeys, anything added later) needs the 'share' confirmation; only removing an entry is free.
    if (!PROTECTION_FREE_OPS.has(op?.type)) await requireVaultUse(containerId, 'share');
    return vault.updateProtection(containerId, op);
  },
  /**
   * label: chosen name, or null with owner: the name then says what was registered (#531). attachment/hints:
   * 'cross-platform' + ['security-key'] for the FIDO step of the personal vault.
   */
  async addContainerPasskey(containerId, label, { owner, attachment, hints } = {}) {
    await requireFreshForPersonal(containerId, 'addPasskey');
    await requireVaultUse(containerId, 'share'); // #537 2b: a new passkey opens the vault too
    const { c, info } = await protectionCtx(containerId);
    const clean = (v) => (typeof v === 'string' && v ? v : undefined);
    const passkey = await registerPasskey(c.name, clean(label), info.passkeys.map((p) => p.credentialId),
      attachment === 'cross-platform' || attachment === 'platform' ? attachment : undefined,
      { owner: clean(owner), hints: Array.isArray(hints) ? hints.filter((x) => x === 'security-key' || x === 'client-device' || x === 'hybrid') : undefined });
    return vault.updateProtection(containerId, { type: 'addPasskey', passkey });
  },
  disableProtection: async (containerId) => {
    await requireFeature(containerId, 'protection');
    await requireVaultUse(containerId, 'share'); // #537 2b: without protection the file opens for anyone holding it
    const r = await vault.disableProtection(containerId, (done, total) => send({ type: 'progress', done, total }));
    changed();
    return r;
  },
  lockContainer: async (containerId) => {
    await vault.lockContainer(containerId);
    changed();
  },

  // Secured files (passkey only, members with roles)
  /**
   * { path, name, email, attachment, method } → { id }; method 'app' (#539): with the master password, no passkey.
   * Etappe 10 (Lucas): never without the break-glass stick – registered and test-opened before the file is written.
   */
  async createSecureFile({ path: filePath, name, email, attachment, method }) {
    const mk = method === 'app' ? await memberKeyForNew() : undefined;
    const passkey = mk ? undefined : await registerPasskey(name, cleanEmail(email), [], attachment);
    const breakGlass = await registerBreakGlass(name, passkey ? [passkey.credentialId] : []);
    const r = await files.createSecure(filePath, name, { email: cleanEmail(email), passkey, mk, breakGlass });
    config.update({ fileEmail: cleanEmail(email) });
    setOpened(true);
    changed();
    return r;
  },
  async requestFileAccess(containerId, { email, attachment, method }) {
    const c = await vault.container(containerId);
    const mk = method === 'app' ? await memberKeyForNew() : undefined; // #539
    const passkey = mk ? undefined : await registerPasskey(c.name, cleanEmail(email), [], attachment);
    config.update({ fileEmail: cleanEmail(email) });
    return files.requestAccess(containerId, { email: cleanEmail(email), passkey, mk });
  },
  // #539 Etappe 10: the codes of other people's requests stay out of the window – the admin types what they read out.
  fileMembers: async (containerId) => withoutForeignCodes({ ...(await files.members(containerId, RP_ID, await memberKeyOrNull())), passkeyOnlyPolicy: passkeyOnlyPolicy() }),
  async fileMemberOp(containerId, op) {
    // #537 2b (Konrad): access for another person or credential, or sharing switched on, needs a confirmation.
    // #539 (Konrad, low): switching "Nur mit Passkey" off opens the vault to the master password again – asks as well.
    if ('approve addCredential setRole replace addAppCredential breakGlass'.split(' ').includes(op?.type) || (op?.type === 'sharing' && op.enabled)
      || (op?.type === 'passkeyOnly' && op.enabled !== true)) await requireVaultUse(containerId, 'share');
    // #539: the member key never comes from the window; the new operations only with their own fields.
    if (op?.type === 'addAppCredential') return files.memberOp(containerId, { type: 'addAppCredential', mk: await memberKeyForNew() });
    if (op?.type === 'passkeyOnly') return files.memberOp(containerId, { type: 'passkeyOnly', enabled: op.enabled === true });
    // Etappe 10: approving (also a replacement) only with the code the person reads out, typed by the admin – checked in
    // the core, in the file's queue, against exactly that member (Konrad N2d).
    const code = typeof op?.code === 'string' ? op.code : '';
    if (op?.type === 'replace') return files.memberOp(containerId, { type: 'replace', memberId: String(op.memberId || ''), code, requireCode: true });
    if (op?.type === 'approve') return files.memberOp(containerId, { type: 'approve', memberId: String(op.memberId || ''), role: op.role, code, requireCode: true });
    // Konrad M1: a role only for an active member – checked here and in the core.
    if (op?.type === 'setRole') {
      requireActiveMember(containerId, String(op.memberId || ''));
      return files.memberOp(containerId, { type: 'setRole', memberId: String(op.memberId || ''), role: op.role });
    }
    if (op?.type === 'breakGlass') { // another emergency stick (the core refuses a credential of another member)
      const c = await vault.container(containerId);
      const info = await files.protectionInfo(containerId, RP_ID);
      return files.memberOp(containerId, { type: 'breakGlass', stick: await registerBreakGlass(c.name, info.passkeys.map((p) => p.credentialId)) });
    }
    if (op.type === 'addCredential') {
      const c = await vault.container(containerId);
      const info = await files.protectionInfo(containerId, RP_ID);
      const me = (await files.members(containerId, RP_ID)).members.find((m) => m.me);
      const passkey = await registerPasskey(c.name, me.email, info.passkeys.map((p) => p.credentialId), op.attachment);
      return files.memberOp(containerId, { type: 'addCredential', passkey });
    }
    return files.memberOp(containerId, op);
  },
  async migrateFile(containerId, { email, attachment, method }) {
    await requireVaultUse(containerId, 'share'); // #537 2b (Konrad): a new file with a new member and passkey
    const c = await vault.container(containerId);
    const mk = method === 'app' ? await memberKeyForNew() : undefined; // #539
    const passkey = mk ? undefined : await registerPasskey(c.name, cleanEmail(email), [], attachment);
    const breakGlass = await registerBreakGlass(c.name, passkey ? [passkey.credentialId] : []); // Etappe 10: required
    config.update({ fileEmail: cleanEmail(email) });
    return files.migrate(containerId, { email: cleanEmail(email), passkey, mk, breakGlass });
  },
};
