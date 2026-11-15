// API: the one master password of the app (#537) – moving from the app PIN, and the fresh master password or recovery
// key that changing the master password, recovery key or sticks of the personal vault needs.

import { requireOpen } from '../guards.js';
import { confirmFresh, migrate, unlockService } from '../unlock.js';
import { helloUnlock } from '../hello-key.js';
import { changed } from '../session.js';
import { api } from './index.js';
import { addRecoveryStick, removeRecoveryStick, mpResetNotices, mpResetsShown, resetMasterPasswordWithStick, stickResetAvailable } from '../mp-reset.js';

export const unlockApi = {
  /** { password, pin?, keepPin?, newPin? } – the old PIN is taken from the unlock a moment ago when not given. */
  async setupMasterPassword(opts = {}) {
    requireOpen();
    const r = await migrate({ password: opts.password, pin: opts.pin ?? null, keepPin: opts.keepPin !== false, newPin: opts.newPin ?? null });
    changed();
    return { ...(await api.state()), pinKept: r.pinKept };
  },
  /** { password } | { code } for one purpose (see FRESH_PURPOSES), valid once and for two minutes. */
  confirmMasterPassword(proof = {}, purpose = 'personal-keyring') {
    requireOpen();
    return confirmFresh({ password: proof.password, code: proof.code }, purpose);
  },
  // #537 stage 3: Windows Hello unwraps the device key. On only with the master password, off only with it too.
  /** { on, allowed, available, remote } – never key material. */
  helloKeyInfo: () => helloUnlock.info(),
  /** #537 live test: "Windows Hello aktivieren?" was shown on this device – not asked again (first start, upgrade). */
  helloOfferShown: () => { unlockService.helloOffered(); return true; },
  async enableHelloUnlock({ password } = {}) {
    requireOpen();
    await helloUnlock.enable(String(password ?? ''));
    unlockService.helloOffered(); // switched on: the question after an upgrade never comes (also when switched off later)
    changed();
    return api.state();
  },
  async disableHelloUnlock({ password } = {}) {
    requireOpen();
    await helloUnlock.disable(String(password ?? ''));
    changed();
    return api.state();
  },
  // #537 stage 6: the recovery stick resets the master password (lock screen); adding one needs a fresh MP or RK.
  stickResetAvailable: () => stickResetAvailable(),
  /** { password } → { recoveryKey }; then `unlock` as after verifyPin. Works on the lock screen. */
  resetMasterPasswordWithStick: (opts) => resetMasterPasswordWithStick(opts),
  /** Resets of the master password not shown on this device yet: [{ at, device }]. */
  mpResetNotices() {
    requireOpen();
    return mpResetNotices();
  },
  mpResetsShown(ats) {
    requireOpen();
    return mpResetsShown(ats);
  },
  /** Konrad M1: removing a recovery stick is a key change; the current master password proves it. → { recoveryKey, id } */
  async removeRecoveryStick(containerId, entryId, password, newPassword) {
    requireOpen();
    return removeRecoveryStick(containerId, entryId, password, typeof newPassword === 'string' ? newPassword : null);
  },
  async addRecoveryStick(containerId) {
    requireOpen();
    return addRecoveryStick(containerId);
  },
  /** Lock screen: Windows Hello instead of the master password; then `unlock` as after verifyPin. */
  unlockWithHelloKey: () => helloUnlock.unlock(),
};
