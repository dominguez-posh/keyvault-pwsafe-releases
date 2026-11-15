// Smoke check of the #537 live test: an installation from before (app PIN) that moves to the master password gets
// "Windows Hello aktivieren?" once after that – the first start (which asks it) never runs there. With the old PIN kept,
// only Hello is offered (the PIN counts as the chosen alternative); without it, the app PIN as the alternative too. The
// question is remembered on the device (helloOffered) and does not come again. Hello is simulated (KVPWSAFE_TEST_HELLO).

import { until } from './smoke-wait.js';

const MP = 'Smoke-Upgrade-537!';
const OFFER = 'dialog[open].hello-offer-modal';
const rerender = 'document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); window.kvSmokeHelloOffer = true; window.kvSmokeHelloOfferReset = true; document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true';

export async function helloOfferCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'helloOffered'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const hello = process.env.KVPWSAFE_TEST_HELLO;
  const has = (sel) => js(`!!document.querySelector(${JSON.stringify(`${OFFER} ${sel}`)})`);
  /** An installation of 0.9.34: app PIN, no master password; unlocked with the PIN, then moved (PIN kept or not). */
  const upgrade = async (keepPin) => {
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], helloOffered: false });
    const pin = await ensurePin();
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    await api.setupMasterPassword({ password: MP, pin, keepPin });
    changed();
    await sleep(300);
    await js(rerender);
  };
  try {
    process.env.KVPWSAFE_TEST_HELLO = 'sign';

    // 1. PIN kept: only Hello, the master password asked in the dialog; switching Hello on remembers the question.
    await upgrade(true);
    if (!(await api.state()).unlock?.helloOffer) fail('after the move with the PIN kept the question is not due');
    if (!(await until(() => js(`!!document.querySelector(${JSON.stringify(OFFER)})`), 6000))) return fail('after the upgrade "Windows Hello aktivieren?" did not come');
    if (!(await until(() => has('.first-hello-on'), 4000))) return fail('the question offers no "Windows Hello aktivieren"');
    if (await has('.first-choose-pin')) fail('with the PIN kept, the app PIN is still offered as the alternative');
    if (!(await has('.first-unlock-skip'))) fail('the question offers no "Überspringen – nur Masterpasswort"');
    if (!(await has('.hello-offer-mp'))) fail('the question asks no master password (needed to switch Hello on)');
    if (!config.get().helloOffered) fail('the question was not remembered on the device');
    await js(`(() => { const i = document.querySelector(${JSON.stringify(`${OFFER} .hello-offer-mp`)}); i.value = ${JSON.stringify(MP)}; document.querySelector(${JSON.stringify(`${OFFER} .first-hello-on`)}).click(); return true; })()`);
    if (!(await until(() => !!config.get().unlockKeys?.hello, 8000))) fail('"Windows Hello aktivieren" in the question did not switch Hello on');
    await js(rerender);
    await sleep(1200);
    if (await js(`!!document.querySelector(${JSON.stringify(OFFER)})`)) fail('the question came again after Hello was switched on');

    // 2. Without the PIN: Hello or the app PIN; skipping is remembered too and the question never comes again.
    resetPinGuard?.();
    await upgrade(false);
    if (!(await until(() => has('.first-hello-on'), 6000))) return fail('without a PIN: the question did not come');
    if (!(await has('.first-choose-pin'))) fail('without a PIN: the app PIN is not offered as the alternative');
    await js(`document.querySelector(${JSON.stringify(`${OFFER} .first-unlock-skip`)}).click(); true`);
    if (!(await until(async () => !(await js(`!!document.querySelector(${JSON.stringify(OFFER)})`)), 3000))) fail('"Überspringen" did not close the question');
    if (config.get().unlockKeys?.hello) fail('skipping switched Hello on');
    if (!config.get().helloOffered) fail('skipping was not remembered');
    await js(rerender);
    await sleep(1200);
    if (await js(`!!document.querySelector(${JSON.stringify(OFFER)})`)) fail('the question came again after "Überspringen"');
  } catch (e) {
    fail(e.message);
  } finally {
    await js('window.kvSmokeHelloOffer = false; document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    if (hello === undefined) delete process.env.KVPWSAFE_TEST_HELLO; else process.env.KVPWSAFE_TEST_HELLO = hello;
    config.update(before);
    await ensurePin();
    resetPinGuard?.();
    changed();
  }
  return undefined;
}
