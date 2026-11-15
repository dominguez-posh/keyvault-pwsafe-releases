// Smoke check of #537 stage 6: the recovery stick of the personal vault resets the master password. Added with a fresh
// master password (the run's virtual USB authenticator with PRF), then on the lock screen "Masterpasswort vergessen?" →
// new master password → the stick → the new recovery key shown once → the app opens. The old master password opens
// nothing any more, the stick still resets (it was carried through the key change), the new recovery key waits for its
// confirmation until confirmed. The personal vault is a temporary test folder (KVPWSAFE_TEST_REMOTE), never a real one.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { until } from './smoke-wait.js';

const MP = 'Smoke-Reset-537-alt!';
const NEW = 'Smoke-Reset-537-neu!';
const NEW2 = 'Smoke-Reset-537-neu2!';
const rejects = (p) => p.then(() => false, () => true);

export async function mpResetCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'personalRecoveryPending', 'personalRecoveryRenewed', 'settingsCopy', 'mpResetsSeen'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const env = { remote: process.env.KVPWSAFE_TEST_REMOTE, hello: process.env.KVPWSAFE_TEST_HELLO };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-reset-'));
  const personalFile = path.join(dir, 'Keevault-Persoenlich.kvpws');
  const personal = async () => (await api.state()).containers.find((c) => c.path === personalFile) || null;
  try {
    process.env.KVPWSAFE_TEST_REMOTE = dir;
    delete process.env.KVPWSAFE_TEST_HELLO;
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], personalDeviceKeys: {}, settingsCopy: false });
    const pin = await ensurePin();
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    await api.setupMasterPassword({ password: MP, pin });
    await api.createPersonal({ folder: dir, password: MP });
    const id = (await personal())?.id;
    if (!id) return fail('no personal vault in the test folder');
    config.update({ personalRecoveryPending: {}, personalRecoveryRenewed: {} });
    // Creating the vault grants the wizard's next step (the FIDO stick) one fresh confirmation – locking ends it, so the
    // check below sees an app unlocked without a fresh master password.
    await api.lock();
    await api.verifyPin(MP, 'password');
    await api.unlock({ entra: true });

    // Adding the stick needs a fresh master password; then it is listed as a recovery stick.
    if (!(await rejects(api.addRecoveryStick(id)))) fail('a recovery stick was added without a fresh master password');
    await api.confirmMasterPassword({ password: MP }, 'personal-keyring');
    await api.addRecoveryStick(id).catch((e) => fail(`adding the recovery stick failed: ${e.message}`));
    const methods = (await api.protectionInfo(id).catch(() => null))?.methods;
    if (!methods?.escrows?.some((e) => e.role === 'recovery')) return fail(`no recovery stick in the personal vault (${JSON.stringify(methods?.escrows)})`);
    if (!(await api.stickResetAvailable())) fail('the lock screen would not offer the reset');

    // Lock screen: "Masterpasswort vergessen?" → new master password → stick → recovery key → open.
    await api.lock();
    changed();
    if (!(await until(() => js('!!document.querySelector(".mp-reset-link:not([hidden])")'), 5000))) return fail('the lock screen offers no "Masterpasswort vergessen?"');
    await js('document.querySelector(".mp-reset-link").click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open].mp-reset-dialog .mp-reset-new2")'), 3000))) return fail('the reset dialog did not open');
    await js(`(() => { document.querySelector(".mp-reset-new").value = ${JSON.stringify(NEW)}; document.querySelector(".mp-reset-new2").value = ${JSON.stringify(NEW)}; document.querySelector("dialog[open].mp-reset-dialog .modal-footer .btn.primary").click(); return true; })()`);
    if (!(await until(() => js('!!document.querySelector("dialog[open] .code-box code")'), 25000))) return fail(`no new recovery key after the reset (${await js('document.getElementById("toast")?.textContent || ""')})`);
    const code = await js('document.querySelector("dialog[open] .code-box code").textContent');
    if (!/^RK-/.test(code)) fail(`the new recovery key looks wrong: "${code.slice(0, 3)}…"`);
    if (!Object.hasOwn(config.get().personalRecoveryPending || {}, id)) fail('the new recovery key does not wait for its confirmation (#399)');
    await js('(() => { const d = [...document.querySelectorAll("dialog[open]")].at(-1); const box = d.querySelector("input[type=checkbox]"); if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); box.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()');
    await sleep(200);
    await js('[...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(".modal-footer .btn.primary")?.click(); true');
    if (!(await until(async () => (await api.state()).opened, 15000))) fail('the app did not open after the reset');
    if (!(await until(() => !Object.hasOwn(config.get().personalRecoveryPending || {}, id), 5000))) fail('the confirmed recovery key still waits');
    const vault = await personal();
    if (!vault || vault.locked) fail('the personal vault is not open after the reset');

    // The reset log: not shown on the device that reset; another device (nothing seen) shows it once, with the device.
    await sleep(1500);
    if (await js('!!document.querySelector("dialog[open].mp-reset-notice-modal")')) fail('the resetting device shows its own reset as news');
    if ((await api.mpResetNotices()).length) fail('the resetting device has not marked its reset as seen');
    config.update({ mpResetsSeen: [] });
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open].mp-reset-notice-modal")'), 6000))) fail('another device does not show the reset');
    else {
      if (!(await js('/mit einem Sicherheitsschlüssel zurückgesetzt/.test(document.querySelector("dialog[open].mp-reset-notice-modal")?.textContent || "") && /Demo-PC/.test(document.querySelector("dialog[open].mp-reset-notice-modal")?.textContent || "")'))) fail('the reset notice does not name the stick and the device');
      await js('document.querySelector("dialog[open].mp-reset-notice-modal .modal-footer .btn.primary")?.click(); true');
      if (!(await until(async () => (await api.mpResetNotices()).length === 0, 3000))) fail('the reset notice comes again after "Verstanden"');
    }

    // The old master password opens nothing, the new one does; the stick still resets (carried by the key change).
    await api.lock();
    if (!(await rejects(api.verifyPin(MP, 'password')))) fail('the old master password still unlocks after the reset');
    resetPinGuard?.();
    if (await rejects(api.verifyPin(NEW, 'password'))) fail('the new master password does not unlock');
    else await api.unlock({ entra: true });
    await api.lock();
    const again = await api.resetMasterPasswordWithStick({ password: NEW2 }).catch((e) => ({ error: e.message }));
    if (again.error || !/^RK-/.test(again.recoveryKey || '')) fail(`the stick did not reset a second time after the key change (${again.error})`);
    else await api.unlock({ entra: true });

    // Konrad M1: removing the stick is a key change – the entry alone cannot be removed, the removal gives a new recovery
    // key, and the stick resets nothing any more.
    const stickId = (await api.protectionInfo(id))?.methods?.escrows?.find((e) => e.role === 'recovery')?.id;
    if (!stickId) fail('the recovery stick is gone after the second reset');
    else {
      await api.confirmMasterPassword({ password: NEW2 }, 'personal-keyring');
      if (!(await rejects(api.updateProtection(id, { type: 'removeEntry', entryId: stickId })))) fail('the recovery stick was removed without a key change');
      const removed = await api.removeRecoveryStick(id, stickId, NEW2).catch((e) => ({ error: e.message }));
      if (removed.error || !/^RK-/.test(removed.recoveryKey || '')) fail(`removing the stick was no key change (${removed.error})`);
      if (await api.stickResetAvailable()) fail('the removed stick still offers the reset');
      if ((await api.protectionInfo(id))?.methods?.escrows?.length) fail('the removed stick is still in the keyring');
    }
  } catch (e) {
    fail(e.message);
  } finally {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    if (!(await api.state()).opened) {
      resetPinGuard?.();
      await api.verifyPin(NEW2, 'password').then(() => api.unlock({ entra: true }), () => null);
    }
    const c = await personal().catch(() => null);
    if (c) await api.removeContainer(c.id).catch(() => {});
    for (const [k, v] of [['KVPWSAFE_TEST_REMOTE', env.remote], ['KVPWSAFE_TEST_HELLO', env.hello]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    config.update(before);
    resetPinGuard?.();
    changed();
    await sleep(400);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return undefined;
}
