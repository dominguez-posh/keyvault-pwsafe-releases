// Smoke check (#486): logging into Log Analytics in the vault settings. Without admin mode the section is missing and the
// main process refuses; in admin mode it shows the status ("fehlt" in the demo), the dry run lists the steps without
// writing, the setup writes them and the status turns to "aktiv seit". A reader of the vault and a setup without a dry
// run are refused. Part of the feature checks (smoke-features.js), against the demo's imitation of Azure.

import { until } from './smoke-wait.js';

export async function loggingCheck(ctx) {
  const { js, sleep, fail, api, vault, kvc, changed, setAdmin, isAdmin } = ctx;
  const closeDialogs = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu")?.remove(); true');
  const openSettings = async () => {
    await closeDialogs();
    await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)})); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
    await until(() => js('!!document.querySelector(".context-menu [data-action=vault-settings]")'), 2000);
    await js('document.querySelector(".context-menu [data-action=vault-settings]")?.click(); true');
    return until(() => js('!!document.querySelector("dialog[open] .policy-list, dialog[open] .modal-body")'), 4000);
  };
  const options = { workspace: { mode: 'new', resourceGroup: 'rg-keevault-logs', name: 'law-keevault', location: 'germanywestcentral' }, email: 'it@contoso.com' };
  const setAccess = async (value) => {
    const stored = await vault.store.get('containers');
    const entry = stored.find((c) => c.id === kvc.id);
    const before = entry.access;
    entry.access = value;
    await vault.store.set('containers', stored);
    return before;
  };
  const access = (await vault.container(kvc.id)).access;
  try {
    // Without admin mode: no section, and the main process refuses the status.
    if (isAdmin()) await setAdmin(false);
    if (!(await openSettings())) return fail('the vault settings did not open');
    await sleep(300);
    if (await js('!!document.querySelector("dialog[open] .logging-section")')) fail('without admin mode the vault settings show the logging section');
    if (await api.loggingState(kvc.id).then(() => true, () => false)) fail('without admin mode the main process gave the logging status');

    // Admin mode: section with status "missing".
    await setAdmin(true);
    if (!(await openSettings())) return fail('the vault settings did not open in admin mode');
    const state = await until(() => js('document.querySelector("dialog[open] .logging-section .logging-status")?.dataset.state || ""'), 5000);
    if (state !== 'missing') fail(`status in the demo before the setup: "${state}" instead of "missing" (${await js('document.querySelector("dialog[open] .logging-section")?.innerText.slice(0, 200) || "no section"')})`);

    // Setup dialog: a setup without a dry run is refused, the dry run lists the steps and writes nothing.
    await js('document.querySelector("dialog[open] .logging-section .logging-setup")?.click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .logging-dryrun")'), 3000))) return fail('the setup dialog did not open');
    if (!(await js('document.querySelector("dialog[open] .logging-apply")?.disabled === true'))) fail('"Einrichten" is usable before a dry run');
    if (await api.loggingApply(kvc.id, options).then(() => true, (e) => !/Probelauf|dry run/.test(e.message))) fail('the main process set up logging without a dry run');
    await js('(() => { const e = document.querySelector("dialog[open] .logging-email"); e.value = "it@contoso.com"; e.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("dialog[open] .logging-dryrun").click(); return true; })()');
    const steps = await until(async () => {
      const s = await js('[...document.querySelectorAll("dialog[open] .logging-steps li")].map((li) => li.dataset.step + ":" + li.dataset.kind).join(",")');
      return s || '';
    }, 6000);
    for (const want of ['group:create', 'workspace:create', 'diagnostics:create', 'actiongroup:create', 'reads:create', 'activity:create']) {
      if (!String(steps).split(',').includes(want)) fail(`dry run lacks step ${want} (${steps || await js('document.querySelector("dialog[open] .logging-result")?.innerText || ""')})`);
    }
    if ((await api.loggingState(kvc.id)).status.state !== 'missing') fail('the dry run changed the logging');
    // Review 0.9.33: the choice "switch or add a diagnostic setting" exists, and stays hidden without a setting elsewhere.
    if (await js('document.querySelector("dialog[open] .logging-diag")?.hidden !== true || document.querySelectorAll("dialog[open] .logging-diag-mode option").length !== 2')) {
      fail('the diagnostic setting choice is missing or shown without an existing setting to another workspace');
    }
    if (!(await js('document.querySelector("dialog[open] .logging-apply")?.disabled === false'))) fail('"Einrichten" stays off after a dry run without missing rights');

    // Setup: the dialog closes, the section in the vault settings reads "aktiv seit".
    await js('document.querySelector("dialog[open] .logging-apply")?.click(); true');
    if (!(await until(() => js('!document.querySelector("dialog[open] .logging-dryrun")'), 8000))) fail(`the setup did not finish (${await js('document.querySelector("dialog[open] .logging-result")?.innerText || ""')})`);
    const after = await until(() => js('document.querySelector("dialog[open] .logging-section .logging-status")?.dataset.state === "active"'), 5000);
    if (!after) fail(`status after the setup: ${await js('document.querySelector("dialog[open] .logging-section")?.innerText.slice(0, 200) || "no section"')}`);
    else if (!(await js('/aktiv seit|active since/.test(document.querySelector("dialog[open] .logging-section .logging-status").innerText)'))) fail('the status does not say since when logging is active');

    // A reader of the vault gets neither status nor setup.
    await setAccess({ read: true, write: false, manage: false, admin: false });
    if (await api.loggingPlan(kvc.id, options).then(() => true, (e) => !/Verwalter|managers/.test(e.message))) fail('a reader of the vault got a dry run');
  } finally {
    await setAccess(access);
    changed();
    await closeDialogs();
    await setAdmin(false);
  }
}
