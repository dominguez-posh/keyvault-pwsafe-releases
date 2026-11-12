// Smoke check (#500): the compliance view. Without admin mode neither the vault menu nor the main menu offers it and the
// main process refuses; a reader of the vault doesn't get it either. In admin mode a Verwalter opens it from the vault
// menu: "Person ausgeschieden" lists the former member Kim (activity log of the demo) and shows "seitdem geändert" /
// "noch nicht geändert" against the demo dates; "Alte Passwörter" filters by months; the CSV holds no secret value.
// With a workspace (the #486 setup of the demo) the leaver list uses Kim's read history and the standard reports show
// titles instead of technical names, a deleted entry masked, and how far the data goes back.

import { until } from './smoke-wait.js';

export async function complianceCheck(ctx) {
  const { js, sleep, fail, api, vault, kvc, changed, setAdmin, isAdmin } = ctx;
  const closeDialogs = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu")?.remove(); document.querySelector(".main-menu")?.remove(); true');
  const vaultMenu = async () => {
    await closeDialogs();
    await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)})); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
    return until(() => js('!!document.querySelector(".context-menu [data-action=refresh]")'), 2000);
  };
  const mainMenuHas = async () => {
    await closeDialogs();
    await js('document.querySelector(".menu-btn")?.click()');
    await until(() => js('!!document.querySelector(".main-menu [data-action=settings]")'), 1500);
    const has = await js('!!document.querySelector(".main-menu [data-action=compliance]")');
    await closeDialogs();
    return has;
  };
  const setAccess = async (value) => {
    const stored = await vault.store.get('containers');
    stored.find((c) => c.id === kvc.id).access = value;
    await vault.store.set('containers', stored);
    changed();
    await sleep(500);
  };
  const access = (await vault.container(kvc.id)).access;
  const saveTextFile = api.saveTextFile;
  const saved = [];
  try {
    // Without admin mode: nowhere offered, refused by the main process.
    if (isAdmin()) await setAdmin(false);
    if (!(await vaultMenu())) return fail('the vault menu did not open');
    if (await js('!!document.querySelector(".context-menu [data-action=compliance]")')) fail('the vault menu offers "Compliance" without admin mode');
    if (await mainMenuHas()) fail('the main menu offers "Compliance" without admin mode');
    if (await api.complianceState(kvc.id).then(() => true, () => false)) fail('without admin mode the main process gave the compliance state');
    if (await api.complianceEntries(kvc.id).then(() => true, () => false)) fail('without admin mode the main process gave the compliance entries');

    // Admin mode, but only a reader of the vault: not offered, refused.
    await setAdmin(true);
    await setAccess({ read: true, write: false, manage: false, admin: false });
    await vaultMenu();
    if (await js('!!document.querySelector(".context-menu [data-action=compliance]")')) fail('a reader of the vault gets "Compliance" in the vault menu');
    if (await api.complianceEntries(kvc.id).then(() => true, (e) => !/Verwalter|managers/.test(e.message))) fail('a reader of the vault got the compliance entries');
    await setAccess(access);

    // Part 1 is checked without a workspace: logging set up by an earlier area (logging) is taken away in the demo.
    const c = await vault.container(kvc.id);
    const vaultId = c.resourceId || (await vault.azureFor(c).findVault(c.vaultUrl))?.resourceId; // as desktop/main/session.js containerResource
    const azure = vault.azureFor(c);
    for (const s of (await azure.arm('GET', `${vaultId}/providers/Microsoft.Insights/diagnosticSettings`, '2021-05-01-preview'))?.value || []) {
      await azure.arm('DELETE', `${vaultId}/providers/Microsoft.Insights/diagnosticSettings/${s.name}`, '2021-05-01-preview');
    }
    if (await api.complianceReport(kvc.id, { kind: 'reads', from: Date.now() - 86_400_000, to: Date.now() }).then(() => true, (e) => !/Protokollierung|logging/i.test(e.message))) fail('a report without a workspace did not say that logging is missing');

    // Verwalter in admin mode: in both menus.
    if (!(await mainMenuHas())) fail('the main menu does not offer "Compliance" to a Verwalter in admin mode');
    await vaultMenu();
    if (!(await js('!!document.querySelector(".context-menu [data-action=compliance]")'))) return fail('the vault menu does not offer "Compliance" to a Verwalter in admin mode');
    await js('document.querySelector(".context-menu [data-action=compliance]").click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .compliance-person")'), 8000))) {
      return fail(`the compliance view did not open (${await js('document.querySelector("dialog[open]")?.innerText.slice(0, 200) || "no dialog"')})`);
    }

    // "Person ausgeschieden": the former member Kim, left on 2026-01-01.
    const kim = await js('[...document.querySelectorAll("dialog[open] .compliance-person option")].find((o) => /Kim/.test(o.textContent))?.value || ""');
    if (!kim) fail(`the former member is missing (${await js('[...document.querySelectorAll("dialog[open] .compliance-person option")].map((o) => o.textContent).join(" | ")')})`);
    await js(`(() => { const d = document.querySelector("dialog[open]"); d.querySelector(".compliance-person").value = ${JSON.stringify(kim)}; d.querySelector(".compliance-left").value = "2026-01-01"; d.querySelector(".compliance-show").click(); return true; })()`);
    const status = (title) => js(`[...document.querySelectorAll("dialog[open] .compliance-leaver tbody tr")].find((r) => r.cells[0].textContent === ${JSON.stringify(title)})?.dataset.status || ""`);
    await until(() => js('document.querySelectorAll("dialog[open] .compliance-leaver tbody tr").length > 0'), 3000);
    if ((await status('Grafana')) !== 'changed') fail(`Grafana (password changed 2026-09-20) is not "seitdem geändert": "${await status('Grafana')}"`);
    if ((await status('Firewall Admin')) !== 'unchanged') fail(`Firewall Admin (changed 2025-06-15) is not "noch nicht geändert": "${await status('Firewall Admin')}"`);
    // Review 0.9.33: the dates come from the metadata (tag pc), not from reading every entry.
    const meta = await api.complianceEntries(kvc.id);
    const fw = meta.rows.find((r) => r.title === 'Firewall Admin');
    if (meta.readAll || fw?.source !== 'password' || fw?.estimated) fail(`compliance entries not from the metadata: ${JSON.stringify(fw || null)}, readAll ${meta.readAll}`);
    if (!(await js('/ohne Protokollierung nicht|Without logging/.test(document.querySelector("dialog[open] .compliance-leaver").innerText)'))) fail('the leaver view lacks the honest notice without logging');

    // CSV of the leaver list: no secret value of the demo.
    api.saveTextFile = async ({ name, text }) => { saved.push({ name, text }); return true; };
    await js('document.querySelector("dialog[open] .compliance-leaver .compliance-export")?.click(); true');
    await until(() => saved.length > 0, 3000);
    const csv = saved.at(-1)?.text || '';
    if (!/Grafana/.test(csv) || !/seitdem geändert/.test(csv)) fail(`the leaver CSV lacks the list (${csv.slice(0, 160)})`);
    if (/Lm2#tR6!wQz9&Kv4|Tz9!kB3#vNq7\$Hw2|Xc5&rM8!pLq3#Vz7/.test(csv)) fail('the leaver CSV contains a password');

    // "Alte Passwörter": 12 months → Firewall Admin and the emergency account, not Grafana; 3 months the same.
    await js('[...document.querySelectorAll("dialog[open] .tabs button")][1]?.click(); true');
    await js('document.querySelector("dialog[open] .compliance-age [data-months=\'12\']")?.click(); true');
    await sleep(200);
    const old = await js('[...document.querySelectorAll("dialog[open] .compliance-age tbody tr")].map((r) => r.cells[0].textContent)');
    if (!old.includes('Firewall Admin') || !old.includes('Azure Notfallkonto') || old.includes('Grafana')) fail(`passwords older than 12 months: ${JSON.stringify(old)}`);
    await js('(() => { const i = document.querySelector("dialog[open] .compliance-months"); i.value = "1"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await sleep(200);
    if (!(await js('[...document.querySelectorAll("dialog[open] .compliance-age tbody tr")].some((r) => r.cells[0].textContent === "Grafana")'))) fail('free input of 1 month does not list Grafana (changed 2026-09-20)');
    await js('document.querySelector("dialog[open] .compliance-age .compliance-export")?.click(); true');
    await until(() => saved.length > 1, 3000);
    const csv2 = saved.at(-1)?.text || '';
    if (saved.length < 2 || !/Firewall Admin/.test(csv2)) fail(`the age CSV was not written (${csv2.slice(0, 120)})`);
    if (/Lm2#tR6!wQz9&Kv4|Tz9!kB3#vNq7\$Hw2|Xc5&rM8!pLq3#Vz7/.test(csv2)) fail('the age CSV contains a password');
    if (!(await js('document.querySelector("dialog[open] .compliance-reports")?.dataset.logged === "0"'))) fail('without a workspace the log tab does not say that logging is missing');

    // Part 2: with a workspace (#486 setup in the demo) the leaver list uses Kim's read history.
    const options = { workspace: { mode: 'new', resourceGroup: 'rg-keevault-logs', name: 'law-keevault', location: 'germanywestcentral' }, email: 'it@contoso.com' };
    await api.loggingPlan(kvc.id, options);
    await api.loggingApply(kvc.id, options);
    await closeDialogs();
    await vaultMenu();
    await js('document.querySelector(".context-menu [data-action=compliance]")?.click(); true');
    if (!(await until(() => js('document.querySelector("dialog[open] .compliance-reports")?.dataset.logged === "1"'), 8000))) return fail('with a workspace the log tab is not offered');
    await js(`(() => { const d = document.querySelector("dialog[open]"); [...d.querySelectorAll(".tabs button")][0].click(); d.querySelector(".compliance-person").value = ${JSON.stringify(kim)}; d.querySelector(".compliance-show").click(); return true; })()`);
    await until(() => js('!!document.querySelector("dialog[open] .compliance-leaverlog tbody tr")'), 5000);
    for (const [title, want] of [['Firewall Admin', 'unchanged'], ['Grafana', 'changed'], ['Azure Notfallkonto', 'notread']]) {
      const got = await js(`[...document.querySelectorAll("dialog[open] .compliance-leaverlog tbody tr")].find((r) => r.cells[0].textContent === ${JSON.stringify(title)})?.dataset.status || ""`);
      if (got !== want) fail(`with the read history ${title} is "${got}" instead of "${want}" (${await js('document.querySelector("dialog[open] .compliance-leaver")?.innerText.slice(0, 300) || ""')})`);
    }
    if (!(await js('/reichen zurück bis|goes back to/.test(document.querySelector("dialog[open] .compliance-leaver .compliance-coverage")?.textContent || "")'))) fail('the leaver list does not say how far the log goes back');

    // Standard reports: titles instead of pws-…, a deleted entry masked; every report answers; the CSV has no secret.
    await js('[...document.querySelectorAll("dialog[open] .tabs button")][2]?.click(); true');
    for (const kind of ['reads', 'many', 'denied', 'apps', 'changes']) {
      await js(`(() => { const d = document.querySelector("dialog[open]"); d.querySelector(".compliance-from").value = "2025-11-10"; d.querySelector(".compliance-kind").value = ${JSON.stringify(kind)}; d.querySelector(".compliance-run").click(); return true; })()`);
      const rows = await until(() => js(`document.querySelectorAll("dialog[open] .compliance-reports .compliance-${kind} tbody tr").length`), 5000);
      if (!rows) fail(`report ${kind} shows no rows (${await js('document.querySelector("dialog[open] .compliance-reports .compliance-result")?.innerText.slice(0, 200) || ""')})`);
      const text = await js('document.querySelector("dialog[open] .compliance-reports .compliance-result")?.innerText || ""');
      if (/pws-/.test(text)) fail(`report ${kind} shows a technical name`);
      if (kind === 'reads' && (!/Firewall Admin/.test(text) || !/Gelöschter oder unbekannter Eintrag|Deleted or unknown entry/.test(text))) fail(`reads report without title or mask: ${text.slice(0, 300)}`);
      if (kind === 'reads' && !/reichen zurück bis|goes back to/.test(text)) fail('the report does not say how far the data goes back');
    }
    await js('(() => { const d = document.querySelector("dialog[open]"); d.querySelector(".compliance-kind").value = "denied"; d.querySelector(".compliance-run").click(); return true; })()');
    await until(() => js('!!document.querySelector("dialog[open] .compliance-reports .compliance-denied tbody tr")'), 5000);
    const before = saved.length;
    await js('document.querySelector("dialog[open] .compliance-reports .compliance-export")?.click(); true');
    await until(() => saved.length > before, 3000);
    const csv3 = saved.at(-1)?.text || '';
    if (saved.length === before || !/Azure Notfallkonto/.test(csv3) || !/203\.0\.113\.7/.test(csv3)) fail(`the report CSV lacks the list (${csv3.slice(0, 200)})`);
    if (/Lm2#tR6!wQz9&Kv4|Tz9!kB3#vNq7\$Hw2|Xc5&rM8!pLq3#Vz7|pws-/.test(csv3)) fail('the report CSV contains a password or a technical name');
  } finally {
    api.saveTextFile = saveTextFile;
    await setAccess(access);
    await closeDialogs();
    await setAdmin(false);
  }
}
