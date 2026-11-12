// Smoke part of #507 (area 'pin'): unlocking through the browser extension opens the vault session for the extension
// only – the window keeps its lock screen and gets nothing of the vaults; the window then opens with the PIN without a
// second sign-in; locking ends both. Runs with the app open and no PIN set; leaves it open with no PIN.

import { api, windowLockedRefusal } from './api/index.js';
import { auth, config, opened, vault, windowLocked, windows } from './state.js';
import { encode } from '../../extension/core/cbor.js';
import { browserHandlers } from './browser.js';
import { lockNow } from './session.js';
import { confirmAgentRead, questions } from './agents.js';
import { trayTemplate } from './window.js';
import { until } from '../smoke-wait.js';

const PIN = '507507';

/** The open question dialog, read at once. */
const questionView = `JSON.stringify((() => {
  const d = [...document.querySelectorAll('dialog[open]')].find((x) => x.querySelector('.question'));
  const allow = d && [...d.querySelectorAll('.q-actions button')].find((b) => /Erlauben|Allow/.test(b.textContent));
  return { open: !!d, text: d?.innerText || '', allowDisabled: !!allow?.disabled };
})())`;

const invoke = (js, method, args) => js(`window.pwsafe.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`)
  .then((r) => JSON.parse(r || '{}'));
const HELD_NAMES = ['smoke507.example', 'Smoke Held Site 507', 'held507@example.com'];
const settled = (p) => Promise.race([p.then(() => 'answered', () => 'refused'), new Promise((r) => setTimeout(() => r('open'), 1500))]);

/** A simulated Windows passkey request as the packaged provider relays it. */
function windowsRequest(kind, id) {
  const hash = new Uint8Array(32).fill(7);
  const request = kind === 'create'
    ? encode(new Map([[1, hash], [2, new Map([['id', HELD_NAMES[0]], ['name', HELD_NAMES[1]]])], [3, new Map([['id', new Uint8Array([5, 0, 7])], ['name', HELD_NAMES[2]]])],
      [4, [new Map([['alg', -7], ['type', 'public-key']])]]]))
    : encode(new Map([[1, HELD_NAMES[0]], [2, hash]]));
  return windows.request(kind, { request: Buffer.from(request).toString('base64'), transactionId: id });
}

/**
 * #507 review N1–N3: a Windows passkey request behind the window's lock shows only "Eine Anmeldung mit Passkey wartet"
 * – no site, account or vault list –, "Ablehnen" works, allowing is refused; the lock screen's PIN opens the window and
 * the normal request appears. The locked window changes and sees only the lock screen's settings.
 */
async function heldWindowsCheck({ js, sleep, errors, names }) {
  await lockNow();
  await browserHandlers.unlockPin({ pin: PIN });
  await sleep(800);
  const create = windowsRequest('create', 'smoke-held-create');
  await sleep(900);
  const view = JSON.parse(await js(`JSON.stringify({ waiting: (() => { const w = document.getElementById('windows-waiting'); return w && !w.hidden ? w.innerText : ''; })(),
    dialog: !!document.querySelector('dialog[open] .unlock-head'), text: document.body.innerText })`) || '{}');
  if (!/Eine Anmeldung mit Passkey wartet/.test(view.waiting || '')) errors.push(`window-lock: Windows request behind the lock not shown as waiting (${view.waiting})`);
  if (view.dialog) errors.push('window-lock: Windows request dialog opened behind the lock');
  const shown = [...HELD_NAMES, ...names].filter((n) => (view.text || '').includes(n));
  if (shown.length) errors.push(`window-lock: Windows request behind the lock shows names: ${shown.join(', ')}`);
  const listed = await invoke(js, 'windowsRequests', []);
  const leaked = [...HELD_NAMES, ...names].filter((n) => JSON.stringify(listed).includes(n));
  if (!listed.ok || leaked.length || listed.result?.some((r) => r.containers || r.logins || r.candidates)) errors.push(`window-lock: windowsRequests gives the locked window names or vaults (${leaked.join(', ')})`);
  const target = (await vault.containers()).find((c) => !c.locked);
  if ((await invoke(js, 'windowsDecision', ['smoke-held-create', { containerId: target?.id, title: 'x' }])).ok) errors.push('window-lock: a Windows request could be allowed behind the lock');
  await js(`document.querySelector('.windows-held-decline')?.click()`);
  if (await settled(create) !== 'refused' || windows.pending.has('smoke-held-create')) errors.push('window-lock: "Ablehnen" behind the lock did not refuse the Windows request');
  // N2/N3: the locked window changes only its lock screen's settings and gets the allowlist back.
  if ((await invoke(js, 'updateSettings', [{ breakGlass: { smoke: [] } }])).ok || config.get().breakGlass?.smoke) errors.push('window-lock: the locked window changed breakGlass');
  // Review 0.9.33: update mode and channel are not changed from the locked window.
  const mode = config.get().updateMode;
  const otherMode = mode === 'off' ? 'ask' : 'off';
  if ((await invoke(js, 'updateSettings', [{ updateMode: otherMode }])).ok || config.get().updateMode !== mode) errors.push('window-lock: the locked window changed updateMode');
  if ((await invoke(js, 'updateSettings', [{ updateChannel: 'beta' }])).ok && config.get().updateChannel === 'beta') errors.push('window-lock: the locked window changed updateChannel');
  const lang = await invoke(js, 'updateSettings', [{ language: config.get().language }]);
  const bad = ['tenantId', 'clientId', 'breakGlass', 'personalVaults', 'mcpTrusted', 'appPin', 'personalDeviceKeys', 'fileIdNotes'].filter((k) => Object.hasOwn(lang.result || {}, k));
  if (!lang.ok || bad.length || lang.result.containers?.length) errors.push(`window-lock: updateSettings gives the locked window ${bad.join(', ') || lang.error?.message || 'vaults'}`);
  // The PIN on the lock screen opens the window, then the normal request appears.
  const get = windowsRequest('get', 'smoke-held-get');
  await sleep(600);
  await js(`(() => { const i = document.querySelector('.pin-input'); i.value = '${PIN}'; document.querySelector('.window-unlock').click(); return true; })()`);
  for (let i = 0; i < 20 && windowLocked; i++) await sleep(200);
  await sleep(900);
  const head = await js(`document.querySelector('dialog[open] .unlock-head')?.innerText || ''`);
  if (windowLocked || !String(head).includes(HELD_NAMES[0])) errors.push(`window-lock: after the PIN the Windows request is not the normal one (${String(head).slice(0, 60)})`);
  await api.windowsDecision('smoke-held-get', { cancel: true }).catch(() => {});
  await settled(get);
}

/**
 * #507 (Lucas 2026-11-10): an agent asks while the window is locked and only the extension unlocked – the window shows
 * no agent, entry or vault name, "Allow" is refused; after the window's PIN the real question appears.
 */
async function heldQuestionCheck({ js, sleep, errors, names }) {
  await lockNow();
  await browserHandlers.unlockPin({ pin: PIN });
  const asked = confirmAgentRead({ agent: 'smoke-held-agent', title: 'Smoke Geheimeintrag 507', vault: 'Smoke Tresor 507' });
  await sleep(900);
  let q = JSON.parse(await js(questionView) || '{}');
  if (!q.open) errors.push('window-lock: agent question not shown while the window is locked');
  const leaked = ['smoke-held-agent', 'Smoke Geheimeintrag 507', 'Smoke Tresor 507', ...names].filter((n) => (q.text || '').includes(n));
  if (leaked.length) errors.push(`window-lock: agent question shows names while the window is locked: ${leaked.join(', ')}`);
  if (q.open && !/Ein KI-Agent möchte auf Keevault zugreifen/.test(q.text)) errors.push('window-lock: held question does not say "Ein KI-Agent möchte auf Keevault zugreifen"');
  if (q.open && !q.allowDisabled) errors.push('window-lock: "Erlauben" usable while the window is locked');
  const id = [...questions.keys()].at(-1);
  const forced = JSON.parse(await js(`window.pwsafe.invoke('answerQuestion', [${JSON.stringify(id)}, 'once']).then((r) => JSON.stringify(r))`) || '{}');
  if (forced.ok) errors.push('window-lock: the window could allow a held agent question');
  // The window's PIN: the same question now shows what it asks.
  await api.verifyPin(PIN);
  await api.unlock({ entra: true });
  await sleep(900);
  q = JSON.parse(await js(questionView) || '{}');
  if (!q.open || !(q.text || '').includes('Smoke Geheimeintrag 507') || q.allowDisabled) errors.push(`window-lock: after the PIN the agent question is not the real one (${(q.text || '').slice(0, 80)})`);
  await js('[...document.querySelectorAll("dialog[open] button")].find((b) => b.closest("dialog").querySelector(".question") && /Ablehnen|Deny/.test(b.textContent))?.click()');
  const answer = await Promise.race([asked, sleep(3000).then(() => 'timeout')]);
  if (answer === 'timeout' || answer === 'once') errors.push(`window-lock: agent question not refused (${answer})`);
}

export async function windowLockCheck({ js, sleep, errors }) {
  const names = (await vault.containers()).map((c) => c.name).filter((n) => n && n.length > 3);
  await api.setPin({ next: PIN });
  const realUnlock = auth.unlock;
  let signIns = 0;
  auth.unlock = (...args) => {
    signIns += 1;
    return realUnlock.apply(auth, args);
  };
  try {
    // Unlocked through the extension: session open for it, the window stays locked.
    await lockNow();
    await browserHandlers.unlockPin({ pin: PIN });
    if (!opened || !windowLocked) errors.push(`window-lock: extension unlock did not open the session alone (opened ${opened}, windowLocked ${windowLocked})`);
    if (!(await browserHandlers.snapshot()).opened) errors.push('window-lock: extension does not see the session open');
    const st = await api.state();
    if (st.opened || !st.windowLocked || st.containers.length || st.account || st.settings.containers.length || st.settings.fileContainers.length) {
      errors.push('window-lock: the window state shows the open session or vault data');
    }
    // The window redraws after the lock and again after the extension's unlock: wait for its own lock screen (#526: a fixed
    // 800 ms was too short under load). The check below asks again.
    await until(() => js(`!!document.querySelector('.window-unlock')`), 5000, 100);
    await sleep(300);
    const screen = JSON.parse(await js(`JSON.stringify({ shell: !!document.querySelector('.shell'), pin: !!document.querySelector('.pin-input'),
      unlock: !!document.querySelector('.window-unlock'), text: document.body.innerText })`) || '{}');
    if (screen.shell || !screen.pin || !screen.unlock) errors.push(`window-lock: window does not show its own lock screen (${JSON.stringify({ ...screen, text: undefined })})`);
    const shown = names.filter((n) => (screen.text || '').includes(n));
    if (shown.length) errors.push(`window-lock: lock screen shows vault names: ${shown.join(', ')}`);
    const items = JSON.parse(await js(`window.pwsafe.invoke('items', []).then((r) => JSON.stringify(r))`) || '{}');
    if (items.ok || items.error?.name !== 'WindowLocked') errors.push(`window-lock: the window may still read entries (${JSON.stringify(items).slice(0, 120)})`);
    if (!opened) errors.push('window-lock: a refused call from the window ended the session');
    if (windowLockedRefusal('state') || !windowLockedRefusal('getItem')) errors.push('window-lock: wrong set of calls for the lock screen');
    const tray = trayTemplate();
    if (tray[0]?.label !== 'Erweiterung entsperrt' || tray[0]?.enabled !== false) errors.push(`window-lock: tray does not say "Erweiterung entsperrt" (${tray[0]?.label})`);
    if (tray.find((x) => x.label === 'Passwort-Check')?.enabled) errors.push('window-lock: tray offers the password check while the window is locked');
    // The window opens with the PIN: no second sign-in, the session stays.
    const before = signIns;
    await js(`(() => { const i = document.querySelector('.pin-input'); i.value = '${PIN}'; document.querySelector('.window-unlock').click(); return true; })()`);
    for (let i = 0; i < 20 && windowLocked; i++) await sleep(200);
    await sleep(600);
    if (windowLocked || !opened) errors.push('window-lock: PIN in the window did not open it');
    if (signIns !== before) errors.push(`window-lock: window unlock signed in again (${signIns - before}×)`);
    if (!(await until(() => js(`!!document.querySelector('.shell')`), 5000, 100))) /* #526: the redraw takes longer under load */ errors.push('window-lock: window shows no vaults after the PIN');
    if (trayTemplate()[0]?.label === 'Erweiterung entsperrt') errors.push('window-lock: tray still says "Erweiterung entsperrt"');
    await heldQuestionCheck({ js, sleep, errors, names });
    await heldWindowsCheck({ js, sleep, errors, names }); // #507 review N1–N3
    // Locking ends both: extension unlock again, then lock (as Win+L, timeout or the tray do).
    await lockNow();
    await browserHandlers.unlockPin({ pin: PIN });
    await lockNow();
    if (opened || windowLocked) errors.push('window-lock: locking left the session or the window lock');
    if ((await browserHandlers.snapshot()).opened) errors.push('window-lock: extension still unlocked after locking');
    if ((await api.state()).windowLocked) errors.push('window-lock: window still reports "extension unlocked" after locking');
  } catch (e) {
    errors.push(`window-lock flow: ${e.message}`);
  } finally {
    auth.unlock = realUnlock;
    if (!opened) {
      await api.verifyPin(PIN).catch(() => {});
      await api.unlock({ entra: true }).catch((e) => errors.push(`window-lock: unlock afterwards: ${e.message}`));
    }
    await api.setPin({ current: PIN, next: null }).catch((e) => errors.push(`window-lock: PIN not removed: ${e.message}`));
  }
}
