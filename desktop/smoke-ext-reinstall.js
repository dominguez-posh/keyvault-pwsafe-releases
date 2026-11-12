// Smoke check of "Browser-Erweiterung neu installieren" (#494). The registry, the UAC step and the browser restart are
// replaced by stand-ins (simulateExtensionReinstall), so no prompt appears, no policy is written and no browser is ended.
// Hint → "Neu installieren" → stand-in for the elevated step → "Edge komplett neu starten?" (Ja) and "Chrome …" (Später)
// → stand-in for the restart, the extension connects again → success notice with the version. Also: cancelled UAC, no
// button with a company policy, and the button in the settings. Part of the feature checks (desktop/smoke-features.js).

import { app } from 'electron';
import { until } from './smoke-wait.js';
import { browserPolicy, EXTENSION_ID, UPDATE_URL, settingsValue } from './machine-setup.js';

export async function extensionReinstallCheck(ctx) {
  const { js, fail, simulate, simulatePolicy, simulateReinstall } = ctx;
  const version = app.getVersion();
  const ours = browserPolicy([{ name: '1', value: `${EXTENSION_ID};${UPDATE_URL}` }], { type: 'REG_SZ', value: settingsValue(UPDATE_URL) });
  const company = browserPolicy([{ name: '1', value: `${EXTENSION_ID};https://updates.example.com/crx.xml` }], null);
  const calls = { reinstall: [], restart: [] };
  const installed = { edge: true, chrome: true };
  const sim = (policies, outcome = 'changed') => {
    // The policies already point to the channel: "Jetzt beheben" has nothing to do, so the hint offers "Neu installieren".
    simulatePolicy({ policies, run: async () => ({ result: 'aligned' }) });
    simulateReinstall({
      policies,
      installed,
      waitMs: 4000,
      reinstall: async (o) => { calls.reinstall.push(o); return outcome === 'changed' ? { result: 'changed', browsers: Object.keys(installed) } : { result: outcome }; },
      // The restarted browser connects again with a new client and the app's version.
      restart: async (b) => { calls.restart.push(b); setTimeout(() => simulate([{ approved: true, origin: 'chrome-extension://smoke/', extVersion: version, minApp: version }]), 300); return { ok: true }; },
    });
  };
  const state = () => js(`JSON.stringify({
    pill: !!document.querySelector("#ext-hint #ext-reinstall"),
    ask: (() => { const d = document.getElementById("ext-restart-ask"); return d?.open ? { browser: d.dataset.browser, text: d.textContent } : null; })(),
    result: (() => { const r = document.getElementById("ext-result"); return r ? { kind: r.className, text: r.textContent } : null; })(),
  })`).then(JSON.parse);
  const refreshUntil = async (test) => {
    let s = null;
    await until(async () => { await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true'); s = await state(); return test(s); }, 8000, 200);
    return s;
  };
  const answer = async (browser, yes) => {
    let s = null;
    if (!(await until(async () => { s = await state(); return s.ask?.browser === browser; }, 4000))) { fail(`no question "${browser} komplett neu starten?" ${JSON.stringify(s)}`); return; }
    if (!/(Edge|Chrome) komplett neu starten\?|Restart (Edge|Chrome) completely\?/.test(s.ask.text) || !/Ungespeicherte Eingaben|Unsaved input/.test(s.ask.text)) fail(`restart question without warning ${JSON.stringify(s.ask)}`);
    await js(`[...document.querySelectorAll("#ext-restart-ask .modal-footer button")].find((b) => ${yes ? '/^(Neu starten|Restart)$/' : '/^(Später|Later)$/'}.test(b.textContent.trim()))?.click(); true`);
    await until(async () => (await state()).ask?.browser !== browser, 2000);
  };
  const closeResult = () => js('document.getElementById("ext-result-close")?.click(); true');
  try {
    // 1. From the hint: restart Edge, not Chrome; the extension connects again.
    simulate([]);
    sim({ edge: ours, chrome: ours });
    let s = await refreshUntil((x) => x.pill);
    if (!s?.pill) fail(`no "Neu installieren" in the hint ${JSON.stringify(s)}`);
    else {
      await js('document.querySelector("#ext-hint #ext-reinstall").click(); true');
      if (!(await until(() => calls.reinstall.length === 1, 4000))) fail('the click did not run the elevated step (stand-in)');
      if (calls.reinstall[0] && (calls.reinstall[0].channel !== 'stable' || calls.reinstall[0].browsers.join() !== 'edge,chrome')) fail(`wrong call ${JSON.stringify(calls.reinstall[0])}`);
      await answer('edge', true);
      await answer('chrome', false);
      if (!(await until(async () => { s = await state(); return s.result && s.result.kind !== 'progress'; }, 8000))) fail(`no notice after the restart ${JSON.stringify(s)}`);
      else if (s.result.kind !== 'ok' || !s.result.text.includes(`(${version})`) || !/wieder verbunden|connected again/.test(s.result.text)) fail(`wrong notice after the restart ${JSON.stringify(s.result)}`);
      if (calls.restart.join() !== 'edge') fail(`restarted ${JSON.stringify(calls.restart)}, expected only Edge`);
      await closeResult();
    }
    // 2. UAC cancelled: clear message, no question about a restart.
    simulate([]);
    sim({ edge: ours, chrome: ours }, 'declined');
    s = await refreshUntil((x) => x.pill);
    if (s?.pill) {
      await js('document.querySelector("#ext-hint #ext-reinstall").click(); true');
      if (!(await until(async () => { s = await state(); return !!s.result; }, 4000))) fail('no notice after a cancelled UAC prompt');
      else if (s.result.kind !== 'error' || !/Abgebrochen|Cancelled/.test(s.result.text) || s.ask) fail(`cancelled UAC: wrong notice ${JSON.stringify(s)}`);
      await closeResult();
    } else fail('no "Neu installieren" for the second case');
    if (calls.restart.length !== 1) fail('a cancelled prompt must not restart anything');
    // 2b. The policy changed between reading and writing (#494 hardening): it stays, the notice says so, no restart.
    simulate([]);
    sim({ edge: ours, chrome: ours }, 'meanwhile');
    s = await refreshUntil((x) => x.pill);
    if (s?.pill) {
      await js('document.querySelector("#ext-hint #ext-reinstall").click(); true');
      if (!(await until(async () => { s = await state(); return !!s.result; }, 4000))) fail('no notice after a policy changed in the meantime');
      else if (s.result.kind !== 'error' || !/inzwischen geändert|changed in the meantime/.test(s.result.text) || s.ask) fail(`changed in the meantime: wrong notice ${JSON.stringify(s)}`);
      await closeResult();
    } else fail('no "Neu installieren" for the case "changed in the meantime"');
    if (calls.restart.length !== 1) fail('a policy changed in the meantime must not restart anything');
    // 3. A company policy: no button, neither in the hint nor in its popover.
    sim({ edge: company, chrome: company });
    s = await refreshUntil((x) => !x.pill);
    const pop = await js('(async () => { document.getElementById("ext-hint-open")?.click(); await new Promise((r) => setTimeout(r, 300)); const p = !!document.getElementById("ext-reinstall-pop"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return p; })()');
    if (s?.pill || pop) fail(`a company policy must offer no reinstall ${JSON.stringify({ s, pop })}`);
    // 4. Settings → Integrationen: the button runs the same flow ("Später" for both: set up, restart later).
    sim({ edge: ours, chrome: ours });
    await js('document.querySelector(".menu-btn")?.click(); true');
    await until(() => js('!!document.querySelector(".main-menu [data-action=settings]")'), 2000);
    await js('document.querySelector(".main-menu [data-action=settings]")?.click(); true');
    await until(() => js('!!document.querySelector("dialog[open] .tabs button")'), 2000);
    await js('[...document.querySelectorAll("dialog[open] .tabs button")].find((b) => /^(Integrationen|Integrations)$/.test(b.textContent.trim()))?.click(); true');
    if (!(await until(() => js('!!document.getElementById("ext-reinstall-btn")?.offsetParent'), 4000))) fail('no "Browser-Erweiterung neu installieren" in the settings');
    else {
      const before = calls.reinstall.length;
      await js('document.getElementById("ext-reinstall-btn").click(); true');
      if (!(await until(() => calls.reinstall.length === before + 1, 4000))) fail('the settings button did not run the elevated step');
      await answer('edge', false);
      await answer('chrome', false);
      const text = await until(() => js('document.getElementById("ext-reinstall-result")?.textContent || ""'), 4000);
      if (!/Neu eingerichtet|Set up again/.test(text || '')) fail(`settings: wrong result "${text}"`);
      if (calls.restart.length !== 1) fail('"Später" must not restart a browser');
    }
    await js('document.querySelectorAll("dialog[open]").forEach((d) => d.close()); true');
  } finally {
    await closeResult();
    simulateReinstall(null);
    simulatePolicy(null);
    simulate(null);
  }
}
