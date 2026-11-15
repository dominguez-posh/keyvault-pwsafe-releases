// Smoke checks of the first start (#399): the wizards open once, also when the window draws twice at the same moment, and
// nothing starts over after they end. Part of the feature checks (desktop/smoke-features.js), which have reached their
// size limit. Uses the demo's OneDrive stand-in, never a real folder.

import { rm } from 'node:fs/promises';
import { until } from './smoke-wait.js';
import { personalStorageCheck } from './smoke-personal-storage.js';
import { fidoStepCheck } from './smoke-fido-step.js';

const PERSONAL = 'dialog[open].wizard-modal .wizard:not(.vault-wizard):not(.first-start-wizard)';
const ACCOUNT = 'dialog[open].wizard-modal .first-start-wizard';
const count = (js, selector) => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

/** What both checks need: the first start again, driven through the personal vault wizard. */
export function firstStartDriver({ js, sleep, api, config, changed, ensurePin, kvc }) {
  const before = { personalVaults: config.get().personalVaults, setupOffered: config.get().setupOffered, personalRecoveryPending: config.get().personalRecoveryPending, personalRecoveryRenewed: config.get().personalRecoveryRenewed, appPin: config.get().appPin, entraUsed: config.get().entraUsed };
  const step = () => js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-steps li`)})].findIndex((l) => l.classList.contains("on"))`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  const primary = () => js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn.primary`)})].at(-1)?.click(); true`);
  const fill = (selector, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (i) { i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); } return !!i; })()`);
  const atStep = (n, limit = 5000) => until(async () => (await step()) === n, limit);

  return {
    step, click, primary, atStep,
    /** Where the wizard stopped and what it said: without this a stop at a step tells nothing about why. */
    stopped: async () => `at step ${await step()}, message: "${await js('document.getElementById("toast")?.textContent || ""')}", personal vaults: ${config.get().personalVaults?.length}, buttons: ${await js(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn`)})].map((b) => b.textContent + (b.disabled ? " (busy)" : "")))`)}, dialog: "${(await js(`(document.querySelector(${JSON.stringify(PERSONAL)})?.innerText || "").replace(/\\s+/g, " ").slice(0, 400)`))}"`,
    /** The way it happens at a first start: two draws at the same moment, no dialog open, the offer not saved yet. */
    async trigger(selector = PERSONAL) {
      // In a full run the personal vault flow left its vault: a first start knows no personal vault yet.
      config.update({ setupOffered: false, personalVaults: [] });
      await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); window.kvSmokeWizards = true; document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
      return until(async () => (await count(js, selector)) > 0, 4000);
    },
    /** From the start through location and protection: a new vault, or the one already in the folder. */
    async throughProtection(mode = 'create') {
      const pin = await ensurePin();
      await primary();
      await atStep(1);
      await primary();
      await atStep(2);
      await fill(`${PERSONAL} input[type=password]`, 'Assistent-Test-123!');
      if (mode === 'create') await js(`(() => { const i = document.querySelectorAll(${JSON.stringify(`${PERSONAL} input[type=password]`)})[1]; i.value = "Assistent-Test-123!"; i.dispatchEvent(new Event("input")); return true; })()`);
      await fill(`${PERSONAL} .wiz-pin`, pin);
      await primary();
    },
    /** The vault made here is gone, its file too unless keepFile. */
    async removeVault({ keepFile = false } = {}) {
      const info = await api.personalInfo();
      const c = (await api.state()).containers.find((x) => x.path === info.path);
      if (c) await api.removeContainer(c.id);
      config.update({ personalVaults: [] });
      if (!keepFile && info.path) await rm(info.path, { force: true });
    },
    /** Back to the state before; the following checks work in the demo's team vault again. */
    async restore() {
      await js('window.kvSmokeWizards = false; window.kvSmokeWindowShown = false; window.kvSmokeAccountStep = false; window.kvSmokeSignedOut = false; document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
      await sleep(300);
      await this.removeVault();
      config.update(before);
      // A lock on the way left the personal vault of a full run closed, it wasn't marked as personal then.
      if (before.personalVaults?.length) await api.verifyPin(await ensurePin());
      changed();
      await sleep(500);
      await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click(); true`);
      await sleep(400);
    },
  };
}

export async function firstStartCheck(ctx) {
  const { js, sleep, fail, config } = ctx;
  const drive = firstStartDriver(ctx);
  const gone = () => until(async () => (await count(js, 'dialog[open]')) === 0, 2000);
  try {
    // Two draws at the same moment: one wizard, not one waiting below the other.
    if (!(await drive.trigger())) return fail('firstwizard', 'wizard did not open at the first start');
    await sleep(1200);
    const open = await count(js, PERSONAL);
    if (open !== 1) return fail('firstwizard', `${open} wizards open at the first start`);
    await personalStorageCheck(ctx, drive); // #516: "OneDrive direkt" shown, greyed out

    // Set up to the end: nothing opens after it, the vault exists once.
    await drive.throughProtection();
    if (!(await drive.atStep(3, 15000))) return fail('firstwizard', `vault not created, ${await drive.stopped()}`);
    if (config.get().personalVaults.length !== 1) fail('firstwizard', `${config.get().personalVaults.length} personal vaults after creating`);
    await drive.click(`${PERSONAL} label.inline input[type=checkbox]`);
    await drive.primary(); // the key confirmed
    await drive.atStep(4);
    await fidoStepCheck(ctx); // #531: a security key added here is recognised, one without PRF says so
    await drive.click(`${PERSONAL} .wizard-buttons .btn`); // on past the FIDO step
    await drive.atStep(5);
    if (!(await js(`/team/i.test(document.querySelector(${JSON.stringify(`${PERSONAL} .wizard-buttons`)})?.textContent || "")`))) fail('firstwizard', 'last step does not offer the team vault');
    await drive.primary();
    if (!(await gone())) fail('firstwizard', 'dialog still open after "Done"');
    await sleep(1200);
    const after = await count(js, 'dialog[open]');
    if (after) fail('firstwizard', `${after} dialogs opened by themselves after "Done": ${await js('[...document.querySelectorAll("dialog[open] h3")].map((h) => h.textContent).join(", ")')}`);
    if (config.get().personalVaults.length !== 1) fail('firstwizard', `${config.get().personalVaults.length} personal vaults after "Done"`);

    // The offer is used up: drawn again, nothing opens.
    await js('document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    await sleep(1200);
    if (await count(js, '.wizard')) fail('firstwizard', 'wizard opened again after it was offered');

    // Adopting the vault already in the folder: no second one, and the wizard goes on past protection.
    await drive.removeVault({ keepFile: true });
    if (!(await drive.trigger())) return fail('firstwizard', 'wizard did not open for the existing vault');
    await drive.throughProtection('use');
    // It has its recovery key already: past the key step, and nothing to confirm.
    if (!(await drive.atStep(4, 15000))) fail('firstwizard', `existing vault not adopted, at step ${await drive.step()}`);
    if (Object.keys(config.get().personalRecoveryPending || {}).length) fail('firstwizard', 'adopted vault asks to confirm a recovery key');
    if (config.get().personalVaults.length !== 1) fail('firstwizard', `${config.get().personalVaults.length} personal vaults after adopting`);
    await drive.click('dialog[open].wizard-modal .modal-head .icon-btn');
    if (!(await gone())) fail('firstwizard', 'closing the wizard after adopting left a dialog open');
    await drive.removeVault();

    // Abort at the start: the wizard does not come back; only the team vault wizard is left to offer.
    if (!(await drive.trigger())) return fail('firstwizard', 'wizard did not open for the abort');
    await drive.click('dialog[open].wizard-modal .modal-head .icon-btn');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .vault-wizard")'), 3000))) fail('firstwizard', 'team vault wizard does not follow an abort');
    if (await count(js, PERSONAL)) fail('firstwizard', 'personal vault wizard came back after the abort');
  } finally {
    await drive.restore();
  }
  return undefined;
}

/**
 * #515: a fresh profile starts with the Microsoft sign-in, then the master password (#537), then Windows Hello or the
 * app PIN (#537 stage 3), then the rest
 * (the personal vault wizard; the rest itself is checked by firstStartCheck). The demo is signed in already:
 * kvSmokeSignedOut makes the step offer the sign-in itself, with the demo's stand-in account.
 */
export async function firstAccountCheck(ctx) {
  const { js, sleep, config, api } = ctx;
  const f = (msg) => ctx.fail('firstaccount', msg);
  const drive = firstStartDriver(ctx);
  const accountStep = () => js(`[...document.querySelectorAll(${JSON.stringify(`${ACCOUNT} .wizard-steps li`)})].findIndex((l) => l.classList.contains("on"))`);
  // #537: the second step sets the master password (required) and optionally a PIN for this device.
  const setFields = (values) => js(`(() => { const set = (s, v) => { const i = document.querySelector(${JSON.stringify(ACCOUNT)} + " " + s); if (i) { i.value = v; } return !!i; }; return ${JSON.stringify(Object.entries(values))}.every(([s, v]) => set(s, v)); })()`);
  const MP = 'Smoke-First-537!';
  const closeAll = async () => {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    await until(async () => (await count(js, 'dialog[open]')) === 0, 3000);
  };
  const personalNext = () => until(async () => (await count(js, PERSONAL)) > 0 && !(await count(js, ACCOUNT)), 6000);
  try {
    config.update({ appPin: null, unlockKeys: null, entraUsed: false });
    await js('window.kvSmokeAccountStep = true; window.kvSmokeSignedOut = true; true');

    // First pass: sign in, then close the wizard at the master password step (required, so no "Später").
    if (!(await drive.trigger(ACCOUNT))) return f('the sign-in step did not open at the first start');
    await sleep(600);
    if (await count(js, PERSONAL)) f('the personal vault wizard opened before the sign-in step');
    if ((await accountStep()) !== 0) f(`starts at step ${await accountStep()}, not at the sign-in`);
    if (!(await count(js, `${ACCOUNT} .first-skip-signin`))) f('the sign-in step offers no way on without a Microsoft account');
    if (!(await count(js, `${ACCOUNT} .first-signin`))) return f('no "Mit Microsoft anmelden" button in the first step');
    await drive.click(`${ACCOUNT} .first-signin`);
    if (!(await until(async () => (await accountStep()) === 1, 6000))) return f(`the master password step did not follow the sign-in (step ${await accountStep()})`);
    if (!config.get().entraUsed) f('signing in at the first start did not note that Entra is used');
    if (!(await count(js, `${ACCOUNT} .first-mp`))) return f('the second step asks no master password');
    if (await count(js, `${ACCOUNT} .first-pin-later`)) f('the master password step offers "Später" (E2: required for a new installation)');
    await js(`document.querySelector(${JSON.stringify(ACCOUNT)})?.closest('dialog')?.querySelector('.modal-head .icon-btn')?.click(); true`);
    if (!(await personalNext())) f('the personal vault wizard did not follow closing the step');
    if (config.get().appPin || config.get().unlockKeys) f('closing the step set a PIN or master password');
    await closeAll(); // the personal vault wizard, then the team vault wizard that follows an abort
    await closeAll();

    // Second pass: signed in now, set the master password – too short first, then valid. Without Windows Hello on this
    // (simulated) device the next step offers the app PIN directly (#537 stage 3, Lucas): a PIN too short (#475), then valid.
    delete process.env.KVPWSAFE_TEST_HELLO;
    if (!(await drive.trigger(ACCOUNT))) return f('the sign-in step did not open the second time');
    await sleep(400);
    if (await count(js, `${ACCOUNT} .first-signin`)) f('signed in, the step still offers to sign in');
    await drive.click(`${ACCOUNT} .wizard-buttons .btn.primary`);
    if (!(await until(async () => (await accountStep()) === 1, 4000))) return f('"Weiter" did not lead to the master password step');
    if (await count(js, `${ACCOUNT} .first-pin`)) f('the master password step still asks a PIN (it comes after it now)');
    await setFields({ '.first-mp': 'short-11-ch', '.first-mp2': 'short-11-ch' });
    await drive.click(`${ACCOUNT} .first-mp-save`);
    await sleep(600);
    if (config.get().unlockKeys) f('a master password of 11 characters was accepted');
    await setFields({ '.first-mp': MP, '.first-mp2': MP });
    await drive.click(`${ACCOUNT} .first-mp-save`);
    if (!(await until(() => !!config.get().unlockKeys?.blob, 8000))) return f('the master password was not set up');
    if (!(await until(async () => (await accountStep()) === 2 && (await count(js, `${ACCOUNT} .first-pin`)) > 0, 6000))) return f('without Windows Hello the unlock step offers no app PIN');
    if (await count(js, `${ACCOUNT} .first-hello-on`)) f('Windows Hello offered although it is not set up');
    await setFields({ '.first-pin': '12345', '.first-pin2': '12345' });
    await drive.click(`${ACCOUNT} .first-pin-save`);
    await sleep(800);
    if ((await api.state()).unlock?.pin) f('a PIN of 5 characters was accepted');
    if (!(await count(js, ACCOUNT))) return f('the step closed after a refused PIN');
    await setFields({ '.first-pin': '246813', '.first-pin2': '246813' });
    await drive.click(`${ACCOUNT} .first-pin-save`);
    if (!(await until(async () => !!(await api.state()).unlock?.pin, 6000))) f('the app PIN was not set as a wrapper');
    else if (config.get().appPin?.random) f('N1: with a PIN, appPin is not the hash of that PIN');
    if (!(await personalNext())) f('the personal vault wizard did not follow the unlock step');
    await closeAll();
    await closeAll();

    // Third pass: Windows Hello there (simulated) – "Windows Hello aktivieren?" recommended, the PIN only the alternative.
    config.update({ unlockKeys: null, appPin: null });
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    if (!(await drive.trigger(ACCOUNT))) return f('the sign-in step did not open the third time');
    await sleep(400);
    await drive.click(`${ACCOUNT} .wizard-buttons .btn.primary`);
    if (!(await until(async () => (await accountStep()) === 1, 4000))) return f('third pass: no master password step');
    await setFields({ '.first-mp': MP, '.first-mp2': MP });
    await drive.click(`${ACCOUNT} .first-mp-save`);
    if (!(await until(async () => (await count(js, `${ACCOUNT} .first-hello-on`)) > 0, 8000))) return f('with Windows Hello the unlock step does not ask "Windows Hello aktivieren?"');
    if (!(await count(js, `${ACCOUNT} .first-choose-pin`))) f('the app PIN is not offered as the alternative');
    if (await count(js, `${ACCOUNT} .first-pin`)) f('the PIN fields show before choosing the alternative');
    await drive.click(`${ACCOUNT} .first-hello-on`);
    if (!(await until(() => !!config.get().unlockKeys?.hello, 8000))) f('"Windows Hello aktivieren" did not switch Hello on');
    if (!(await personalNext())) f('the personal vault wizard did not follow switching Hello on');
  } finally {
    // The other checks run on the app PIN: back to it (#537 has its own areas, "masterpw" and "hellokey"). First, so
    // that restoring (which unlocks a personal vault of a full run with the PIN) finds the PIN, not this master password.
    delete process.env.KVPWSAFE_TEST_HELLO;
    config.update({ unlockKeys: null, appPin: null });
    await ctx.ensurePin?.();
    await drive.restore();
  }
  return undefined;
}
