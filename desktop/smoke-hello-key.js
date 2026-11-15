// Smoke checks of #537 stage 3: Windows Hello unwraps the device key of the master password. Simulated Hello key only
// (KVPWSAFE_TEST_HELLO, desktop/hello-sim.js) – never a real Windows dialog. Switching on in Settings → Security needs
// the master password; the lock screen opens with Hello, one confirmation per use; cancel, reset, no TPM attestation,
// a non-deterministic signature and the organization's ban each end where they must. Leaves the PIN state as it found it.

import { until } from './smoke-wait.js';
import { extensionCardsNoted, helloOwnersNoted, simulatedDialogs } from './hello-sim.js';

const MP = 'Smoke-Hello-537!';
const SECURITY_TAB = '[...document.querySelectorAll("dialog[open] .tabs button")].find((b) => /^(Sicherheit|Security)$/.test(b.textContent.trim()))?.click()';
const setValue = (sel, value) => `(() => { const i = [...document.querySelectorAll(${JSON.stringify(sel)})].at(-1); if (!i) return false; i.value = ${JSON.stringify(value)}; return true; })()`;
const clickPrimary = '[...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(".modal-footer .btn.primary")?.click(); true';
const closeDialogs = 'document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true';
const rejects = (p) => p.then(() => null, (e) => e.name || 'Error');

async function openSecurity({ js, sleep }, selector) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await js(`${closeDialogs}; document.querySelector(".context-menu, .main-menu")?.remove(); true`);
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

export async function helloKeyCheck({ js, sleep, api, config, changed, resetPinGuard, bridge, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const org = config.org;
  const helloOn = () => !!config.get().unlockKeys?.hello;
  const lockScreenHello = async () => {
    await api.lock();
    changed();
    return until(() => js('!!document.querySelector(".hello-key-unlock")'), 3000);
  };
  const unlockWithMp = async () => {
    resetPinGuard();
    await api.verifyPin(MP, 'password');
    await api.unlock({ entra: true });
    changed();
    await sleep(500);
  };
  try {
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    // A known start: the master password without PIN, no personal vault in the way.
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], pinGuard: null });
    await api.setupMasterPassword({ password: MP });
    changed();
    await sleep(500);

    // Settings → Security: the switch asks the master password; a wrong one switches nothing and shows no Hello dialog.
    if (!(await openSecurity({ js, sleep }, '.hello-key-setting'))) return fail('settings → Security has no Windows Hello switch');
    const asked0 = simulatedDialogs();
    await js('document.querySelector("dialog[open] .hello-key-setting").click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .hello-key-mp")'), 2000))) return fail('switching Hello on asks no master password');
    await js(setValue('.hello-key-mp', 'not the master password'));
    await js(clickPrimary);
    await sleep(800);
    if (helloOn()) fail('Hello switched on with a wrong master password');
    if (simulatedDialogs() !== asked0) fail('a wrong master password showed a Windows Hello dialog');
    await js(setValue('.hello-key-mp', MP));
    await js(clickPrimary);
    if (!(await until(() => helloOn(), 6000))) return fail('Hello did not switch on with the master password');
    if (simulatedDialogs() !== asked0 + 1) fail(`switching on asked Windows Hello ${simulatedDialogs() - asked0} times`);
    if (JSON.stringify(config.get().unlockKeys).includes(MP)) fail('the master password is stored in clear');
    await js(closeDialogs);

    // Lock screen: Hello opens like the master password – one confirmation per use.
    if (!(await lockScreenHello())) return fail('the lock screen offers no Windows Hello');
    const asked1 = simulatedDialogs();
    await js('document.querySelector(".hello-key-unlock").click(); true');
    if (!(await until(async () => (await api.state()).opened, 8000))) return fail('Windows Hello did not unlock the app');
    if (simulatedDialogs() !== asked1 + 1) fail(`one unlock asked Windows Hello ${simulatedDialogs() - asked1} times`);
    await sleep(500);

    // Cancel: still locked, nothing counted, Hello stays; the master password opens.
    process.env.KVPWSAFE_TEST_HELLO = 'cancel';
    if (!(await lockScreenHello())) return fail('no Windows Hello on the lock screen after a Hello unlock');
    await js('document.querySelector(".hello-key-unlock").click(); true');
    await sleep(1200);
    if ((await api.state()).opened) fail('a cancelled Windows Hello unlocked the app');
    if (!helloOn()) fail('a cancel switched Hello off');
    if (await rejects(api.unlockWithHelloKey()) !== 'HelloCanceled') fail('cancel is not reported as such');
    await unlockWithMp();

    // Reset of the Hello container: the wrapper goes, the master password opens, the switch is off.
    process.env.KVPWSAFE_TEST_HELLO = 'reset';
    await api.lock();
    if (await rejects(api.unlockWithHelloKey()) !== 'HelloReset') fail('a reset Hello container is not reported');
    if (helloOn()) fail('the Hello wrapper stayed after a reset');
    if ((await api.state()).opened) fail('a reset Hello container unlocked the app');
    await unlockWithMp();

    // No TPM attestation, or signatures that change: never switched on.
    for (const { mode, name } of [{ mode: 'noattest', name: 'HelloNoTpm' }, { mode: 'random', name: 'HelloSignature' }, { mode: 'unavailable', name: 'HelloUnavailable' }]) {
      process.env.KVPWSAFE_TEST_HELLO = mode;
      resetPinGuard();
      const got = await rejects(api.enableHelloUnlock({ password: MP }));
      if (got !== name) fail(`${mode}: expected ${name}, got ${got}`);
      if (helloOn()) fail(`${mode}: Hello switched on`);
    }

    // Off only with the master password; the organization's ban removes Hello.
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    resetPinGuard();
    await api.enableHelloUnlock({ password: MP });
    // Stage 4: the gates take Windows Hello as proof – one Hello per use, cancel confirms nothing (admin mode, export).
    const askedGate = simulatedDialogs();
    await api.activateAdminMode({ hello: true });
    if (!config.get().adminTools) fail('admin mode did not switch on with Windows Hello');
    if (simulatedDialogs() !== askedGate + 1) fail('switching on admin mode did not ask Windows Hello once');
    // The hidden app window: a small Keevault window says who asks Windows Hello and for what (no window in a smoke run).
    const owner = helloOwnersNoted().at(-1);
    if (owner?.purpose !== 'admin' || !/Windows Hello/.test(owner.title || '')) fail(`no "Keevault: Bestätige mit Windows Hello" window for admin mode: ${JSON.stringify(owner)}`);
    await api.deactivateAdminMode();
    process.env.KVPWSAFE_TEST_HELLO = 'cancel';
    if (await rejects(api.activateAdminMode({ hello: true })) !== 'HelloCanceled' || config.get().adminTools) fail('a cancelled Windows Hello switched admin mode on');
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    const target = (await api.state()).containers.find((c) => !c.locked && !c.error);
    if (target) {
      const before = simulatedDialogs();
      const token = await api.confirmExportPin(target.id, { hello: true }).catch((e) => fail(`export with Windows Hello: ${e.message}`));
      if (!token || simulatedDialogs() !== before + 1) fail('the export confirmation did not take one Windows Hello');
      if (await rejects(api.exportItems(target.id, 'not-the-token')) !== 'ExportPinRequired') fail('an export went through without its confirmation');
    } else fail('no open vault for the export check');
    if (await rejects(api.activateAdminMode({ hello: 'yes' })) === null) fail('a proof that is not { hello: true } switched admin mode on');
    await api.deactivateAdminMode();

    // The extension's unlockRequest: Keevault's own card first (Zulassen → Hello), opens only the extension's session;
    // refused in the card → no Hello, then a wait before the next request.
    resetPinGuard();
    await api.lock();
    const cards0 = extensionCardsNoted().length;
    const dialogs0 = simulatedDialogs();
    process.env.KVPWSAFE_TEST_HELLO_CARD = 'yes';
    await bridge.unlockRequest().catch((e) => fail(`unlockRequest with the card allowed: ${e.name}`));
    const s1 = await api.state();
    if (!s1.windowLocked) fail('unlockRequest opened the window too (only the extension session may open)');
    if (extensionCardsNoted().length !== cards0 + 1 || !/Browser-Erweiterung/.test(extensionCardsNoted().at(-1)?.title || '')) fail('no Keevault card before Windows Hello for the extension');
    if (simulatedDialogs() !== dialogs0 + 1) fail('unlockRequest did not ask Windows Hello exactly once');
    await api.lock();
    process.env.KVPWSAFE_TEST_HELLO_CARD = 'no';
    const dialogs1 = simulatedDialogs();
    if (await rejects(bridge.unlockRequest()) !== 'HelloRefused') fail('a card refused in Keevault did not refuse the unlock');
    if (simulatedDialogs() !== dialogs1) fail('Windows Hello was asked although the card was refused');
    if (await rejects(bridge.unlockRequest()) !== 'HelloWait') fail('no wait after a refused request');
    if ((await api.state()).opened) fail('a refused unlockRequest opened the vault');
    delete process.env.KVPWSAFE_TEST_HELLO_CARD;
    await unlockWithMp();
    resetPinGuard();
    if (!(await rejects(api.disableHelloUnlock({ password: 'not the master password' })))) fail('Hello switched off without the master password');
    if (!helloOn()) fail('a wrong master password switched Hello off');
    config.org = { ...config.org, windowHello: false }; // policy WindowHello = 0
    const info = await api.helloKeyInfo();
    if (info.allowed || helloOn()) fail(`the organization's ban left Hello on: ${JSON.stringify(info)}`);
    resetPinGuard();
    if (await rejects(api.enableHelloUnlock({ password: MP })) !== 'HelloForbidden') fail('Hello switched on despite the ban');
  } finally {
    delete process.env.KVPWSAFE_TEST_HELLO;
    delete process.env.KVPWSAFE_TEST_HELLO_CARD;
    await js(closeDialogs);
    config.org = org;
    config.update(before);
    resetPinGuard();
    changed();
    await sleep(400);
  }
  return undefined;
}
