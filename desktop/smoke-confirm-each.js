// Smoke check of #537 2b "Immer bestätigen": with the option on in the personal vault, every way a secret leaves the main
// process asks for a fresh confirmation – the entry view (sealed until confirmed), copying, auto-type, the browser
// extension (fill and copy, asked in the app) and AI agents (get_entry, no grant counts). One confirmation opens exactly
// one use. Off: nothing is asked. Switching needs the master password, the PIN or Windows Hello (simulated:
// KVPWSAFE_TEST_HELLO=sign). The personal vault is a temporary test folder (KVPWSAFE_TEST_REMOTE), never a real one.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { until } from './smoke-wait.js';
import { simulatedDialogs } from './hello-sim.js';

const MP = 'Smoke-Immer-537-mp!';
const SECRET = 'Smoke-Geheim-537!x';
const TITLE = 'Smoke Immer bestaetigen';
const errName = (p) => p.then(() => 'ok', (e) => e.name || e.message);

const invoke = (js, method, args) => js(`window.pwsafe.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`).then((t) => JSON.parse(t || '{}'));

/**
 * Konrad's review of c13aed7 and the scope (Lucas 13.11.2026): markers only at their own place (H1, window, its IPC and
 * the bridge), write answers sealed (M1), moves out only confirmed (H2, window and extension), scope all/personal, the
 * extension's question held on a locked window and naming the page (N3). The option is on (scope all) when this runs.
 */
async function reviewChecks({ js, sleep, api, browserHandlers, bridgeHandlers, setWindowLocked, answer, deny, closeAll, id, itemId, fail }) {
  const client = { origin: 'chrome-extension://smoke-immer', approved: true };
  const sealed = await api.item(id, itemId);
  // H1: a marker anywhere but its own place → nothing is saved (window, window IPC, bridge).
  for (const [what, item] of [['notes', { ...sealed, notes: sealed.password }], ['text field', { ...sealed, fields: [{ name: 'x', type: 'text', hidden: false, value: sealed.password }] }], ['title', { ...sealed, title: sealed.password }]]) {
    if (await errName(api.save(id, item, sealed.version)) !== 'SealedPlace') fail(`H1: a marker in the ${what} was saved (window)`);
    const viaIpc = await invoke(js, 'save', [id, item, sealed.version]);
    if (viaIpc.ok || viaIpc.error?.name !== 'SealedPlace') fail(`H1: a marker in the ${what} was saved (window IPC)`);
  }
  const fromBridge = await browserHandlers.item({ containerId: id, itemId });
  if (await errName(browserHandlers.save({ containerId: id, item: { ...fromBridge, notes: fromBridge.password }, expectedVersion: fromBridge.version })) !== 'SealedPlace') fail('H1: a marker in the notes was saved (bridge)');
  if ((await api.item(id, itemId)).version !== sealed.version) fail('H1: a refused save changed the entry');
  // M1: the answers of writes leave sealed – save and duplicate through the IPC, save through the pipe's dispatcher.
  const fav = await invoke(js, 'save', [id, { ...sealed, favorite: true }, sealed.version]);
  if (!fav.ok) fail(`M1: a sealed save failed: ${fav.error?.message}`);
  else if (JSON.stringify(fav.result).includes(SECRET) || !fav.result?.sealed?.includes('password')) fail('M1: the answer of a save carried the password');
  const viaPipe = await bridgeHandlers.save({ containerId: id, item: { ...(await browserHandlers.item({ containerId: id, itemId })), favorite: false } }, client).catch((e) => fail(`M1: bridge save failed: ${e.message}`));
  if (viaPipe && JSON.stringify(viaPipe).includes(SECRET)) fail('M1: the bridge answer of a save carried the password');
  const dup = await invoke(js, 'duplicate', [id, itemId]);
  if (!dup.ok || JSON.stringify(dup.result).includes(SECRET)) fail('M1: the answer of duplicate carried the password (or failed)');
  // Scope: all vaults by default; "only the personal vault" frees the others; switching only with a proof.
  const other = (await api.state()).containers.find((c) => c.id !== id && !c.personal && !c.locked && c.access?.write !== false);
  const otherItem = other && (await api.items()).find((x) => x.containerId === other.id && x.type === 'login');
  if (!other || !otherItem) return fail('no second vault with a login for scope and move');
  if ((await api.confirmEachState(id)).scope !== 'all') fail('scope: the default is not all vaults');
  if (!Array.isArray((await api.item(other.id, otherItem.id)).sealed)) fail('scope all: an entry of another vault is not sealed');
  if (await errName(api.setConfirmEach(id, true, '', 'personal')) !== 'PinRequired') fail('scope: changed without a proof');
  await api.setConfirmEach(id, true, MP, 'personal').catch((e) => fail(`scope: switching to the personal vault failed: ${e.message}`));
  if ((await api.confirmEachState(id)).scope !== 'personal') fail('scope: not stored');
  if ((await api.item(other.id, otherItem.id)).sealed) fail('scope personal: another vault is still sealed');
  if (!(await api.item(id, itemId)).sealed) fail('scope personal: the personal vault is no longer sealed');
  await api.setConfirmEach(id, true, { hello: true }, 'all').catch((e) => fail(`scope: back to all vaults failed: ${e.message}`));
  // H2: out of the vault only confirmed – window (one proof for a selection) and extension (card, then the proof).
  const dupId = dup.result?.id;
  if (dupId) {
    if (await errName(api.move(id, other.id, dupId)) !== 'AccessConfirmRequired') fail('H2: moved out without a confirmation (window)');
    const moving = errName(browserHandlers.move({ fromId: id, toId: other.id, itemId: dupId }));
    if (await answer('browser-move') !== 'ok') fail('H2: the extension move card did not appear');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .question.confirm-each")'), 4000))) fail('H2: the extension move asked for no proof');
    await deny();
    if (await moving === 'ok') fail('H2: the extension moved without the proof');
    await api.confirmAccess(id, [dupId], 'move', MP);
    await api.endMoveAccess(); // Konrad (low): what the move did not use ends with it
    if (await errName(api.move(id, other.id, dupId)) !== 'AccessConfirmRequired') fail('move: a confirmation outlived endMoveAccess');
    await api.confirmAccess(id, [dupId], 'move', MP);
    const moved = await invoke(js, 'move', [id, other.id, dupId]);
    if (!moved.ok) fail(`H2: a confirmed move failed: ${moved.error?.message}`);
    else {
      if (JSON.stringify(moved.result).includes(SECRET)) fail('M1: the answer of a move carried the password');
      await api.delete(other.id, moved.result.id).catch(() => {});
    }
  }
  // N-A (Konrad): giving access to a vault the rule covers needs a vault-wide confirmation ('share'); the backup ('backup')
  // is checked before its save dialog – not called here, a missing check would open the dialog.
  if (await errName(api.addMember(other.id, { id: 'smoke-immer-nobody', type: 'User' }, 'read')) !== 'AccessConfirmRequired') fail('N-A: a member was added without a confirmation');
  if (await errName(api.fileMemberOp(id, { type: 'sharing', enabled: true })) !== 'AccessConfirmRequired') fail('N-A: sharing was switched on without a confirmation');
  for (const op of [{ type: 'setPassword', password: 'Smoke-neu-537-x!', add: true }, { type: 'rekey', password: 'Smoke-neu-537-x!' }, { type: 'addEscrow' }, { type: 'createInvite' }]) {
    if (await errName(api.updateProtection(other.id, op)) !== 'AccessConfirmRequired') fail(`N-A: updateProtection ${op.type} without a confirmation`);
  }
  if (await errName(api.fileMemberOp(id, { type: 'setRole', memberId: 'x', role: 'admin' })) !== 'AccessConfirmRequired') fail('N-A: setRole without a confirmation');
  if (await errName(api.migrateFile(other.id, { email: 'smoke@example.com' })) !== 'AccessConfirmRequired') fail('N-A: migrateFile without a confirmation');
  if (await errName(api.confirmAccess(other.id, '*', 'view', MP)) === 'ok') fail('N-A: a vault-wide confirmation for showing entries');
  await api.confirmAccess(other.id, '*', 'share', MP);
  if (await errName(api.inviteGuest(other.id, 'not-an-email', 'read')) === 'AccessConfirmRequired') fail('N-A: a confirmed share was still refused');
  await closeAll();
  // N3: on a locked window the extension's question shows no entry and can't be allowed. Filling names the page.
  setWindowLocked(true);
  try {
    const held = errName(browserHandlers.itemReveal({ containerId: id, itemId, purpose: 'fill', site: 'immer.example' }));
    if (!(await until(() => js('!!document.querySelector("dialog[open] .question.held")'), 4000))) fail('N3: the extension question on the locked window is not held');
    else if (await js(`document.querySelector("dialog[open] .question.held").textContent.includes(${JSON.stringify(TITLE)})`)) fail('N3: the held question names the entry');
    // Lena 3: a held question can't be allowed with Windows Hello either.
    await sleep(1400);
    if (await js('(() => { const b = document.querySelector("dialog[open] .question.held .q-hello-allow"); return !!b && !b.disabled; })()')) fail('the Hello button of a held question is not disabled');
    await deny();
    if (await held === 'ok') fail('N3: a held question handed out the password');
  } finally {
    setWindowLocked(false);
  }
  const named = errName(browserHandlers.itemReveal({ containerId: id, itemId, purpose: 'fill', site: 'immer.example' }));
  if (!(await until(() => js('(document.querySelector("dialog[open] .question.confirm-each")?.textContent || "").includes("immer.example")'), 4000))) fail('N3: the fill question does not name the page');
  await deny();
  await named;
  await closeAll();
  return undefined;
}

export async function confirmEachCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, openQuestionIds, browserHandlers, bridgeHandlers, setWindowLocked, mcpService, clipboardHas, win, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'personalRecoveryPending', 'personalRecoveryRenewed', 'settingsCopy', 'confirmEachVaults', 'confirmEachPersonalOnly', 'appSettingsSeen', 'mcpScope', 'mcpEnabled'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const env = { remote: process.env.KVPWSAFE_TEST_REMOTE, hello: process.env.KVPWSAFE_TEST_HELLO };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-immer-'));
  const personalFile = path.join(dir, 'Keevault-Persoenlich.kvpws');
  const personal = async () => (await api.state()).containers.find((c) => c.path === personalFile) || null;
  const closeAll = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
  // A question of the main process in the window: answered through the IPC like the window does (proof checked there).
  // The answered question's dialog closes a moment later: wait for it, or the next wait finds the old one still open
  // and "Ablehnen" goes to it instead of the new question (which then runs into its own time-out).
  const settled = () => until(() => js('!document.querySelector("dialog[open] .question")'), 3000);
  const answer = async (kind, proof) => {
    if (!(await until(() => js(`!!document.querySelector("dialog[open] .question.${kind}")`), 4000))) return 'no question';
    const qid = openQuestionIds().at(-1);
    const r = await errName(api.answerQuestion(qid, 'allow', proof));
    if (r === 'ok') await until(() => js('!document.querySelector("dialog[open] .question")'), 3000); // its dialog closes
    return r;
  };
  const deny = () => js('[...document.querySelectorAll("dialog[open] .question .q-actions .btn")].find((b) => /Ablehnen|Deny/.test(b.textContent))?.click(); true');
  try {
    process.env.KVPWSAFE_TEST_REMOTE = dir;
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    // #537 risk 3: Hello starts by itself in every dialog – these checks answer the questions themselves (API, clicks),
    // so the automatic start is off here except in its own part below.
    await js('window.kvSmokeNoAutoHello = true; true');
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], personalDeviceKeys: {}, settingsCopy: false, confirmEachVaults: [] });
    const pin = await ensurePin();
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    await api.setupMasterPassword({ password: MP, pin });
    await api.createPersonal({ folder: dir, password: MP });
    const id = (await personal())?.id;
    if (!id) return fail('no personal vault in the test folder');
    await api.enableHelloUnlock({ password: MP }).catch((e) => fail(`Windows Hello (simulated) not switched on: ${e.message}`));
    const saved = await api.save(id, { type: 'login', title: TITLE, username: 'kim', password: SECRET, totp: 'JBSWY3DPEHPK3PXP', urls: ['https://immer.example'] });
    const itemId = saved?.id;
    if (!itemId) return fail('entry not saved in the personal vault');

    // Off (default): the entry comes whole, the extension gets it without a question.
    if ((await api.item(id, itemId)).password !== SECRET) fail('option off: the entry view does not show the password');
    if ((await browserHandlers.item({ containerId: id, itemId })).password !== SECRET) fail('option off: the extension does not get the password');
    if ((await api.confirmEachState(id)).on) fail('the option is on by default');

    // Switching needs a proof; a wrong one counts.
    if (await errName(api.setConfirmEach(id, true, '')) !== 'PinRequired') fail('switched on without a proof');
    if (await errName(api.setConfirmEach(id, true, 'falsch-falsch')) !== 'PinWrong') fail('switched on with a wrong master password');
    if (!config.get().pinGuard?.failures) fail('a wrong proof when switching was not counted');
    resetPinGuard();
    await api.setConfirmEach(id, true, MP).catch((e) => fail(`switching on with the master password failed: ${e.message}`));
    if (!(await api.confirmEachState(id)).on) return fail('the option is not on after switching');

    // The entry view: sealed until confirmed; one confirmation (Hello) shows it once.
    const sealed = await api.item(id, itemId);
    if (JSON.stringify(sealed).includes(SECRET) || !sealed.sealed?.includes('password')) fail('the entry left the main process with its password');
    if (await errName(api.item(id, itemId, true, { reveal: true })) !== 'AccessConfirmRequired') fail('the entry was shown without a confirmation');
    await api.confirmAccess(id, itemId, 'view', { hello: true });
    if ((await api.item(id, itemId, true, { reveal: true }).catch(() => ({}))).password !== SECRET) fail('a confirmed view does not show the password');
    if (await errName(api.item(id, itemId, true, { reveal: true })) !== 'AccessConfirmRequired') fail('one confirmation showed the entry twice');
    if (await errName(api.confirmAccess(id, itemId, 'copy', 'falsch-falsch')) !== 'PinWrong') fail('a wrong master password confirmed a copy');
    resetPinGuard();

    // Copying: the shown password needs its own confirmation; the copy of a sealed entry goes through the main process.
    if (await errName(api.copy(SECRET, id)) !== 'AccessConfirmRequired') fail('a shown password was copied without a confirmation');
    if (await errName(api.copySecret(id, itemId, 'password')) !== 'AccessConfirmRequired') fail('copySecret without a confirmation');
    await api.confirmAccess(id, itemId, 'copy', MP);
    await api.copySecret(id, itemId, 'password').catch((e) => fail(`confirmed copy failed: ${e.message}`));
    if (!(await clipboardHas(SECRET))) fail('the confirmed copy is not in the clipboard');
    if (await errName(api.copySecret(id, itemId, 'totp')) !== 'AccessConfirmRequired') fail('the one-time code was copied without a confirmation');

    // Auto-type: password needs a confirmation, the user name not.
    if (await errName(api.autoType(id, itemId, 'p')) !== 'AccessConfirmRequired') fail('auto-type typed the password without a confirmation');
    if (await errName(api.autoType(id, itemId, 'u')) !== 'ok') fail('auto-type of the user name asked for a confirmation');
    await api.confirmAccess(id, itemId, 'type', MP);
    if (await errName(api.autoType(id, itemId, 'p')) !== 'ok') fail('a confirmed auto-type did not type');

    // The window: the detail pane has no password; "Sicher kopieren" asks with the access dialog (Hello button there).
    changed();
    await sleep(800);
    // The list shows the selected vault: the personal one first (the demo selects its team vault).
    await js('document.querySelector(".personal-slot .nav")?.click(); true');
    await until(() => js(`[...document.querySelectorAll(".list li.row-item[data-key]")].some((r) => r.textContent.includes(${JSON.stringify(TITLE)}))`), 4000);
    await js(`[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.textContent.includes(${JSON.stringify(TITLE)}))?.click(); true`);
    if (!(await until(() => js(`(document.querySelector(".detail-pane")?.textContent || "").includes(${JSON.stringify(TITLE)})`), 4000))) fail('the entry of the personal vault did not open in the window');
    else {
      if (await js(`document.body.innerHTML.includes(${JSON.stringify(SECRET)})`)) fail('the window holds the password before a confirmation');
      await js('[...document.querySelectorAll(".detail-pane .act-card")].find((c) => /^(Passwort|Password)$/.test(c.querySelector("label")?.textContent || ""))?.querySelector(".act-label")?.click(); true');
      if (!(await until(() => js('!!document.querySelector("dialog[open].access-confirm-modal .access-proof")'), 3000))) fail('copying in the window did not ask for a confirmation');
      else {
        if (!(await js('!!document.querySelector("dialog[open].access-confirm-modal .hello-proof")'))) fail('the access dialog offers no Windows Hello');
        await js('document.querySelector("dialog[open].access-confirm-modal .hello-proof").click(); true');
        if (!(await until(() => clipboardHas(SECRET), 4000))) fail('the copy confirmed with Windows Hello did not reach the clipboard');
      }
    }
    await closeAll();

    // The extension: the entry comes sealed; filling asks in the app with the proof, refusing hands out nothing.
    if (JSON.stringify(await browserHandlers.item({ containerId: id, itemId })).includes(SECRET)) fail('the extension got the password without a confirmation');
    const fill = browserHandlers.itemReveal({ containerId: id, itemId, purpose: 'fill' }).catch(() => ({})); // handled at once
    if (await answer('confirm-each', '') !== 'PinRequired') fail('the extension request was allowed without a proof');
    if (await answer('confirm-each', MP) !== 'ok') fail('the extension request was not allowed with the master password');
    if ((await fill).password !== SECRET) fail('the confirmed fill did not hand out the password');
    await settled();
    const refused = errName(browserHandlers.itemReveal({ containerId: id, itemId, purpose: 'fill' }));
    await until(() => js('!!document.querySelector("dialog[open] .question.confirm-each")'), 4000);
    await deny();
    if (await refused === 'ok') fail('a refused extension request handed out the password');
    await settled();
    const copied = errName(browserHandlers.copy({ text: SECRET }));
    if (!(await until(() => js('!!document.querySelector("dialog[open] .question.confirm-each")'), 4000))) fail('the extension copied a revealed password without asking');
    await deny();
    if (await copied === 'ok') fail('a refused extension copy went through');
    await closeAll();

    // AI agents: get_entry asks every time with the proof, also with a session grant.
    config.update({ mcpScope: 'all', mcpEnabled: true });
    const client = { agent: 'smoke-immer' };
    mcpService.grants.set(client, { until: Date.now() + 60_000 });
    const read = mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({}));
    if (await answer('agent-confirm-each', MP) !== 'ok') fail('the agent read was not asked with the proof (or not allowed with the master password)');
    if ((await read).password !== SECRET) fail('the confirmed agent read did not get the password');
    await settled();
    const again = errName(mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }));
    if (!(await until(() => js('!!document.querySelector("dialog[open] .question.agent-confirm-each")'), 4000))) fail('the second agent read went through without a question');
    await deny();
    if (await again === 'ok') fail('a refused agent read got the password');
    await closeAll();

    // #537 risk 3 (Lucas: "überall automatisch"): with Windows Hello on, the question asks Hello by itself – the field for
    // the master password or the PIN hidden – and the read goes through without a click. After a cancel: the field,
    // "Erneut mit Windows Hello", no second automatic start; by keyboard (Lena 3) after the delay it allows.
    await settled();
    await js('window.kvSmokeNoAutoHello = false; window.kvSmokeAgentAutoGap = 0; true'); // the 60-s rule has its own check below
    const Q = 'dialog[open] .question.agent-confirm-each';
    const asked0 = simulatedDialogs();
    const auto = mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({}));
    if (!(await until(() => js(`!!document.querySelector("${Q}")`), 4000))) fail('risk 3: the agent question did not come');
    else {
      if (!(await js(`document.querySelector("${Q} .q-pin-box")?.hidden === true`))) fail('risk 3: the field is shown before Hello was asked');
      if (!(await js(`!!document.querySelector("${Q} .q-pin .q-hello-allow")`))) fail('the question has no "Mit Windows Hello erlauben" on top of the field');
      if (await js(`document.querySelectorAll("${Q} .btn.primary").length !== 1`)) fail('the question has more than one primary button (Lena: only Hello)');
      if (await js(`/leer lassen/.test(document.querySelector("${Q}")?.textContent || "")`)) fail('the question still says "leave the field empty"');
    }
    if ((await Promise.race([auto, sleep(5000).then(() => ({}))])).password !== SECRET) fail('risk 3: Windows Hello did not start by itself and allow the read');
    if (simulatedDialogs() !== asked0 + 1) fail(`risk 3: Hello asked ${simulatedDialogs() - asked0} times for one question`);
    await settled();

    process.env.KVPWSAFE_TEST_HELLO = 'cancel';
    const asked1 = simulatedDialogs();
    const afterCancel = mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({}));
    if (!(await until(() => js(`document.querySelector("${Q} .q-pin-box")?.hidden === false`), 5000))) fail('risk 3: after a cancelled Hello the field does not show');
    else {
      if (!(await js(`/Erneut mit Windows Hello/.test(document.querySelector("${Q} .q-hello-allow")?.textContent || "")`))) fail('risk 3: after a cancel no "Erneut mit Windows Hello"');
      await sleep(1500);
      if (simulatedDialogs() !== asked1 + 1) fail(`risk 3: Hello started ${simulatedDialogs() - asked1} times – a second automatic start after the cancel`);
      // By keyboard (Lena 3): focus on Hello, the delay passes, Enter allows – the key must not start the delay over.
      process.env.KVPWSAFE_TEST_HELLO = 'sign';
      win.focus(); // first: the window coming to the front starts the delay again (#381)
      await js(`document.querySelector("${Q} .q-hello-allow").focus(); true`);
      await sleep(1500); // the question's delay (#368) after the focus change
      if (await js(`document.querySelector("${Q} .q-hello-allow").getAttribute("aria-disabled") !== "false"`)) fail('after the delay the Hello button is still not ready');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); // a button acts on the key press of Enter
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      if ((await Promise.race([afterCancel, sleep(5000).then(() => ({}))])).password !== SECRET) fail('"Erneut mit Windows Hello" by keyboard (Enter) did not allow the agent read');
    }
    process.env.KVPWSAFE_TEST_HELLO = 'sign';
    await settled();

    // Konrad M1: never automatically when more than one request is open, not twice within 60 s, never for a question sent
    // again after the window's lock. Each time the field is there at once and nothing asked Hello.
    const quiet = async (what, Qsel) => {
      const before = simulatedDialogs();
      await sleep(1500);
      if (simulatedDialogs() !== before) fail(`M1: Windows Hello started by itself – ${what}`);
      if (!(await js(`[...document.querySelectorAll("${Qsel} .q-pin-box")].every((b) => !b.hidden)`))) fail(`M1: the field is hidden although nothing asks Hello – ${what}`);
    };
    const asked2 = simulatedDialogs();
    const client2 = { agent: 'smoke-immer-2' }; // a second tool: one client's questions may wait for each other
    mcpService.grants.set(client2, { until: Date.now() + 60_000 });
    const two = [client, client2].map((c) => mcpService.run(c, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({})));
    if (!(await until(() => js(`document.querySelectorAll("${Q}").length === 2`), 5000))) fail('M1: the two agent questions did not both come');
    else await quiet('two questions open', Q);
    if (simulatedDialogs() !== asked2) fail('M1: two open questions asked Windows Hello');
    await closeAll();
    await Promise.all(two);
    await settled();
    await js('delete window.kvSmokeAgentAutoGap; true'); // the real 60 s – the last automatic start was a moment ago
    const within = mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({}));
    if (await until(() => js(`!!document.querySelector("${Q}")`), 4000)) await quiet('a second question within 60 s', Q);
    await closeAll();
    await within;
    await settled();
    await js('window.kvSmokeAgentAutoGap = 0; true');
    setWindowLocked(true);
    let heldRead = null;
    try {
      heldRead = mcpService.run(client, 'get_entry', { vaultId: id, entryId: itemId }).catch(() => ({}));
      await until(() => js('!!document.querySelector("dialog[open] .question.held")'), 4000);
      resetPinGuard();
      await api.verifyPin(MP, 'password');
      await api.unlock({ entra: true }); // lifts the window's lock: the held question is sent again (resent)
      if (!(await until(() => js(`!!document.querySelector("${Q}:not(.held)")`), 4000))) fail('M1: the held question was not sent again after the unlock');
      else await quiet('a question sent again after the window lock', `${Q}:not(.held)`);
    } finally {
      setWindowLocked(false);
    }
    await closeAll();
    await heldRead;
    await js('delete window.kvSmokeAgentAutoGap; true');
    await js('window.kvSmokeNoAutoHello = true; true');
    await closeAll();

    await reviewChecks({ js, sleep, api, browserHandlers, bridgeHandlers, setWindowLocked, answer, deny, closeAll, id, itemId, fail });

    // Off again (with Hello): nothing is asked any more.
    await api.setConfirmEach(id, false, { hello: true }).catch((e) => fail(`switching off with Windows Hello failed: ${e.message}`));
    if ((await api.item(id, itemId)).password !== SECRET) fail('option off again: the entry stays sealed');
    if ((await browserHandlers.itemReveal({ containerId: id, itemId, purpose: 'fill' }).catch(() => ({}))).password !== SECRET) fail('option off: the extension was asked');
  } catch (e) {
    fail(e.message);
  } finally {
    await js('window.kvSmokeNoAutoHello = false; delete window.kvSmokeAgentAutoGap; true');
    await closeAll();
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
