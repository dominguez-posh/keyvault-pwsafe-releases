// Smoke check of the recovery key in the personal vault wizard (#399): shown in the wizard, no way on without confirming,
// closing is no confirmation and starts nothing over. Later the app only asks: a new key comes from the click alone, a
// key made another way stays, nobody is asked behind a hidden window, locking leaves no key on screen, and the key is
// never written down. Part of the feature checks (desktop/smoke-features.js), which have reached their size limit.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nextFrame, until } from './smoke-wait.js';
import { firstStartDriver } from './smoke-first-start.js';
import { rekeyCheck } from './smoke-rekey.js';
import { KEY_CHANGE } from '../extension/core/protect.js';

const PERSONAL = 'dialog[open].wizard-modal .wizard:not(.vault-wizard)';
const KEY = /^RK-[A-Z2-7-]+$/;

export async function recoveryKeyCheck(ctx) {
  const { js, sleep, fail, api, config, changed, ensurePin } = ctx;
  const drive = firstStartDriver(ctx);
  const codeIn = (selector) => js(`document.querySelector(${JSON.stringify(`${selector} .code-box code`)})?.textContent || ""`);
  const dialogs = () => js('document.querySelectorAll("dialog[open]").length');
  const closeTop = () => js('[...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(".modal-head .icon-btn")?.click(); true');
  const noDialogs = () => until(async () => (await dialogs()) === 0, 2000);
  const mark = (id) => config.get().personalRecoveryPending?.[id];
  const waiting = async (id) => (await api.state()).recoveryPending.includes(id);
  const notice = () => js('!!document.querySelector(".recovery-due")');
  const asked = () => until(() => js('!!document.querySelector("dialog[open].recovery-ask")'), 3000);
  const answer = (index) => js(`document.querySelectorAll("dialog[open].recovery-ask .modal-footer .btn")[${index}]?.click(); true`);
  const [LATER, KEPT, NEW] = [0, 1, 2];
  const clickNotice = async () => {
    await until(notice, 3000);
    await js('document.querySelector(".recovery-due")?.click(); true');
    return asked();
  };
  const newKey = async (button = NEW) => {
    await answer(button);
    // With the key change switched on (#402) the new master password comes first.
    if (KEY_CHANGE.enabled) await until(() => js('!!document.querySelector("dialog[open] input[data-rekey=password]")'), 3000);
    // The key change can still be cancelled; with passkeys in the list, it says before that they must be added again.
    if (KEY_CHANGE.enabled && await js('!!document.querySelector("dialog[open] [data-rekey=dialog]") && ![...document.querySelectorAll("dialog[open] .modal-footer .btn")].some((b) => !b.classList.contains("primary"))')) fail('the key change dialog has no way to cancel');
    if (KEY_CHANGE.enabled && await js('(() => { const d = document.querySelector("dialog[open] [data-rekey=dialog]"); return !!d && /Passkey/.test(d.textContent) && !/entfallen keine/.test(d.textContent) && !d.querySelector("[data-rekey=passkeys-lost]"); })()')) fail('the key change dialog drops passkeys without saying they must be added again');
    if (KEY_CHANGE.enabled) await js('for (const i of document.querySelectorAll("dialog[open] input[data-rekey]")) { i.value = "renewed-password-1"; i.dispatchEvent(new Event("input", { bubbles: true })); } document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); true');
    await until(async () => KEY.test(await codeIn('dialog[open]')), 5000);
    return codeIn('dialog[open]');
  };
  // The mark again, for the current key: what a person who never confirmed would have.
  const markAgain = (id, entry) => {
    config.update({ personalRecoveryPending: { [id]: entry } });
    changed();
  };
  const unlock = async () => {
    await api.verifyPin(await ensurePin());
    await api.unlock({ entra: true });
    changed();
  };
  // The hard limit: the key is in no file in the clear, not in the settings, not in the vault file, not in the log.
  const notStored = async (key, where) => {
    const info = await api.personalInfo();
    const places = [config.file, info.path, path.join(path.dirname(config.file), 'keevault.log')];
    for (const file of places) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes(key) || text.includes(key.replaceAll('-', ''))) fail(`recovery key found in ${path.basename(file)} (${where})`);
    }
  };

  try {
    if (!(await drive.trigger())) return fail('wizard did not open');
    await drive.throughProtection();
    if (!(await drive.atStep(3, 15000))) return fail(`no key step after creating, ${await drive.stopped()}`);

    // Shown in the wizard itself; without the box there is no way on.
    const first = await codeIn(PERSONAL);
    if (!KEY.test(first)) return fail(`no recovery key shown in the wizard: "${first.slice(0, 3)}…"`);
    const id = Object.keys(config.get().personalRecoveryPending || {})[0];
    const entry = mark(id);
    if (!id || !entry) return fail('the new vault is not marked as waiting for a confirmation');
    await notStored(first, 'key step');
    const blocked = await js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn.primary`)})].at(-1)?.disabled === true`);
    if (!blocked) fail('"Next" can be used without confirming');
    await drive.primary();
    await sleep(300);
    if ((await drive.step()) !== 3) fail('went on without confirming');
    const scroll = await js('(() => { const b = document.querySelector("dialog[open].wizard-modal .modal-body"); return b.scrollHeight - b.clientHeight; })()');
    if (scroll > 1) fail(`key step scrolls by ${scroll} px`);

    // Locking with the key on screen: gone from the page, still not confirmed, no wizard on the lock screen.
    await api.lock();
    if (!(await until(() => js('!document.querySelector(".code-box")'), 3000))) fail('the key stays on the page after locking');
    await sleep(600);
    if (await dialogs()) fail(`${await dialogs()} dialogs open on the lock screen`);
    if (mark(id) !== entry) fail('locking changed the mark');

    // Unlocked with the window hidden (browser extension, tray): no question and no new key.
    await unlock();
    await sleep(1500);
    if (await dialogs()) fail('asked behind a hidden window');
    if (mark(id) !== entry) fail('the key was changed behind a hidden window');
    if (!(await until(notice, 3000))) return fail('no notice in the sidebar after unlocking');

    // The window comes to the front: it asks, and asking changes nothing. No wizard from the start.
    await js('window.kvSmokeWindowShown = true; window.dispatchEvent(new Event("focus")); true');
    if (!(await asked())) return fail('does not ask when the window comes to the front');
    if (await js('!!document.querySelector(".code-box")')) fail('a key is shown before anyone asked for one');
    if (await js('!!document.querySelector("dialog[open] .wizard")')) fail('a wizard opened with the question');
    if (mark(id) !== entry) fail('asking changed the key');
    await answer(LATER);
    await noDialogs();
    await sleep(600);
    if (await dialogs()) fail('the question came back right after "Later"');
    if (mark(id) !== entry) fail('"Later" changed the key');

    // "I have stored it" for the key of the wizard: confirmed, and no new key. The mark again for the checks below.
    if (!(await clickNotice())) return fail('the notice does not ask');
    await answer(KEPT);
    await until(() => !mark(id), 3000);
    if (mark(id)) fail('"I have stored it" was not saved');
    await noDialogs();
    if (await js('!!document.querySelector(".code-box")')) fail('"I have stored it" shows a key');
    markAgain(id, entry);
    await until(notice, 3000);

    // Two clicks on the notice, one question.
    await js('document.querySelector(".recovery-due").click(); document.querySelector(".recovery-due").click(); true');
    await asked();
    await sleep(300);
    if ((await dialogs()) !== 1) fail(`${await dialogs()} dialogs after two clicks on the notice`);

    // The click makes the new key; closed without confirming, it still waits.
    const second = await newKey();
    if (!KEY.test(second) || second === first) fail('"Create a new key" shows no new key');
    const secondEntry = mark(id);
    if (!secondEntry || secondEntry === entry) fail('the mark does not follow the new key');
    if (!(await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.disabled === true'))) fail('"Done" can be used without confirming');
    await notStored(second, 'new key');
    await closeTop();
    await noDialogs();
    // Closing ends the question only with the dialog's close event, in the next frame; until then a click on the notice is
    // ignored. A person can't click that fast (60 frames a second), a check in a never shown window (one a second) can.
    await nextFrame(js);
    if (!mark(id) || !(await waiting(id))) fail('closing the key dialog counted as confirming');

    // The window reloads its state after the change (renewal, closing); asked before that, the question still shows the old state.
    await until(async () => (await api.state()).recoveryRenewed.includes(id), 3000);
    await sleep(800);
    // Konrad F12: that key was never confirmed, so "I have stored it" is no longer offered, only a new key.
    if (!(await clickNotice())) return fail('the notice does not ask');
    const buttons = await js('[...document.querySelectorAll("dialog[open].recovery-ask .modal-footer .btn")].length');
    if (buttons !== 2) fail(`"I have stored it" is offered for a renewed key nobody confirmed (${buttons} buttons)`);

    // Box and button confirm a new key: the notice goes and the reminder can't change the key any more.
    await newKey(1);
    const thirdEntry = mark(id);
    if (!thirdEntry || thirdEntry === secondEntry) fail('the mark does not follow the key made after a renewal');
    await js('document.querySelector("dialog[open] label.inline input[type=checkbox]")?.click(); true');
    await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); true');
    await until(() => !mark(id), 3000);
    if (mark(id)) fail('confirming the new key was not saved');
    if (!(await until(async () => !(await notice()), 3000))) fail('notice still there after confirming');
    if (await api.renewPersonalRecovery(id).then(() => true, () => false)) fail('a confirmed key can be replaced through the reminder');

    // A key made in the protection dialog (the same for another device): that key stays, the mark goes, nothing asks.
    markAgain(id, thirdEntry);
    if (!(await waiting(id))) fail('the mark does not fit the current key');
    await api.updateProtection(id, KEY_CHANGE.enabled ? { type: 'rekey', password: 'renewed-password-2' } : { type: 'newRecovery' });
    if (await waiting(id)) fail('still waits although the key was made in the protection dialog');
    if (mark(id)) fail('the mark stays although it no longer fits the key');
    await api.lock();
    await until(() => js('!!document.querySelector(".pin-input")'), 5000);
    await unlock();
    await sleep(1500);
    if (await dialogs()) fail('asked after unlocking although the key was made in the protection dialog');
    if (await notice()) fail('notice although the key was made in the protection dialog');
    // Real key change (#402), switched on since 0.9.34: always checked, a switched-off flag is reported.
    if (!KEY_CHANGE.enabled) fail('the key change (#402) is switched off (protect.js KEY_CHANGE)');
    else await rekeyCheck({ api, fail });
  } finally {
    await drive.restore();
  }
  return undefined;
}
