// Smoke checks of #537 stage 2: the master password replaces the app PIN hash. Moving from the PIN in Settings →
// Security (the old PIN stays as a wrapper of the device key, appPin keeps the old hash, never the master password),
// unlocking with the master password or the PIN, the PIN dialog that needs the master password, admin mode with the
// master password, the fresh confirmation for the personal vault's keys. Leaves the PIN state as it found it, so the
// other checks keep running on the app PIN. No Windows dialog: Hello comes with stage 3.

import { until } from './smoke-wait.js';
import { verifyPin } from './pin.js';

const MP = 'Smoke-Master-537!';
const SECURITY_TAB = '[...document.querySelectorAll("dialog[open] .tabs button")].find((b) => /^(Sicherheit|Security)$/.test(b.textContent.trim()))?.click()';
const setValue = (sel, value) => `(() => { const i = [...document.querySelectorAll(${JSON.stringify(sel)})].at(-1); if (!i) return false; i.value = ${JSON.stringify(value)}; return true; })()`;
const clickPrimary = '[...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(".modal-footer .btn.primary")?.click(); true';
const rejects = (p) => p.then(() => false, () => true);

async function openSecurity({ js, sleep }, selector) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu, .main-menu")?.remove(); true');
    await sleep(400);
    await js('document.querySelector(".menu-btn")?.click()');
    await until(() => js('!!document.querySelector(".main-menu [data-action=settings]")'), 1000);
    await js('document.querySelector(".main-menu [data-action=settings]")?.click()');
    await until(() => js('!!document.querySelector("dialog[open] .tabs button")'), 1500);
    await js(SECURITY_TAB);
    if (await until(() => js(`!!document.querySelector("dialog[open] ${selector}")`), 1000)) return true;
  }
  return false;
}

export async function masterPasswordCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'adminTools'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  try {
    // A known start: the app PIN of the other checks, no personal vault in the way (its MP would be the app's).
    config.update({ unlockKeys: null, appPin: null, personalVaults: [] });
    const pin = await ensurePin();
    const oldAppPin = config.get().appPin;
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    changed();
    await sleep(600);

    // Settings → Security offers the move; the dialog asks the MP twice (no personal vault) and keeps the PIN.
    if (!(await openSecurity({ js, sleep }, '.mp-setup'))) return fail('settings → Security has no "Masterpasswort einrichten"');
    await js('document.querySelector("dialog[open] .mp-setup").click()');
    if (!(await until(() => js('!!document.querySelector("dialog[open].master-password-dialog .mp-new2")'), 2000))) return fail('the master password dialog did not open');
    await js(setValue('.mp-new', MP));
    await js(setValue('.mp-new2', `${MP}x`));
    await js(clickPrimary);
    await sleep(500);
    if (config.get().unlockKeys) fail('two different master passwords were accepted');
    await js(setValue('.mp-new2', MP));
    await js(clickPrimary);
    if (!(await until(() => !!config.get().unlockKeys?.blob, 8000))) return fail('the master password was not set up');
    const s = await api.state();
    if (!s.unlock?.migrated || !s.unlock?.pin) fail(`state after the move: ${JSON.stringify(s.unlock)}`);
    if (JSON.stringify(config.get().appPin) !== JSON.stringify(oldAppPin)) fail('E3: appPin changed – an older app would no longer ask the old PIN');
    if (await verifyPin(MP, config.get().appPin)) fail('appPin accepts the master password');
    if (JSON.stringify(config.get().unlockKeys).includes(MP)) fail('the master password is stored in clear');
    if (await rejects(api.updateSettings({ unlockKeys: null }))) {
      if (!config.get().unlockKeys) fail('a settings patch removed unlockKeys');
    } else fail('a settings patch may write unlockKeys');

    // Lock screen: PIN field with a switch to the master password; MP and PIN unlock, each only as what it is.
    await api.lock();
    await sleep(700);
    const lock = await js('JSON.stringify({ field: !!document.querySelector(".unlock-secret #unlock-secret"), toggle: !!document.querySelector(".unlock-kind:not([hidden])") })');
    if (lock !== JSON.stringify({ field: true, toggle: true })) fail(`lock screen fields: ${lock}`);
    resetPinGuard();
    if (!(await rejects(api.verifyPin(pin, 'password')))) fail('the PIN was taken as master password');
    resetPinGuard();
    await api.verifyPin(MP, 'password');
    await api.unlock({ entra: true });
    await api.lock();
    await api.verifyPin(pin, 'pin');
    await api.unlock({ entra: true });
    changed();
    await sleep(600);

    // The PIN dialog needs the master password; the PIN alone does not change it.
    if (!(await openSecurity({ js, sleep }, '.mp-pin'))) return fail('settings → Security has no PIN button after the move');
    await js('document.querySelector("dialog[open] .mp-pin").click()');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .pin-mp")'), 2000))) return fail('the PIN dialog asks no master password');
    await js(setValue('.pin-mp', pin));
    await js(setValue('.pin-next', '864213'));
    await js(setValue('.pin-next2', '864213'));
    await js(clickPrimary);
    await sleep(800);
    resetPinGuard();
    if (await api.verifyPin('864213', 'pin').then(() => true, () => false)) fail('the PIN changed itself without the master password');
    await js(setValue('.pin-mp', MP));
    await js(clickPrimary);
    await sleep(1500);
    resetPinGuard();
    if (!(await api.verifyPin('864213', 'pin').then(() => true, () => false))) fail('the new PIN does not unlock after saving with the master password');
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');

    // Admin mode with the master password.
    await api.activateAdminMode(MP);
    if (!config.get().adminTools) fail('admin mode did not switch on with the master password');
    await api.deactivateAdminMode();

    // Fresh confirmation for the personal vault's keys: the PIN is none, the MP is.
    resetPinGuard();
    if (!(await rejects(api.confirmMasterPassword({ password: '864213' }, 'personal-keyring')))) fail('the PIN counted as fresh master password');
    resetPinGuard();
    if (!(await api.confirmMasterPassword({ password: MP }, 'personal-keyring').then(() => true, () => false))) fail('the master password was not taken as fresh confirmation');
    if (!(await rejects(api.confirmMasterPassword({ password: MP }, 'something-else')))) fail('a fresh confirmation for an unknown purpose');
  } finally {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    config.update(before);
    resetPinGuard();
    changed();
    await sleep(400);
  }
  return undefined;
}
