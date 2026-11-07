// Smoke checks of the first start (#399): the wizards open once, also when the window draws twice at the same moment, and
// nothing starts over after they end. Part of the feature checks (desktop/smoke-features.js), which have reached their
// size limit. Uses the demo's OneDrive stand-in, never a real folder.

import { rm } from 'node:fs/promises';
import { until } from './smoke-wait.js';

const PERSONAL = 'dialog[open].wizard-modal .wizard:not(.vault-wizard)';
const count = (js, selector) => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

/** What both checks need: the first start again, driven through the personal vault wizard. */
export function firstStartDriver({ js, sleep, api, config, changed, ensurePin, kvc }) {
  const before = { personalVaults: config.get().personalVaults, setupOffered: config.get().setupOffered, personalRecoveryPending: config.get().personalRecoveryPending, personalRecoveryRenewed: config.get().personalRecoveryRenewed };
  const step = () => js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-steps li`)})].findIndex((l) => l.classList.contains("on"))`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  const primary = () => js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn.primary`)})].at(-1)?.click(); true`);
  const fill = (selector, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (i) { i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); } return !!i; })()`);
  const atStep = (n, limit = 5000) => until(async () => (await step()) === n, limit);

  return {
    step, click, primary, atStep,
    /** Where the wizard stopped and what it said: without this a stop at a step tells nothing about why. */
    stopped: async () => `at step ${await step()}, message: "${await js('document.getElementById("toast")?.textContent || ""')}", personal vaults: ${config.get().personalVaults?.length}`,
    /** The way it happens at a first start: two draws at the same moment, no dialog open, the offer not saved yet. */
    async trigger() {
      // In a full run the personal vault flow left its vault: a first start knows no personal vault yet.
      config.update({ setupOffered: false, personalVaults: [] });
      await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); window.kvSmokeWizards = true; document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
      return until(async () => (await count(js, PERSONAL)) > 0, 4000);
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
      await js('window.kvSmokeWizards = false; window.kvSmokeWindowShown = false; document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
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

    // Set up to the end: nothing opens after it, the vault exists once.
    await drive.throughProtection();
    if (!(await drive.atStep(3, 15000))) return fail('firstwizard', `vault not created, ${await drive.stopped()}`);
    if (config.get().personalVaults.length !== 1) fail('firstwizard', `${config.get().personalVaults.length} personal vaults after creating`);
    await drive.click(`${PERSONAL} label.inline input[type=checkbox]`);
    await drive.primary(); // the key confirmed
    await drive.atStep(4);
    await drive.click(`${PERSONAL} .wizard-buttons .btn`); // skip the FIDO key
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
