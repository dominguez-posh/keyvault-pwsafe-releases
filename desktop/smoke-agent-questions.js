// Smoke checks of the questions AI agents put to the user. Part of the feature checks (desktop/smoke-features.js),
// which have reached their size limit.

import { nextFrame, questionsGone, until } from './smoke-wait.js';

// Longer than the delay before "Allow" works (CONFIRM_DELAY_MS in renderer/app/requests.js).
const CONFIRM_WAIT = 1500;

/** #339: the Microsoft account choice has a search and a vault filter; the answer is the account still visible. */
export async function microsoftChoiceCheck({ js, sleep, fail, chooseAgentMicrosoft }) {
  const msAccounts = [
    { key: 'v1/a', title: 'Microsoft', username: 'admin@contoso.com', vault: 'Arbeit' },
    { key: 'v2/b', title: 'Microsoft', username: 'adm-up@fabrikam.com', vault: 'Persönlich', otherTenant: true },
    { key: 'v2/c', title: 'Entra Breakglass', username: 'bg@contoso.com', vault: 'Persönlich' },
  ];
  const ms = chooseAgentMicrosoft({ agent: 'smoke-agent', purpose: 'smoke', accounts: msAccounts });
  await until(() => js('!!document.querySelector("dialog[open] .agent-microsoft")'));
  const tenantHints = await js('JSON.stringify([...document.querySelectorAll("dialog[open] .agent-microsoft .q-option-hint")].filter((e) => /anderer Tenant|other tenant/i.test(e.textContent)).map((e) => e.textContent.split(" · ")[0]))');
  if (tenantHints !== JSON.stringify(['adm-up@fabrikam.com'])) fail('agentfront', `#340: "other tenant" hint on the wrong accounts: ${tenantHints}`);
  const visibleOptions = 'JSON.stringify([...document.querySelectorAll("dialog[open] .agent-microsoft .q-option")].filter((o) => !o.hidden).map((o) => o.querySelector(".q-option-hint").textContent.split(" · ")[0]))';
  const setFilter = (search, vault) => js(`(() => { const d = document.querySelector("dialog[open] .agent-microsoft"); const s = d.querySelector(".q-search"); const v = d.querySelector(".q-vault");
    s.value = ${JSON.stringify(search)}; s.dispatchEvent(new Event("input")); if (v) { v.value = ${JSON.stringify(vault)}; v.dispatchEvent(new Event("change")); } return !!v; })()`);
  if (!(await setFilter('', 'Persönlich'))) fail('agentfront', 'Microsoft choice: no vault filter with two vaults');
  if ((await js(visibleOptions)) !== JSON.stringify(['adm-up@fabrikam.com', 'bg@contoso.com'])) fail('agentfront', `vault filter: ${await js(visibleOptions)}`);
  await setFilter('breakglass', 'Persönlich');
  if ((await js(visibleOptions)) !== JSON.stringify(['bg@contoso.com'])) fail('agentfront', `search: ${await js(visibleOptions)}`);
  await setFilter('nothing-matches', '');
  if (!(await js('document.querySelector("dialog[open] .agent-microsoft .q-actions .btn.primary").disabled'))) fail('agentfront', 'no hits: "Sign in" still enabled');
  await setFilter('fabrikam', '');
  // #368: the account has to be picked; then the delay of "Allow" has to be over.
  await js('document.querySelector("dialog[open] .agent-microsoft .q-option:not([hidden]) input").click()');
  if (!(await until(() => js('document.querySelector("dialog[open] .agent-microsoft .q-actions .btn.primary").getAttribute("aria-disabled") === "false"'), CONFIRM_WAIT))) fail('agentfront', `Microsoft choice: the delay of "Sign in" did not end within ${CONFIRM_WAIT} ms`);
  await js('document.querySelector("dialog[open] .agent-microsoft .q-actions .btn.primary").click()');
  const chosen = await Promise.race([ms, sleep(3000).then(() => 'timeout')]);
  if (chosen !== 'v2/b') fail('agentfront', `Microsoft choice: the visible account was not taken (${chosen})`);
  await questionsGone(js);
}

/** #374: locking refuses an open question and takes it off the screen; nothing can be allowed afterwards. */
export async function lockRefusesCheck({ js, sleep, fail, api, changed, confirmAgentWrite, ensurePin, kvc }) {
  const area = 'agentlock';
  const request = confirmAgentWrite({ agent: 'smoke-agent', action: 'update', title: 'Smoke Lock', vault: 'Smoke', fields: ['title'], changes: [] });
  if (!(await until(() => js('!!document.querySelector("dialog.question-modal")')))) fail(area, 'question did not open');
  await api.lock();
  const answer = await Promise.race([request, sleep(3000).then(() => 'still waiting')]);
  if (answer !== false) fail(area, `locking did not refuse the open question: ${answer}`);
  await questionsGone(js);
  if (await js('!!document.querySelector("dialog.question-modal")')) fail(area, 'the question stays on the lock screen');
  await api.verifyPin(await ensurePin());
  await api.unlock({ entra: true });
  changed();
  await until(() => js('!!document.querySelector(".sidebar .nav")'), 3000);
  await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click(); true`);
  await sleep(500);
}

/** #370: the write question shows the current title and old and new values, in the window and in the native dialog. */
export async function writeDetailsCheck({ js, sleep, fail, config, mcpService, confirmAgentWrite, nativeQuestion }) {
  const area = 'agentwrite';
  // An address with user data is refused before anything is asked; a long one would push the real host out of the display.
  const before = { mcpEnabled: config.get().mcpEnabled, approvedAgents: config.get().approvedAgents, agentRules: config.get().agentRules };
  config.update({ mcpEnabled: true, approvedAgents: [...before.approvedAgents, 'smoke-url'], agentRules: { ...before.agentRules, 'smoke-url': { write: true, until: null } } });
  try {
    const refused = await Promise.race([
      mcpService.call({ agent: 'smoke-url' }, 'create_entry', { vaultId: 'smoke', title: 'Smoke URL', url: `https://${'bank.example.'.repeat(30)}@evil.example/` }).then(() => 'ok', (e) => e.message),
      sleep(1500).then(() => 'asks the user'),
    ]);
    if (!/Benutzerdaten|user data/.test(refused)) fail(area, `long address with user data: got "${refused}"`);
  } finally {
    config.update(before);
  }
  const changes = [
    { field: 'title', from: 'Smoke Bank', to: 'Smoke Harmlos' },
    { field: 'url', from: 'https://bank.example/', to: 'https://evil.example/', host: 'xn--bnk-sna.example' },
    { field: 'username', from: '', to: 'smoke@contoso.com' },
    { field: 'folder', from: 'Finanzen', to: 'Papierkorb' },
  ];
  // #381: the agent names itself; a direction mark and a no-break space in its name are shown, not hidden.
  const request = confirmAgentWrite({ agent: `smoke${String.fromCodePoint(0x202e)}agent x`, action: 'update', title: 'Smoke Bank', vault: 'Smoke', fields: ['title', 'url', 'username', 'folder'], changes });
  await until(() => js('!!document.querySelector("dialog[open] .agent-write")'));
  const agentTitle = await js('document.querySelector("dialog[open] .agent-write .q-title")?.textContent || ""');
  if (!agentTitle.includes('smoke�agent�x')) fail(area, `#381: agent name not shown with its hidden characters marked: ${JSON.stringify(agentTitle)}`);
  const seen = JSON.parse(await js(`JSON.stringify({
    entry: document.querySelector("dialog[open] .agent-write .q-target-entry")?.textContent,
    rows: [...document.querySelectorAll("dialog[open] .agent-write .q-change")].map((r) => [r.dataset.field, r.querySelector(".q-change-old")?.textContent, r.querySelector(".q-change-new")?.textContent]),
    visible: !!document.querySelector("dialog[open] .agent-write .q-changes")?.offsetParent,
    host: document.querySelector("dialog[open] .agent-write .q-change[data-field=url] .q-change-host")?.textContent || "",
  })`));
  if (!seen.host.includes('xn--bnk-sna.example')) fail(area, `real host not shown: "${seen.host}"`);
  if (seen.entry !== 'Smoke Bank') fail(area, `dialog names "${seen.entry}" instead of the current title`);
  if (!seen.visible) fail(area, 'old and new values not visible');
  const empty = /^\((leer|empty)\)$/;
  for (const c of changes) {
    const row = seen.rows.find((r) => r[0] === c.field);
    if (!row || row[2] !== c.to || !(c.from ? row[1] === c.from : empty.test(row[1] || ''))) fail(area, `${c.field}: expected "${c.from}" → "${c.to}", shown ${JSON.stringify(row)}`);
  }
  await js('document.querySelector("dialog[open] .agent-write .q-actions .btn:not(.primary)")?.click()');
  if ((await Promise.race([request, sleep(3000).then(() => 'open')])) !== false) fail(area, 'deny did not answer the request');
  await questionsGone(js);
  const detail = nativeQuestion({ title: 'Smoke', allow: 'OK', cancel: 'deny', entry: 'Smoke Bank', vault: 'Smoke', changes }).box.detail;
  if (!detail.includes('https://bank.example/ → https://evil.example/')) fail(area, `native dialog without old and new values: ${detail}`);
  if (!detail.includes('xn--bnk-sna.example')) fail(area, `native dialog without the real host: ${detail}`);
}

/**
 * #368: a question of an agent is only answered by a deliberate choice. Enter and space are real key presses (a
 * script's click() would not show which button has the focus). Nothing may be answered right after the question
 * opens, or later by Enter alone; in the account choice not even after typing a search with one hit. Whoever keeps
 * typing can't confirm either: Tab to the button and Enter or space without a pause does nothing.
 *
 * #397: most of this step's time is the app's own delay (1.2 s, CONFIRM_DELAY_MS), which is what it checks: it can't get
 * shorter by waiting differently. delayOver ends at the delay's real end; `after` stays a fixed window, because it checks
 * that something does not happen.
 */
export async function deliberateAnswerCheck({ js, sleep, fail, win, confirmAgentWrite, confirmAgentRead, chooseAgentMicrosoft, nativeQuestion }) {
  const area = 'agententer';
  const key = (keyCode, char) => {
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const enter = () => key('Return', '\r');
  const space = () => key('Space', ' ');
  const tab = () => key('Tab');
  // What the request got so far; 'open' while it still waits for an answer.
  const after = (request, ms = 300) => Promise.race([request, sleep(ms).then(() => 'open')]);
  const opened = async (selector) => {
    for (let i = 0; i < 100 && !(await js(`!!document.querySelector("dialog[open] ${selector}")`)); i++) await sleep(10);
  };
  const allow = (selector) => `document.querySelector("dialog[open] ${selector} .q-actions .btn.primary")`;
  const deny = (selector) => js(`document.querySelector("dialog[open] ${selector} .q-actions .btn:not(.primary)")?.click()`);
  // During the delay the button keeps the focus and only looks disabled (aria-disabled).
  const waiting = (selector) => js(`(() => { const b = ${allow(selector)}; return b.disabled || b.getAttribute("aria-disabled") === "true"; })()`);
  const delayOver = async (selector) => { if (!(await until(() => js(`${allow(selector)}.getAttribute("aria-disabled") === "false"`), CONFIRM_WAIT))) fail(area, `${selector}: the delay of "Allow" did not end within ${CONFIRM_WAIT} ms`); };
  const gone = () => questionsGone(js);

  // Without choices: Enter and space right after opening, a click before the delay, Enter after the delay.
  const write = confirmAgentWrite({ agent: 'smoke-agent', action: 'update', title: 'Smoke Enter', vault: 'Smoke', fields: ['password'] });
  await opened('.agent-write');
  enter();
  space();
  if ((await after(write)) !== 'open') fail(area, 'write request: Enter or space right after opening answered it');
  if (await js(`document.activeElement === ${allow('.agent-write')}`)) fail(area, 'write request: the focus starts on "Allow"');
  if (!(await waiting('.agent-write'))) fail(area, 'write request: "Allow" usable right after opening');
  await js(`${allow('.agent-write')}.click()`);
  if ((await after(write, 100)) !== 'open') fail(area, 'write request: a click right after opening answered it');
  await delayOver('.agent-write');
  if (await waiting('.agent-write')) fail(area, 'write request: "Allow" still disabled after the delay');
  enter();
  space();
  if ((await after(write)) !== 'open') fail(area, 'write request: Enter or space after the delay answered it');
  await delayOver('.agent-write');
  // #381: the window coming to the front starts the delay again, the click that activated it answers nothing.
  await js('window.dispatchEvent(new Event("focus")), true');
  if (!(await waiting('.agent-write'))) fail(area, 'write request: the window gaining focus did not restart the delay');
  await js(`${allow('.agent-write')}.click()`);
  if ((await after(write, 100)) !== 'open') fail(area, 'write request: a click right after the window gained focus answered it');
  await delayOver('.agent-write');
  await js(`${allow('.agent-write')}.click()`);
  if ((await after(write, 3000)) !== true) fail(area, 'write request: a click on "Allow" after the delay did not answer it');
  await gone();

  // With a preselected answer: Enter stays without effect as well.
  const read = confirmAgentRead({ agent: 'smoke-agent', title: 'Smoke Enter', vault: 'Smoke' });
  await opened('.agent-read');
  enter();
  if ((await after(read)) !== 'open') fail(area, 'read request: Enter right after opening answered it');
  await delayOver('.agent-read');
  enter();
  if ((await after(read)) !== 'open') fail(area, 'read request: Enter after the delay answered it');
  await deny('.agent-read');
  if ((await after(read, 3000)) !== 'deny') fail(area, 'read request: deny did not answer it');
  await gone();

  // Account choice: nothing selected, the cursor in the search, Enter never hands out an account.
  const accounts = [
    { key: 'v1/a', title: 'Microsoft', username: 'admin@contoso.com', vault: 'Arbeit' },
    { key: 'v2/b', title: 'Microsoft', username: 'adm-up@fabrikam.com', vault: 'Persönlich' },
  ];
  const ms = '.agent-microsoft';
  const type = (text) => js(`(() => { const s = document.querySelector("dialog[open] ${ms} .q-search"); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event("input")); })()`);
  const pick = (index) => js(`[...document.querySelectorAll("dialog[open] ${ms} .q-option input")][${index}].click()`);
  const account = chooseAgentMicrosoft({ agent: 'smoke-agent', purpose: 'smoke', accounts });
  await opened(ms);
  enter();
  if ((await after(account)) !== 'open') fail(area, 'account choice: Enter right after opening answered it');
  if ((await js(`document.querySelectorAll("dialog[open] ${ms} .q-option input:checked").length`)) !== 0) fail(area, 'account choice: an account is preselected');
  if (!(await js(`document.activeElement === document.querySelector("dialog[open] ${ms} .q-search")`))) fail(area, 'account choice: the cursor does not start in the search');
  await delayOver(ms);
  if (!(await js(`${allow(ms)}.disabled`))) fail(area, 'account choice: "Sign in" usable without a choice');
  enter();
  if ((await after(account)) !== 'open') fail(area, 'account choice: Enter without a choice answered it');
  await type('fabrikam');
  enter();
  if ((await after(account)) !== 'open') fail(area, 'account choice: Enter on a search with one hit answered it');
  if (!(await js(`${allow(ms)}.disabled`))) fail(area, 'account choice: a search with one hit selected the account');
  // A pick that the filter hides is gone, no other account takes its place.
  await pick(1);
  if (await js(`${allow(ms)}.disabled`)) fail(area, 'account choice: "Sign in" stays disabled after picking an account');
  await type('contoso');
  await sleep(50);
  if (!(await js(`${allow(ms)}.disabled`))) fail(area, 'account choice: the hidden account stays selected');
  if ((await js(`document.querySelectorAll("dialog[open] ${ms} .q-option input:checked").length`)) !== 0) fail(area, 'account choice: another account took the place of the hidden one');
  // The keyboard way: pick in the list, Enter there answers with this account.
  await pick(0);
  await js(`document.querySelector("dialog[open] ${ms} .q-option input:checked").focus()`);
  await delayOver(ms);
  enter();
  if ((await after(account, 3000)) !== 'v1/a') fail(area, 'account choice: Enter on the picked account did not take it');
  await gone();

  // Whoever keeps typing can't confirm: Tab to "Allow", then the key without a pause. After a pause the same key works,
  // the button has kept the focus.
  const typingOn = async (confirm, name) => {
    const request = confirmAgentWrite({ agent: 'smoke-agent', action: 'update', title: 'Smoke Typing', vault: 'Smoke', fields: ['notes'] });
    await opened('.agent-write');
    await delayOver('.agent-write');
    tab();
    tab();
    confirm();
    if ((await after(request)) !== 'open') fail(area, `write request: Tab, Tab, ${name} without a pause answered it`);
    if (!(await js(`document.activeElement === ${allow('.agent-write')}`))) fail(area, `write request: "Allow" has no focus after Tab, Tab, ${name}`);
    await delayOver('.agent-write');
    confirm();
    if ((await after(request, 3000)) !== true) fail(area, `write request: ${name} on "Allow" after a pause did not answer it`);
    await gone();
  };
  await typingOn(enter, 'Enter');
  await typingOn(space, 'space');

  // The same in the account choice: Tab past the vault filter to the list, space picks, Enter without a pause does nothing.
  const typingAccount = chooseAgentMicrosoft({ agent: 'smoke-agent', purpose: 'smoke', accounts });
  await opened(ms);
  await delayOver(ms);
  tab();
  tab();
  space();
  enter();
  if ((await after(typingAccount)) !== 'open') fail(area, 'account choice: Tab, Tab, space, Enter without a pause answered it');
  if (!(await js(`document.activeElement === document.querySelector("dialog[open] ${ms} .q-option input:checked")`))) fail(area, 'account choice: space on the list did not pick the account with the focus');
  await delayOver(ms);
  enter();
  if ((await after(typingAccount, 3000)) !== 'v1/a') fail(area, 'account choice: Enter on the picked account after a pause did not take it');
  await gone();

  // A single account is not preselected either.
  const single = chooseAgentMicrosoft({ agent: 'smoke-agent', purpose: 'smoke', accounts: accounts.slice(0, 1) });
  await opened(ms);
  await delayOver(ms);
  if ((await js(`document.querySelectorAll("dialog[open] ${ms} .q-option input:checked").length`)) !== 0) fail(area, 'single account: it is preselected');
  if (!(await js(`${allow(ms)}.disabled`))) fail(area, 'single account: "Sign in" usable without a choice');
  enter();
  if ((await after(single)) !== 'open') fail(area, 'single account: Enter without a choice answered it');
  await pick(0);
  if (await js(`${allow(ms)}.disabled`)) fail(area, 'single account: "Sign in" stays disabled after picking it');
  await delayOver(ms);
  await js(`${allow(ms)}.click()`);
  if ((await after(single, 3000)) !== 'v1/a') fail(area, 'single account: "Sign in" after picking it did not take it');
  await gone();

  // Two questions at once: when the upper one is answered, the lower one comes up with its delay started again.
  const lower = confirmAgentWrite({ agent: 'smoke-agent', action: 'update', title: 'Smoke Lower', vault: 'Smoke', fields: ['notes'] });
  await opened('.agent-write');
  await delayOver('.agent-write');
  const upper = confirmAgentRead({ agent: 'smoke-agent', title: 'Smoke Upper', vault: 'Smoke' });
  await opened('.agent-read');
  await deny('.agent-read');
  await after(upper, 3000);
  await nextFrame(js); // the dialog's close event comes after the answer, with the next frame
  if (!(await waiting('.agent-write'))) fail(area, 'two questions: the lower one was usable at once after the upper one closed');
  await deny('.agent-write');
  if ((await after(lower, 3000)) !== false) fail(area, 'two questions: deny did not answer the lower one');
  await gone();

  // Without a ready window the native dialog asks: Enter there has to mean "Deny".
  const { options, box } = nativeQuestion({ title: 'Smoke', allow: 'OK', cancel: 'deny', choices: [{ value: 'once', label: 'Once' }] });
  if (box.defaultId !== options.length || box.cancelId !== options.length) fail(area, `native dialog: default button ${box.defaultId} is not "Deny" (${options.length})`);
}
