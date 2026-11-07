// Smoke check of the hint on the browser extension next to the version tag (#454): the three cases and "all good"
// (bridge clients simulated), the popover with "Check again", and that the hint goes away when everything fits.
// Part of the feature checks (desktop/smoke-features.js).

import { until } from './smoke-wait.js';

export async function extensionHintCheck(ctx) {
  const { js, fail, simulate } = ctx;
  const browser = { approved: true, origin: 'chrome-extension://smoke/', extVersion: '0.9.29', minApp: '0.9.29' };
  const shown = () => js('JSON.stringify((() => { const b = document.getElementById("ext-hint"); return b ? { text: b.textContent, state: b.dataset.state, calm: !b.classList.contains("error") } : null; })())').then(JSON.parse);
  const recheck = async () => {
    await js('document.querySelector("#ext-hint")?.click(); true');
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
      const popover = await js('(async () => { document.getElementById("ext-hint").click(); await new Promise((r) => setTimeout(r, 200)); const p = document.getElementById("ext-pop"); return p ? { steps: p.querySelectorAll("li").length, recheck: !!p.querySelector("#ext-recheck") } : null; })()');
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
}
