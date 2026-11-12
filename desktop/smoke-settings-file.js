// Smoke check of the settings file (#478): menu entries, export and import through the menu (preview, nothing secret,
// foreign keys dropped), the copy in OneDrive and the question at the first start. Part of the feature checks
// (desktop/smoke-features.js), which have reached their size limit. OneDrive is a temporary test folder
// (KVPWSAFE_TEST_ONEDRIVE), never the user's real one; the files are removed afterwards.

import { mkdtemp, open, readFile, rm, rmdir, symlink, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSettingsFile, parseSettingsFile, SETTINGS_MARKER } from './settings-file.js';
import { until } from './smoke-wait.js';

const SECRET = ['"appPin"', '"pinGuard"', '"personalDeviceKeys"', '"personalVaults"', '"approvedAgents"', '"adminTools"', '"hash"'];
const exists = (f) => stat(f).then(() => true, () => false);

export async function settingsFileCheck({ js, sleep, config, vault, changed, ensurePin, fail, vaultListRun }) {
  const f = (message) => fail('settingsfile', message);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-settings-'));
  const exportFile = path.join(dir, 'export.json');
  const copy = path.join(dir, 'Keevault', 'Keevault-Einstellungen.json');
  const env = { od: process.env.KVPWSAFE_TEST_ONEDRIVE, file: process.env.KVPWSAFE_TEST_SETTINGS_FILE };
  const keep = ['theme', 'setupOffered', 'personalVaults', 'settingsCopyPending', 'settingsCopy', 'autoLockMinutes', 'clipboardSeconds', 'unlockPrompt', 'updateMode', 'clientId', 'breakGlass', 'defaultContainer', 'containers', 'hiddenContainers', 'sourceBadges', 'containerOrder'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const closeAll = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".main-menu")?.remove(); true');
  const menu = async (action) => {
    await closeAll();
    await js('document.querySelector(".menu-btn")?.click(); true');
    if (!(await until(() => js(`!!document.querySelector(".main-menu [data-action=${action}]")`), 2000))) return false;
    return js(`document.querySelector(".main-menu [data-action=${action}]").click(); true`);
  };
  try {
    process.env.KVPWSAFE_TEST_ONEDRIVE = dir;
    process.env.KVPWSAFE_TEST_SETTINGS_FILE = exportFile;
    await ensurePin(); // a PIN is set: it must not reach the file
    // A device past its first start that agreed to the copy, with values an import must not weaken (#478 review).
    config.update({ settingsCopy: true, settingsCopyPending: false, setupOffered: true, theme: 'system', autoLockMinutes: 10, clipboardSeconds: 20, unlockPrompt: 'select_account', updateMode: 'ask' });

    // Menu: both entries, export writes the allowlist only.
    if (!(await menu('settings-export'))) f('menu entry "Einstellungen exportieren …" missing');
    // Waits for the whole file: it exists before writeFile has finished.
    if (!(await until(async () => (await readFile(exportFile, 'utf8').catch(() => '')).trimEnd().endsWith('}'), 5000))) f('export wrote no file');
    else {
      const text = await readFile(exportFile, 'utf8');
      const leaked = SECRET.filter((s) => text.includes(s));
      if (leaked.length) f(`export contains ${leaked.join(', ')}`);
      try {
        const read = parseSettingsFile(text);
        if (JSON.parse(text).marker !== SETTINGS_MARKER || read.dropped.length) f(`export not read back cleanly (dropped ${read.dropped.join(',')})`);
      } catch (e) {
        f(`export not readable: ${e.message}`);
      }
    }

    // Import: preview first (nothing applied), foreign and invalid keys dropped, then applied. Break-glass accounts,
    // weakening values, an unknown default vault and another app registration (not ticked) change nothing (#478 review).
    const pin = JSON.stringify(config.get().appPin);
    const sec = { clientId: config.get().clientId, breakGlass: JSON.stringify(config.get().breakGlass || {}), defaultContainer: config.get().defaultContainer };
    const otherClient = sec.clientId === '99999999-8888-7777-6666-555555555555' ? '99999999-8888-7777-6666-444444444444' : '99999999-8888-7777-6666-555555555555';
    await writeFile(exportFile, JSON.stringify({ marker: SETTINGS_MARKER, version: 1, device: 'Smoke-PC', exportedAt: new Date().toISOString(),
      settings: { theme: 'dark', appPin: { hash: 'x' }, adminTools: true, helperExe: 'C:\\evil.exe', containers: [{ name: 'Fremd', vaultUrl: 'https://evil.example.com/' }],
        breakGlass: { '11111111-2222-3333-4444-555555555555': [{ id: 'attacker', type: 'user', displayName: 'IT Notfall', detail: '' }] },
        autoLockMinutes: 0, clipboardSeconds: 600, unlockPrompt: 'none', updateMode: 'off', defaultContainer: 'kv-unknown-478.vault.azure.net', clientId: otherClient } }));
    if (!(await menu('settings-import'))) f('menu entry "Einstellungen importieren …" missing');
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-import-modal")'), 5000))) f('import shows no preview');
    else {
      if (config.get().theme === 'dark') f('import applied before it was confirmed');
      const keys = await js('[...document.querySelectorAll("dialog[open].settings-import-modal li[data-key]")].map((l) => l.dataset.key).join(",")');
      if (!/\btheme\b/.test(keys) || /appPin|adminTools|helperExe/.test(keys)) f(`preview shows ${keys}`);
      const dropped = await js('document.querySelector("dialog[open].settings-import-modal [data-dropped]")?.dataset.dropped || ""');
      for (const k of ['appPin', 'adminTools', 'helperExe', 'containers', 'breakGlass']) if (!dropped.split(',').includes(k)) f(`preview does not name ${k} as not taken over (${dropped})`);
      const refused = await js('[...document.querySelectorAll("dialog[open].settings-import-modal li[data-refused]")].filter((l) => /nicht übernommen \\(Sicherheit\\)/.test(l.textContent)).map((l) => l.dataset.key).join(",")');
      for (const k of ['autoLockMinutes', 'clipboardSeconds', 'unlockPrompt', 'updateMode', 'defaultContainer']) if (!refused.split(',').includes(k)) f(`preview does not grey out ${k} as "nicht übernommen (Sicherheit)" (${refused})`);
      if (!(await js('!!document.querySelector("dialog[open].settings-import-modal input[data-confirm=clientId]") && /Nur übernehmen, wenn deine IT sie vorgibt/.test(document.querySelector("dialog[open].settings-import-modal")?.textContent || "")'))) f('preview does not ask for the other app registration separately');
      if (!(await js('/Smoke-PC/.test(document.querySelector("dialog[open].settings-import-modal")?.textContent || "")'))) f('preview does not name the device');
      await js('document.querySelector("dialog[open].settings-import-modal .modal-footer .btn.primary")?.click(); true');
      if (!(await until(() => config.get().theme === 'dark', 5000))) f('import did not apply the theme');
      if (JSON.stringify(config.get().appPin) !== pin) f('import changed the app PIN');
      if (config.get().adminTools === true) f('import switched admin mode on');
      if (config.get().containers.some((c) => /evil/.test(c.vaultUrl))) f('import added a foreign vault address');
      if (JSON.stringify(config.get().breakGlass || {}) !== sec.breakGlass) f('import set break-glass accounts');
      const now = config.get();
      if (now.autoLockMinutes !== 10 || now.clipboardSeconds !== 20 || now.unlockPrompt !== 'select_account' || now.updateMode !== 'ask') f(`import weakened the device (${now.autoLockMinutes}, ${now.clipboardSeconds}, ${now.unlockPrompt}, ${now.updateMode})`);
      if (now.defaultContainer !== sec.defaultContainer) f('import set an unknown default vault');
      if (now.clientId !== sec.clientId) f('import changed the app registration without its confirmation');
    }

    // #478 re-review: a file lists the user's own vault next to a look-alike of the same name, hides the own one, makes
    // the look-alike the default and changes badges and order. The look-alike is red and not ticked, the own vault stays.
    const own = ((await vault.containers().catch(() => [])) || []).find((c) => c.kind === 'keyvault' && /\.vault\.azure\.net$/.test(c.id) && c.name);
    if (!own) f('no Key Vault in the demo for the look-alike check');
    else {
      const dup = 'kv-smoke478-dup.vault.azure.net';
      const fresh = 'kv-smoke478-new.vault.azure.net';
      const dup2 = 'kv-smoke511-dup.vault.azure.net'; // same name with an invisible character and other case (#511 review)
      const was = { hidden: JSON.stringify(config.get().hiddenContainers || []), def: config.get().defaultContainer, badges: config.get().sourceBadges, order: JSON.stringify(config.get().containerOrder || []) };
      await writeFile(exportFile, JSON.stringify({ marker: SETTINGS_MARKER, version: 1, device: 'Smoke-PC', exportedAt: new Date().toISOString(), settings: {
        containers: [{ name: own.name, vaultUrl: `https://${own.id}/` }, { name: own.name, vaultUrl: `https://${dup}/`, tenantId: 'evil.onmicrosoft.com' }, { name: 'Smoke478 Neu', vaultUrl: `https://${fresh}/` },
          { name: `​${own.name.toUpperCase()} `, vaultUrl: `https://${dup2}/` }],
        hiddenContainers: [own.id], defaultContainer: dup, sourceBadges: !config.get().sourceBadges, containerOrder: [dup, own.id] } }));
      if (!(await menu('settings-import')) || !(await until(() => js('!!document.querySelector("dialog[open].settings-import-modal")'), 5000))) f('look-alike import shows no preview');
      else {
        const q = (sel) => `document.querySelector("dialog[open].settings-import-modal ${sel}")`;
        const row = await js(`(() => { const l = ${q(`li[data-vault='${dup}']`)}; return l ? { clash: l.dataset.clash, ticked: l.querySelector("input").checked, text: l.textContent } : null; })()`);
        if (!row) f('look-alike vault not listed on its own');
        else {
          if (row.clash !== '1' || !/Name schon vorhanden – anderer Tresor!/.test(row.text)) f('look-alike vault not marked "Name schon vorhanden – anderer Tresor!"');
          if (row.ticked) f('look-alike vault ticked by default');
          if (!row.text.includes(dup) || !row.text.includes('evil.onmicrosoft.com')) f(`look-alike row without host or tenant (${row.text})`);
        }
        if (!(await js(`!!${q(`input[data-vault='${fresh}']`)}?.checked`))) f('new vault without a look-alike not ticked by default');
        if (!(await js(`${q(`li[data-vault='${dup2}']`)}?.dataset.clash === "1" && !${q(`input[data-vault='${dup2}']`)}?.checked`))) f('look-alike with an invisible character not marked or ticked (#511)');
        if (await js(`!!${q('[data-discovering]')}`)) f('notice "Tresorsuche läuft noch" shown though no search runs');
        if (await js(`!!${q(`li[data-vault='${own.id}']`)}`)) f('the user\'s own vault listed as new');
        if (!(await js(`/Prüfe, dass du diese Tresore kennst\\./.test(${q('')}?.textContent || "")`))) f('no notice "Prüfe, dass du diese Tresore kennst."');
        const defRow = await js(`${q('li[data-key=defaultContainer]')}?.textContent || ""`);
        if (!(await js(`!!${q('input[data-confirm=defaultContainer]')}`)) || !defRow.includes(dup) || !defRow.includes(own.name)) f(`new default vault not asked with name and host (${defRow})`);
        const greyed = await js('[...document.querySelectorAll("dialog[open].settings-import-modal li[data-refused]")].map((l) => l.dataset.key).join(",")');
        for (const k of ['hiddenContainers', 'sourceBadges', 'containerOrder']) if (!greyed.split(',').includes(k)) f(`look-alike import does not grey out ${k} (${greyed})`);
        await js(`${q('.modal-footer .btn.primary')}?.click(); true`);
        if (!(await until(() => (config.get().containers || []).some((c) => c.vaultUrl.includes(fresh)), 5000))) f('ticked new vault not added');
        const now = config.get();
        if (now.containers.some((c) => c.vaultUrl.includes(dup) || c.vaultUrl.includes(dup2))) f('look-alike vault added without its tick');
        if ((now.hiddenContainers || []).includes(own.id) || JSON.stringify(now.hiddenContainers || []) !== was.hidden) f('import hid the user\'s own vault');
        if (now.defaultContainer !== was.def) f('import made the look-alike the default vault');
        if (now.sourceBadges !== was.badges || JSON.stringify(now.containerOrder || []) !== was.order) f('import changed source badges or vault order');
        // The test vault does not exist in the demo: gone again before the next steps.
        config.update({ containers: before.containers });
        changed();
      }
    }

    // #511 review: while the vault search runs (first start), a new vault is not ticked in advance, hidden vaults are
    // not taken over and the preview says to import again shortly.
    const searching = vaultListRun(); // a vault search held open (desktop/main/session.js)
    try {
      const was = JSON.stringify(config.get().hiddenContainers || []);
      await writeFile(exportFile, JSON.stringify({ marker: SETTINGS_MARKER, version: 1, device: 'Smoke-PC', exportedAt: new Date().toISOString(), settings: {
        containers: [{ name: 'Smoke511 Neu', vaultUrl: 'https://kv-smoke511-new.vault.azure.net/' }], hiddenContainers: ['kv-smoke511-hidden.vault.azure.net'] } }));
      if (!(await menu('settings-import')) || !(await until(() => js('!!document.querySelector("dialog[open].settings-import-modal")'), 5000))) f('import during the vault search shows no preview');
      else {
        const q = (sel) => `document.querySelector("dialog[open].settings-import-modal ${sel}")`;
        if (!(await js(`/Tresorsuche läuft noch – bitte gleich erneut importieren/.test(${q('[data-discovering]')}?.textContent || "")`))) f('no notice "Tresorsuche läuft noch – bitte gleich erneut importieren"');
        if (await js(`!!${q("input[data-vault='kv-smoke511-new.vault.azure.net']")}?.checked`)) f('new vault ticked in advance during the vault search');
        if (!(await js(`${q('li[data-key=hiddenContainers]')}?.dataset.refused === "1"`))) f('hidden vaults not greyed out during the vault search');
        await js(`${q('.modal-footer .btn.primary')}?.click(); true`);
        await sleep(800);
        if (config.get().containers.some((c) => c.vaultUrl.includes('kv-smoke511-new'))) f('unticked vault added during the vault search');
        if (JSON.stringify(config.get().hiddenContainers || []) !== was) f('hidden vaults taken over during the vault search');
      }
    } finally {
      searching();
    }

    // The copy in OneDrive follows the change, without anything secret.
    const copied = await until(async () => (await readFile(copy, 'utf8').catch(() => '')).includes('"dark"'), 6000);
    if (!copied) f('no copy in OneDrive after the change');
    else {
      const text = await readFile(copy, 'utf8');
      const leaked = SECRET.filter((s) => text.includes(s));
      if (leaked.length) f(`OneDrive copy contains ${leaked.join(', ')}`);
    }

    // The Keevault folder in OneDrive is a junction: nothing is written there, a notice says so.
    const elsewhere = path.join(dir, 'Elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await rm(path.dirname(copy), { recursive: true, force: true });
    await symlink(elsewhere, path.dirname(copy), 'junction');
    config.update({ theme: 'light' });
    if (!(await until(() => js('/Verknüpfung \\(Junction\\)/.test(document.getElementById("toast")?.textContent || "")'), 5000))) f('no notice when the Keevault folder is a junction');
    if (await exists(path.join(elsewhere, 'Keevault-Einstellungen.json'))) f('copy written through a junction');
    await rmdir(path.dirname(copy));

    // An installation from before the update (copy not answered): asked once, "Nein" writes nothing.
    config.update({ settingsCopy: null, setupOffered: true, settingsCopyPending: false });
    await js('window.kvSmokeSettingsStep = true; document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-consent-modal")'), 6000))) f('no question for the OneDrive copy after the update');
    else {
      if (!(await js('/Tresornamen, -adressen und Tenant-IDs, aber keine Passwörter oder Schlüssel/.test(document.querySelector("dialog[open].settings-consent-modal")?.textContent || "")'))) f('copy question has the wrong text');
      await sleep(800);
      if (await exists(copy)) f('copy written before the user answered');
      await js('[...document.querySelectorAll("dialog[open].settings-consent-modal .modal-footer .btn")].find((b) => /^Nein$/.test(b.textContent.trim()))?.click(); true');
      if (!(await until(() => config.get().settingsCopy === false, 3000))) f('"Nein" did not switch the copy off');
      config.update({ theme: 'dark' });
      await sleep(1000);
      if (await exists(copy)) f('copy written after "Nein"');
    }
    await js('window.kvSmokeSettingsStep = false; true');

    // First start, OneDrive not connected: the question, "check again" finds it with settings of another device.
    process.env.KVPWSAFE_TEST_ONEDRIVE = 'none';
    config.update({ setupOffered: false, personalVaults: [], settingsCopyPending: false, settingsCopy: null });
    await js('window.kvSmokeWizards = true; window.kvSmokeSettingsStep = true; document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-onedrive-modal")'), 6000))) return f('first start does not ask whether OneDrive is connected');
    if (!(await js('/OneDrive-Ordner bereits verbunden/.test(document.querySelector("dialog[open].settings-onedrive-modal")?.textContent || "")'))) f('OneDrive question has the wrong text');
    if (!config.get().settingsCopyPending) f('copy not held back while the first start asks');
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, buildSettingsFile({ theme: 'light', language: 'de', appPin: { hash: 'x' } }, { device: 'Altes-Notebook', now: new Date('2026-11-01T09:00:00Z') }));
    process.env.KVPWSAFE_TEST_ONEDRIVE = dir;
    await js('[...document.querySelectorAll("dialog[open].settings-onedrive-modal .modal-footer .btn")].find((b) => /Erneut prüfen/.test(b.textContent))?.click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-import-modal")'), 6000))) return f('"Erneut prüfen" does not offer the settings found');
    if (!(await js('/Einstellungen von Altes-Notebook/.test(document.querySelector("dialog[open].settings-import-modal")?.textContent || "")'))) f('first-start offer does not name device and date');
    await js('document.querySelector("dialog[open].settings-import-modal .modal-footer .btn.primary")?.click(); true');
    if (!(await until(() => config.get().theme === 'light', 5000))) f('first-start import did not apply the settings');
    if (!(await until(() => !config.get().settingsCopyPending, 3000))) f('copy still held back after the first-start question');
    if (JSON.stringify(config.get().appPin) !== pin) f('first-start import changed the app PIN');
    // Then the question for the copy: nothing is written before "Ja", afterwards this device keeps it.
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-consent-modal")'), 6000))) f('first start does not ask for the OneDrive copy');
    else {
      await sleep(800);
      if (!/Altes-Notebook/.test(await readFile(copy, 'utf8').catch(() => ''))) f('copy overwritten before the user agreed');
      // #353: another program has the file open at the moment of the rename (OneDrive, a scanner): the copy is retried, not lost.
      const reader = await open(copy, 'r');
      setTimeout(() => reader.close().catch(() => {}), 700);
      await js('document.querySelector("dialog[open].settings-consent-modal .modal-footer .btn.primary")?.click(); true');
      if (!(await until(() => config.get().settingsCopy === true, 3000))) f('"Ja, sichern" did not switch the copy on');
      if (!(await until(async () => /Demo-PC/.test(await readFile(copy, 'utf8').catch(() => '')), 6000))) f('no copy written after "Ja, sichern"');
    }
  } catch (e) {
    f(e.message);
  } finally {
    // The wizards that follow the question: closed, the state from before back.
    await js('window.kvSmokeWizards = false; window.kvSmokeSettingsStep = false; true');
    for (let i = 0; i < 6; i++) {
      await closeAll();
      await sleep(400);
    }
    if (env.od === undefined) delete process.env.KVPWSAFE_TEST_ONEDRIVE; else process.env.KVPWSAFE_TEST_ONEDRIVE = env.od;
    if (env.file === undefined) delete process.env.KVPWSAFE_TEST_SETTINGS_FILE; else process.env.KVPWSAFE_TEST_SETTINGS_FILE = env.file;
    config.update(before);
    changed();
    await sleep(500);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return undefined;
}
