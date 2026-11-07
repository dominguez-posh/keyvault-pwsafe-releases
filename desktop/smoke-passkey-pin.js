// Smoke checks of #439: every passkey use asks for the app PIN (setting, AI agents, Windows provider). Part of the feature
// checks (desktop/smoke-features.js), which have reached their size limit.

import { questionsGone, until } from './smoke-wait.js';

const SECURITY_TAB = '[...document.querySelectorAll("dialog[open] .tabs button")].find((b) => /^(Sicherheit|Security)$/.test(b.textContent.trim()))?.click()';

/** The settings dialog on its Security tab; the window takes a changed setting over with its next reload, so it may take a try. */
async function openSecurityTab({ js, sleep }, wanted) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu, .main-menu")?.remove(); true');
    await sleep(500);
    await js('document.querySelector(".menu-btn")?.click()');
    await until(() => js('!!document.querySelector(".main-menu [data-action=settings]")'), 1000);
    await js('document.querySelector(".main-menu [data-action=settings]")?.click()');
    await until(() => js('!!document.querySelector("dialog[open] .tabs button")'), 1500);
    await js(SECURITY_TAB);
    await sleep(300);
    const box = JSON.parse(await js('JSON.stringify((() => { const c = document.querySelector("dialog[open] input[name=passkeyPin]"); return c ? { checked: c.checked, disabled: c.disabled } : null; })())'));
    if (box && (!wanted || (box.checked === wanted.checked && box.disabled === wanted.disabled))) return box;
  }
  return JSON.parse(await js('JSON.stringify((() => { const c = document.querySelector("dialog[open] input[name=passkeyPin]"); return c ? { checked: c.checked, disabled: c.disabled } : null; })())'));
}

const dialogButton = (label) => `[...document.querySelectorAll("dialog[open]")].at(-1)?.querySelectorAll(".modal-footer .btn") && [...[...document.querySelectorAll("dialog[open]")].at(-1).querySelectorAll(".modal-footer .btn")].find((b) => ${label}.test(b.textContent.trim()))?.click()`;

/** Setting "PIN before every passkey use": on by default, off only after a warning, fixed on by the policy RequirePin. */
export async function passkeyPinSettingCheck({ js, sleep, fail, config, changed }) {
  const area = 'passkeypin';
  const before = { passkeyPin: config.get().passkeyPin, requirePin: config.get().requirePin };
  try {
    config.update({ passkeyPin: true, requirePin: false });
    changed();
    const def = await openSecurityTab({ js, sleep }, { checked: true, disabled: false });
    if (!def) return fail(area, 'settings (Security) without the switch "PIN before every passkey use"');
    if (!def.checked) fail(area, 'the PIN before passkey use is not on by default');
    if (def.disabled) fail(area, 'the switch is locked without a policy');

    // Switching off asks first; "Cancel" leaves it on.
    await js('document.querySelector("dialog[open] input[name=passkeyPin]").click()');
    await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
    if (!(await until(() => js(`[...document.querySelectorAll("dialog[open]")].length > 1 && /Ausschalten|Turn off/.test([...document.querySelectorAll("dialog[open]")].at(-1).textContent)`), 2000))) {
      fail(area, 'switching the PIN off saved without a warning');
    } else {
      await js(dialogButton('/^(Abbrechen|Cancel)$/'));
      await sleep(600);
      if (config.get().passkeyPin === false) fail(area, 'cancelling the warning still switched the PIN off');
      // Confirmed: off.
      await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
      await until(() => js(`[...document.querySelectorAll("dialog[open]")].length > 1 && /Ausschalten|Turn off/.test([...document.querySelectorAll("dialog[open]")].at(-1).textContent)`), 2000);
      await js(dialogButton('/^(Ausschalten|Turn off)$/'));
      if (!(await until(() => config.get().passkeyPin === false, 3000))) fail(area, 'confirmed warning did not switch the PIN off');
    }

    // The policy RequirePin: fixed on, whatever the user chose.
    config.update({ requirePin: true });
    changed();
    const fixed = await openSecurityTab({ js, sleep }, { checked: true, disabled: true });
    if (!fixed || !fixed.checked || !fixed.disabled) fail(area, `RequirePin: the switch is not fixed on (${JSON.stringify(fixed)})`);
  } finally {
    config.update(before);
    changed();
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
  }
}

const ASK = { agent: 'smoke-agent', title: 'GitHub', username: 'alice', vault: 'Smoke', rpId: 'github.com', origin: 'https://github.com' };
const QUESTION = 'dialog[open] .question.agent-passkey';
const CONFIRM_WAIT = 2500; // longer than the delay before "Allow" works (CONFIRM_DELAY_MS in renderer/app/requests.js)

/** AI agent (MCP sign_in_with_passkey): the PIN is typed in the question in the app; the agent never types it. */
export async function passkeyPinAgentCheck({ js, sleep, fail, config, changed, confirmAgentPasskey, ensurePin, resetPinGuard, openQuestionIds, api }) {
  const area = 'passkeypinagent';
  const pin = await ensurePin();
  const settle = (promise, ms = 700) => Promise.race([promise, sleep(ms).then(() => 'open')]);
  const waitAllow = () => until(() => js(`document.querySelector("${QUESTION} .q-actions .btn.primary")?.getAttribute("aria-disabled") === "false"`), CONFIRM_WAIT);
  const allow = (value) => js(`(() => { const p = document.querySelector("${QUESTION} .q-pin-input"); if (p) p.value = ${JSON.stringify(value)}; document.querySelector("${QUESTION} .q-actions .btn.primary")?.click(); })()`);
  const deny = () => js(`[...document.querySelectorAll("${QUESTION} .q-actions .btn")].find((b) => /Ablehnen|Deny/.test(b.textContent))?.click()`);
  const closeAll = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
  try {
    resetPinGuard();
    // 1. No PIN set: nothing is asked, nothing is signed; the app asks for a PIN instead.
    config.update({ appPin: null });
    changed();
    let refused = null;
    await confirmAgentPasskey(ASK).catch((e) => { refused = e; });
    if (refused?.name !== 'PinNotSet') fail(area, `without a PIN the passkey request was not refused (${refused?.name || 'answered'})`);
    if (await js(`!!document.querySelector("${QUESTION}")`)) fail(area, 'without a PIN the agent got a question to answer');
    await closeAll();
    await ensurePin();
    changed();
    await sleep(500);

    // 2. With a PIN: the question has the PIN field; empty and wrong PINs do not answer it; the right one does, once.
    const asked = confirmAgentPasskey(ASK);
    if (!(await until(() => js(`!!document.querySelector("${QUESTION}")`), 3000))) return fail(area, 'question did not open');
    if (!(await js(`!!document.querySelector("${QUESTION} .q-pin-input")`))) return fail(area, 'question without the PIN field');
    const id = openQuestionIds().at(-1);
    // The window's answer needs the PIN too, an answer without it (any other caller of the IPC) is refused.
    if (await api.answerQuestion(id, 'allow', '').then(() => 'answered', (e) => e.name) !== 'PinRequired') fail(area, 'an answer without PIN was not refused');
    if (await api.answerQuestion(id, 'allow', 'xxxx').then(() => 'answered', (e) => e.name) !== 'PinWrong') fail(area, 'a wrong PIN through the IPC was not refused');
    resetPinGuard();
    await waitAllow();
    await allow('');
    if ((await settle(asked)) !== 'open') fail(area, 'empty PIN answered the question');
    await allow('0000');
    if ((await settle(asked)) !== 'open') fail(area, 'wrong PIN answered the question');
    if (!(await js(`!!document.querySelector("${QUESTION} .q-pin-error:not([hidden])")`))) fail(area, 'wrong PIN: no message in the dialog');
    if (config.get().pinGuard?.failures !== 1) fail(area, `wrong PIN not counted: ${JSON.stringify(config.get().pinGuard)}`);
    await waitAllow();
    await allow(pin);
    if ((await settle(asked, 3000)) !== true) fail(area, 'the right PIN did not allow the passkey use');
    if (config.get().pinGuard) fail(area, 'the counter of wrong PINs stays after a right one');

    // 3. No grace period: the next use asks again, with an empty PIN field.
    const again = confirmAgentPasskey(ASK);
    await until(() => js(`!!document.querySelector("${QUESTION} .q-pin-input")`), 3000);
    if (await js(`document.querySelector("${QUESTION} .q-pin-input")?.value`)) fail(area, 'the PIN of the last use is still in the dialog');
    await waitAllow();
    await allow('');
    if ((await settle(again)) !== 'open') fail(area, 'a second use went through without a PIN');
    await deny();
    if ((await settle(again, 3000)) !== false) fail(area, 'deny did not refuse the passkey use');
    await questionsGone(js);

    // 4. Switched off by the user: the dialog has no PIN field and "Allow" is enough, as before.
    config.update({ passkeyPin: false });
    const off = confirmAgentPasskey(ASK);
    await until(() => js(`!!document.querySelector("${QUESTION}")`), 3000);
    if (await js(`!!document.querySelector("${QUESTION} .q-pin-input")`)) fail(area, 'PIN field although the setting is off');
    await waitAllow();
    await allow('');
    if ((await settle(off, 3000)) !== true) fail(area, 'with the setting off, "Allow" did not allow the passkey use');
    await questionsGone(js);
  } finally {
    config.update({ passkeyPin: true });
    resetPinGuard();
    await deny().catch(() => {});
    await closeAll();
  }
}

/** Windows passkey provider (simulated CTAP request): the PIN is typed in the confirmation, once per use. */
export async function passkeyPinWindowsCheck({ js, sleep, fail, config, changed, windows, vault, api, ensurePin, resetPinGuard }) {
  const area = 'passkeypinwindows';
  const { encode, decode } = await import('../extension/core/cbor.js');
  const { makeCredentialData } = await import('../extension/core/webauthn.js');
  const { b64uEncode, randomBytes, sha256, utf8 } = await import('../extension/core/util.js');
  const rpId = 'smoke-pin.example.com';
  const pin = await ensurePin();
  const target = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.locked && !c.error);
  const { passkey } = await makeCredentialData({ rpId, rpName: 'Smoke', user: { id: b64uEncode(randomBytes(16)), name: 'pin@example.com', displayName: 'Pin' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const entry = await vault.saveItem(target.id, { type: 'login', title: 'Smoke PIN Passkey', username: 'pin@example.com', passkeys: [passkey] });
  const hash = await sha256(utf8('{"type":"webauthn.get"}'));
  const request = Buffer.from(encode(new Map([[1, rpId], [2, hash]]))).toString('base64');
  const settle = (promise, ms = 700) => Promise.race([promise.then(() => 'answered', () => 'failed'), sleep(ms).then(() => 'open')]);
  const DIALOG = 'dialog[open] .unlock-head';
  let seq = 0;
  const ask = async () => {
    const id = `smoke-pin-${++seq}`;
    const answer = windows.request('get', { request, transactionId: id });
    answer.catch(() => {});
    await until(() => js('!!document.querySelector("dialog[open] .choice")'), 4000);
    return { id, answer };
  };
  const choose = (value) => js(`(() => { const p = document.querySelector("dialog[open] .win-pin-input"); if (p) p.value = ${JSON.stringify(value)}; [...document.querySelectorAll("dialog[open] .choice")].find((b) => /Smoke PIN Passkey/.test(b.textContent))?.click(); })()`);
  const cancel = async ({ id, answer }) => { await api.windowsDecision(id, { cancel: true }).catch(() => {}); await settle(answer, 300); await sleep(200); };
  try {
    resetPinGuard();
    // 1. PIN set: empty and wrong PIN sign nothing and the request stays open; the right PIN signs.
    const a = await ask();
    if (!(await js(`!!document.querySelector("${DIALOG}")`))) return fail(area, 'confirmation dialog missing');
    if (!(await js('!!document.querySelector("dialog[open] .win-pin-input")'))) return fail(area, 'confirmation without the PIN field');
    await choose('');
    if ((await settle(a.answer)) !== 'open') fail(area, 'empty PIN signed');
    await choose('0000');
    if ((await settle(a.answer)) !== 'open') fail(area, 'wrong PIN signed');
    if (!(await js('!!document.querySelector("dialog[open] .win-pin-error:not([hidden])")'))) fail(area, 'wrong PIN: no message in the dialog');
    if (windows.pending.size !== 1) fail(area, 'wrong PIN ended the request');
    if (config.get().pinGuard?.failures !== 1) fail(area, `wrong PIN not counted: ${JSON.stringify(config.get().pinGuard)}`);
    await choose(pin);
    const done = await Promise.race([a.answer, sleep(4000).then(() => null)]);
    if (!done?.response) fail(area, 'the right PIN did not sign');
    else if (!decode(Buffer.from(done.response, 'base64')).get(3)) fail(area, 'answer without a signature');
    await until(() => js('!document.querySelector("dialog[open] .choice")'), 3000);

    // 2. No grace period: the next use asks for the PIN again.
    const b = await ask();
    await choose('');
    if ((await settle(b.answer)) !== 'open') fail(area, 'a second use signed without a PIN');
    await cancel(b);

    // 3. No PIN set: the dialog asks to set one, the passkeys cannot be chosen, nothing is signed.
    config.update({ appPin: null });
    changed();
    const c = await ask();
    if (!(await js('[...document.querySelectorAll("dialog[open] .choice")].every((x) => x.disabled)'))) fail(area, 'no PIN set: a passkey can be chosen');
    if (await api.windowsDecision(c.id, { containerId: target.id, itemId: entry.id, credentialId: passkey.credentialId, pin: '2468' }).then(() => 'signed', (e) => e.name) !== 'PinNotSet') fail(area, 'no PIN set: signed');
    await cancel(c);
    await ensurePin();
    changed();

    // 4. Switched off: no PIN field, the choice signs as before.
    config.update({ passkeyPin: false });
    const d = await ask();
    if (await js('!!document.querySelector("dialog[open] .win-pin-input")')) fail(area, 'PIN field although the setting is off');
    await choose('');
    const off = await Promise.race([d.answer, sleep(4000).then(() => null)]);
    if (!off?.response) fail(area, 'with the setting off, the choice did not sign');
  } finally {
    config.update({ passkeyPin: true });
    resetPinGuard();
    for (const id of [...windows.pending.keys()]) await api.windowsDecision(id, { cancel: true }).catch(() => {});
    await vault.deleteItem(target.id, entry.id).catch(() => {});
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
  }
}

/** Browser extension (bridge command passkeySign, as the extension's window sends it): the app signs only with the PIN. */
export async function passkeyPinBrowserCheck({ fail, config, changed, vault, ensurePin, resetPinGuard, browserPasskeySign, browserPasskeyCandidates, browserSnapshot, browserItem, browserSave, browserHello, noteExtension }) {
  const area = 'passkeypinbrowser';
  const { makeCredentialData } = await import('../extension/core/webauthn.js');
  const { b64uEncode, randomBytes } = await import('../extension/core/util.js');
  const rpId = 'smoke-pin.example.com';
  const origin = `https://${rpId}`;
  const pin = await ensurePin();
  const target = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.locked && !c.error);
  const { passkey } = await makeCredentialData({ rpId, rpName: 'Smoke', user: { id: b64uEncode(randomBytes(16)), name: 'pin@example.com', displayName: 'Pin' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const entry = await vault.saveItem(target.id, { type: 'login', title: 'Smoke PIN Browser', username: 'pin@example.com', passkeys: [passkey] });
  const msg = (extra = {}) => ({ containerId: target.id, itemId: entry.id, credentialId: passkey.credentialId, origin, rpId, challenge: b64uEncode(randomBytes(32)), ...extra });
  const outcome = (promise) => promise.then((r) => (r?.response?.id ? 'signed' : 'empty'), (e) => e.name);
  try {
    resetPinGuard();
    // The list for the browser carries no key.
    const listed = (await browserPasskeyCandidates({ rpId })).find((c) => c.itemId === entry.id);
    if (!listed) fail(area, 'passkey not listed for the browser');
    else if (listed.passkey.privateKey) fail(area, 'the list for the browser carries the private key');
    if ((await browserSnapshot()).passkeyPin?.required !== true) fail(area, 'the app does not tell the extension that a PIN is needed');
    // Nothing without the right PIN.
    if ((await outcome(browserPasskeySign(msg()))) !== 'PinRequired') fail(area, 'signed without a PIN');
    if ((await outcome(browserPasskeySign(msg({ pin: '0000' })))) !== 'PinWrong') fail(area, 'signed with a wrong PIN');
    if (config.get().pinGuard?.failures !== 1) fail(area, `wrong PIN not counted: ${JSON.stringify(config.get().pinGuard)}`);
    if ((await outcome(browserPasskeySign(msg({ pin })))) !== 'signed') fail(area, 'the right PIN did not sign');
    // One use: the same PIN is not remembered.
    if ((await outcome(browserPasskeySign(msg()))) !== 'PinRequired') fail(area, 'a second use signed without a PIN');
    // Parallel guesses: one after the other, so the lock after the fifth mistake holds for the rest.
    resetPinGuard();
    const burst = await Promise.all(Array.from({ length: 10 }, () => outcome(browserPasskeySign(msg({ pin: '0000' })))));
    if (burst.filter((x) => x === 'PinWrong').length !== 5 || burst.filter((x) => x === 'PinBlocked').length !== 5) fail(area, `parallel guesses got past the lock: ${burst.join(',')}`);
    resetPinGuard();
    // Version check: the app offers passkeySign, and an extension before 0.9.29 gets the hint.
    if (!(await browserHello({})).caps?.includes('passkeySign')) fail(area, 'the app does not offer passkeySign');
    if (noteExtension({ extVersion: '0.9.28' }) !== true) fail(area, 'extension 0.9.28 is not told to update');
    if (noteExtension({ extVersion: '0.9.29' }) !== false) fail(area, 'extension 0.9.29 is told to update');
    // The item for the browser carries no private key; saving it from the browser keeps the stored one.
    const seen = await browserItem({ containerId: target.id, itemId: entry.id });
    if (!seen.passkeys?.length || seen.passkeys.some((k) => k.privateKey)) fail(area, 'the item for the browser carries the private key');
    await browserSave({ containerId: target.id, item: { ...seen, title: 'Smoke PIN Browser (edited)' }, expectedVersion: seen.version });
    if ((await outcome(browserPasskeySign(msg({ pin })))) !== 'signed') fail(area, 'after saving from the browser the passkey no longer signs');
    // No PIN set: nothing is signed, whatever is sent.
    config.update({ appPin: null });
    changed();
    if ((await outcome(browserPasskeySign(msg({ pin })))) !== 'PinNotSet') fail(area, 'no PIN set: signed');
    if ((await browserSnapshot()).passkeyPin?.pinSet !== false) fail(area, 'no PIN set: the extension is not told');
    await ensurePin();
    // Switched off: as before.
    config.update({ passkeyPin: false });
    if ((await outcome(browserPasskeySign(msg()))) !== 'signed') fail(area, 'with the setting off, the app did not sign');
  } finally {
    config.update({ passkeyPin: true });
    resetPinGuard();
    await vault.deleteItem(target.id, entry.id).catch(() => {});
  }
}

