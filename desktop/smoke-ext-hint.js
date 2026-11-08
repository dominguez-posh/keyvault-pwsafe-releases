// Smoke check of the hint on the browser extension next to the version tag (#454): the three cases and "all good"
// (bridge clients simulated), the popover with "Check again", and that the hint goes away when everything fits.
// Part of the feature checks (desktop/smoke-features.js).

import { until } from './smoke-wait.js';
import { browserPolicy, EXTENSION_ID, UPDATE_URL as STABLE_FEED, EARLY_ACCESS_FEED, settingsValue } from './machine-setup.js';

export async function extensionHintCheck(ctx) {
  const { js, fail, simulate } = ctx;
  const browser = { approved: true, origin: 'chrome-extension://smoke/', extVersion: '0.9.29', minApp: '0.9.29' };
  const shown = () => js('JSON.stringify((() => { const b = document.getElementById("ext-hint"); return b ? { text: b.textContent, state: b.dataset.state, calm: !b.classList.contains("error") } : null; })())').then(JSON.parse);
  const recheck = async () => {
    await js('document.querySelector("#ext-hint-open")?.click(); true');
    if (!(await until(() => js('!!document.querySelector("#ext-pop #ext-recheck")'), 2000))) return false;
    await js('document.querySelector("#ext-recheck").click(); true');
    return true;
  };
  const cases = [
    ['noConnection', [], /Keine Verbindung|No connection/],
    ['extensionOutdated', [{ ...browser, extVersion: '0.9.28' }], /Erweiterung aktualisieren|Update the extension/],
    ['appOutdated', [{ ...browser, minApp: '99.0.0' }], /App aktualisieren|Update the app/],
  ];
  try {
    for (const [state, clients, text] of cases) {
      simulate(clients);
      // A refresh of the window (as after any change) asks the main process for the status again.
      const ok = await until(async () => { await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true'); return (await shown())?.state === state; }, 8000);
      const s = await shown();
      if (!ok || !s) { fail(`${state}: no hint next to the version tag`); continue; }
      if (s.state !== state || !text.test(s.text) || !s.calm) fail(`${state}: wrong or loud hint ${JSON.stringify(s)}`);
      const popover = await js('(async () => { document.getElementById("ext-hint-open").click(); await new Promise((r) => setTimeout(r, 200)); const p = document.getElementById("ext-pop"); return p ? { steps: p.querySelectorAll("li").length, recheck: !!p.querySelector("#ext-recheck") } : null; })()');
      if (!popover || !popover.steps || !popover.recheck) fail(`${state}: popover without steps or "Check again" ${JSON.stringify(popover)}`);
      // A click on the hint toggles the popover: close it so the next case opens it fresh.
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
    }
    // "Check again" picks up the changed state: all fine, so the hint goes away.
    simulate([browser]);
    if (!(await recheck())) fail('popover for "Check again" did not open');
    if (!(await until(async () => !(await shown()), 4000))) fail('hint stays although the extension fits');
  } finally {
    simulate(null);
  }
  await extensionFixCheck(ctx);
}

// #455: "Fix now" right in the hint, no dialog before UAC. The registry and the elevated step are replaced by a stand-in
// (simulatePolicy), so no UAC prompt and no policy is written. Hint → button → click → restart notice; a cancelled UAC
// prompt and a failure give a clear message; no button with a company policy (hint to the IT in the popover), when the
// policies already point to the channel's feed, or where the cause is not the setup (app outdated).
async function extensionFixCheck(ctx) {
  const { js, fail, simulate, simulatePolicy } = ctx;
  const entry = (value) => [{ name: '1', value }];
  const ours = (feed) => browserPolicy(entry(`${EXTENSION_ID};${feed}`), { type: 'REG_SZ', value: settingsValue(feed) });
  const company = browserPolicy(entry(`${EXTENSION_ID};https://updates.example.com/crx.xml`), null);
  const foreignKey = browserPolicy(entry(`${EXTENSION_ID};${STABLE_FEED}`), { type: 'REG_SZ', value: JSON.stringify({ [EXTENSION_ID]: JSON.parse(settingsValue(STABLE_FEED))[EXTENSION_ID], abcdefghijklmnopabcdefghijklmnop: { installation_mode: 'blocked' } }) });
  const none = browserPolicy(null, null);
  if (foreignKey.state !== 'company') fail('fix: a foreign key in ExtensionSettings must make the whole policy the company\'s');
  const calls = [];
  // outcome: what the stand-in for the elevated step does – 'changed' writes our values, 'declined' (UAC cancelled) and
  // 'failed' change nothing.
  const sim = (edge, chrome, outcome = 'changed') => {
    const policies = { edge, chrome };
    simulatePolicy({ policies, run: async (o) => {
      calls.push(o);
      if (outcome === 'changed') { policies.edge = ours(STABLE_FEED); policies.chrome = ours(STABLE_FEED); }
      return { result: outcome };
    } });
  };
  const state = () => js('JSON.stringify({ hint: !!document.getElementById("ext-hint"), fix: !!document.querySelector("#ext-hint #ext-fix"), dialogs: document.querySelectorAll("dialog[open]").length, result: (() => { const r = document.getElementById("ext-result"); return r ? { kind: r.className, text: r.textContent } : null; })() })').then(JSON.parse);
  // Refreshes until the hint is there and the fix state has arrived (button shown or not, as expected).
  const shown = async (withFix) => {
    let s = null;
    await until(async () => { await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true'); s = await state(); return s.hint && s.fix === withFix; }, 8000);
    return s;
  };
  const closeResult = () => js('document.getElementById("ext-result-close")?.click(); true');
  const clickFix = async (pattern, kind) => {
    const before = calls.length;
    await js('document.querySelector("#ext-hint #ext-fix").click(); true');
    if (!(await until(async () => calls.length === before + 1, 4000))) { fail('fix: the click on "Fix now" did not run the setup'); return; }
    let s = null;
    if (!(await until(async () => { s = await state(); return !!s.result; }, 4000))) { fail(`fix: no notice after the click ${JSON.stringify(s)}`); return; }
    if (s.dialogs) fail(`fix: a dialog opened around the UAC step ${JSON.stringify(s)}`);
    if (s.result.kind !== kind || !pattern.test(s.result.text)) fail(`fix: wrong notice ${JSON.stringify(s.result)}`);
  };
  // The popover is drawn from the fix state of the last refresh. shown(false) can already pass on the previous case's
  // state (no button there either), so open it afresh until the refresh for this case has arrived.
  const popoverIt = async () => {
    let it = false;
    await until(async () => {
      await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
      await js('(() => { if (!document.getElementById("ext-pop")) document.getElementById("ext-hint-open").click(); return true; })()');
      await until(() => js('!!document.getElementById("ext-recheck")'), 2000);
      it = await js('!!document.getElementById("ext-it") && !!document.getElementById("ext-it-kb")'); // #455: hint to the IT with the KB link
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
      return it;
    }, 4000, 200);
    return it;
  };
  try {
    simulate([]); // no connection
    // UAC cancelled: clear message, nothing changed, the button stays for another try.
    sim(ours(EARLY_ACCESS_FEED), none, 'declined'); // the app is on Stable (default): the policy points elsewhere
    let s = await shown(true);
    if (!s?.fix) fail(`fix: no "Fix now" in the hint where a fix is possible ${JSON.stringify(s)}`);
    else {
      await clickFix(/Abgebrochen|Cancelled/, 'error');
      if (calls[0] && (calls[0].channel !== 'stable' || calls[0].create !== true)) fail(`fix: wrong setup call ${JSON.stringify(calls[0])}`);
      await closeResult();
      if ((await state()).result) fail('fix: the notice does not close');
    }
    // A failure of the elevated step: clear message.
    sim(ours(EARLY_ACCESS_FEED), none, 'failed');
    s = await shown(true);
    if (s?.fix) { await clickFix(/fehlgeschlagen|failed/i, 'error'); await closeResult(); }
    // Success: the restart notice.
    sim(ours(EARLY_ACCESS_FEED), none, 'changed');
    s = await shown(true);
    if (s?.fix) {
      await clickFix(/Erledigt\. Bitte Browser neu starten.*PC neu starten|Done\. Please restart the browser.*restart the PC/, 'ok');
      // Afterwards the policies point to the feed: no button any more, the notice stays until it is closed.
      s = await shown(false);
      if (s.fix || !s.result) fail(`fix: after the fix the button must go and the notice stay ${JSON.stringify(s)}`);
      await closeResult();
    }
    sim(company, company);
    s = await shown(false);
    if (s.fix || !(await popoverIt())) fail(`fix: a company policy must show the hint to the IT and no button ${JSON.stringify(s)}`);
    sim(foreignKey, foreignKey);
    s = await shown(false);
    if (s.fix || !(await popoverIt())) fail(`fix: a foreign key in ExtensionSettings must count as a company policy ${JSON.stringify(s)}`);
    // #455: the company manages the browsers elsewhere (per user, cloud, other extensions): no button, hint to the IT.
    sim(browserPolicy(null, null, true), browserPolicy(null, null, true));
    s = await shown(false);
    if (s.fix || !(await popoverIt())) fail(`fix: a company policy outside our entries (HKCU, cloud) must show the hint to the IT and no button ${JSON.stringify(s)}`);
    sim(ours(STABLE_FEED), ours(STABLE_FEED));
    s = await shown(false);
    if (s.fix) fail(`fix: no button when the policies already point to the channel ${JSON.stringify(s)}`);
    // The app is too old: the setup cannot fix that, so no button even with a wrong policy.
    simulate([{ approved: true, origin: 'chrome-extension://smoke/', extVersion: '0.9.29', minApp: '99.0.0' }]);
    sim(ours(EARLY_ACCESS_FEED), none);
    s = await shown(false);
    if (s.fix) fail(`fix: no button when the app is outdated ${JSON.stringify(s)}`);
    if (calls.length !== 3) fail(`fix: setup ran ${calls.length} times, expected 3`);
  } finally {
    await closeResult();
    simulatePolicy(null);
    simulate(null);
  }
}
