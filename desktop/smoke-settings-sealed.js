// Smoke check of #537 stage 5 (E5): the copy of the settings in OneDrive is encrypted with the personal vault's key.
// The plain copy of before is replaced once (with the notice), the copy holds nothing readable but its head and nothing
// bound to the device, a key change writes it anew. A new device: "Keevault-Konfiguration in OneDrive gefunden –
// übernehmen?" → master password → personal vault, master password and vault list set up, then the Hello/PIN question.
// Counter-checks: wrong master password (nothing taken), changed head, the old plain copy. OneDrive and the personal vault
// are a temporary test folder (KVPWSAFE_TEST_ONEDRIVE, KVPWSAFE_TEST_REMOTE), never the user's real one.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSettingsFile } from './settings-file.js';
import { peekSealedFile } from './settings-sealed.js';
import { until } from './smoke-wait.js';

const MP = 'Smoke-Sealed-537!';
const MP2 = 'Smoke-Sealed-537-neu!';
const ACCOUNT = 'dialog[open].wizard-modal .first-start-wizard';
// Konrad E5: device-bound fields and secrets never in the copy (readable or not).
const SECRET = ['"appPin"', '"pinGuard"', '"personalDeviceKeys"', '"personalVaults"', '"unlockKeys"', '"hello"', '"helloKey"', '"blob"', '"approvedAgents"', '"adminTools"', '"hash"', '"breakGlass"', '"theme"', '"dark"', '"containers"', 'vault.azure.net'];
const rejects = (p) => p.then(() => null, (e) => e.message || 'Error');

export async function settingsSealedCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, fail }) {
  const keep = ['autoLockMinutes', 'appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'settingsCopy', 'settingsCopyPending', 'settingsCopyPlainGone', 'setupOffered', 'theme', 'personalRecoveryPending', 'personalRecoveryRenewed'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const env = { od: process.env.KVPWSAFE_TEST_ONEDRIVE, remote: process.env.KVPWSAFE_TEST_REMOTE, hello: process.env.KVPWSAFE_TEST_HELLO };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-sealed-'));
  const copy = path.join(dir, 'Keevault', 'Keevault-Einstellungen.json');
  const personalFile = path.join(dir, 'Keevault-Persoenlich.kvpws');
  const read = () => readFile(copy, 'utf8').catch(() => '');
  const head = async () => { try { return peekSealedFile(await read()); } catch { return null; } };
  const personalId = async () => (await api.state()).containers.find((c) => c.path === personalFile)?.id || null;
  const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  // A new device: nothing of the master password or the personal vault here, the files stay in "OneDrive". The copy is
  // off meanwhile, so that no write of this device replaces the files the counter-checks put there.
  const asNewDevice = async () => {
    const id = await personalId();
    config.update({ settingsCopy: false });
    if (id) await api.removeContainer(id);
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], personalDeviceKeys: {}, settingsCopyPending: false });
    resetPinGuard?.();
    changed();
  };
  try {
    process.env.KVPWSAFE_TEST_ONEDRIVE = dir;
    process.env.KVPWSAFE_TEST_REMOTE = dir; // the personal vault in it counts as on a network drive
    delete process.env.KVPWSAFE_TEST_HELLO;
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], personalDeviceKeys: {}, settingsCopy: null, settingsCopyPlainGone: '' });
    const pin = await ensurePin();
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    await api.setupMasterPassword({ password: MP, pin });
    await api.createPersonal({ folder: dir, password: MP });
    const id = await personalId();
    if (!id) return fail('no personal vault in the test folder');
    config.update({ personalRecoveryPending: {} });

    // The plain copy of before is there; switching the copy on replaces it with the encrypted one, once with the notice.
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, buildSettingsFile({ theme: 'light' }, { device: 'Altes-Notebook' }));
    config.update({ settingsCopy: true, settingsCopyPending: false, setupOffered: true, theme: 'dark' });
    if (!(await until(async () => !!(await head()), 8000))) return fail(`the plain copy was not replaced by the encrypted one (${(await read()).slice(0, 60)})`);
    const h1 = await head();
    if (h1.vault !== id || h1.kv !== 1 || h1.device !== 'Demo-PC') fail(`head of the copy: ${JSON.stringify({ vault: h1.vault === id, kv: h1.kv, device: h1.device })}`);
    const text = await read();
    const leaked = SECRET.filter((s) => text.includes(s));
    if (leaked.length) fail(`the OneDrive copy contains ${leaked.join(', ')}`);
    if (!config.get().settingsCopyPlainGone) fail('replacing the plain copy was not noted');
    if (!(await until(() => js('/OneDrive-Versionsverlauf/.test(document.getElementById("toast")?.textContent || "")'), 4000))) fail('no notice that the plain copy may still be in the OneDrive history');
    // An older app on another device writes the plain copy again: replaced each time (the notice only once per device).
    const noted = config.get().settingsCopyPlainGone;
    await writeFile(copy, buildSettingsFile({ theme: 'light' }, { device: 'Alte-App' }));
    config.update({ autoLockMinutes: config.get().autoLockMinutes === 7 ? 8 : 7 });
    if (!(await until(async () => !!(await head()), 8000))) fail('a plain copy written again was not replaced');
    if (!(await until(() => config.get().settingsCopyPlainGone !== noted, 3000))) fail('replacing the plain copy again was not noted');

    // A key change of the personal vault (= new master password): the copy is written anew under the new generation.
    await api.confirmMasterPassword({ password: MP }, 'personal-keyring');
    await api.updateProtection(id, { type: 'rekey', password: MP2 });
    if (!(await until(async () => (await head())?.kv === 2, 8000))) fail(`no new copy after the key change (kv ${(await head())?.kv})`);
    const good = await read();

    // New device: the offer names device and date; a wrong master password takes nothing over.
    await asNewDevice();
    const status = await api.oneDriveSetupStatus();
    if (!status.found || status.device !== 'Demo-PC') fail(`new device: configuration not found (${JSON.stringify(status)})`);
    if (!(await rejects(api.adoptOneDriveSetup({ password: 'Falsches-Passwort-1' })))) fail('a wrong master password was accepted');
    if (config.get().unlockKeys || config.get().personalVaults.length || (await personalId())) fail('a wrong master password set something up');
    if (!(await rejects(api.adoptOneDriveSetup({ password: MP })))) fail('the master password from before the key change was accepted');
    resetPinGuard?.();

    // A changed head (other device name): the master password sets up the vault, the configuration is refused.
    const data = JSON.parse(good);
    await writeFile(copy, JSON.stringify({ ...data, head: data.head.replace('Demo-PC', 'Fremd-PC') }));
    const tampered = await api.adoptOneDriveSetup({ password: MP2 }).catch((e) => ({ thrown: e.message }));
    if (tampered.thrown) fail(`changed head: ${tampered.thrown}`);
    else {
      if (tampered.preview) fail('a changed configuration was offered for import');
      if (!/verändert/.test(tampered.error || '')) fail(`a changed configuration gave no message (${tampered.error})`);
    }
    await asNewDevice();

    // The plain copy of before is not offered on a new device and not taken by itself.
    await writeFile(copy, buildSettingsFile({ theme: 'light' }, { device: 'Altes-Notebook' }));
    const plain = await api.oneDriveSetupStatus();
    if (plain.found || !plain.plain) fail(`the plain copy counts as configuration (${JSON.stringify(plain)})`);
    if (!(await rejects(api.adoptOneDriveSetup({ password: MP2 })))) fail('the plain copy was taken over');
    await asNewDevice();

    // Through the window: offer → master password → import preview → Hello/PIN question.
    await writeFile(copy, good);
    config.update({ theme: 'light', setupOffered: false });
    await js('window.kvSmokeAccountStep = true; window.kvSmokeWizards = true; document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".shell")?.remove(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    if (!(await until(async () => (await count(ACCOUNT)) > 0, 5000))) return fail('the first-start wizard did not open');
    await js(`document.querySelector(${JSON.stringify(`${ACCOUNT} .wizard-buttons .btn.primary`)})?.click(); true`);
    if (!(await until(async () => (await count(`${ACCOUNT} .first-od-found`)) > 0, 6000))) return fail('the new device does not offer the configuration in OneDrive');
    if (!(await js(`/Keevault-Konfiguration in OneDrive gefunden \\(von Demo-PC/.test(document.querySelector(${JSON.stringify(`${ACCOUNT} .first-od-found`)})?.textContent || "")`))) fail('the offer does not name the device');
    if (!(await count(`${ACCOUNT} .first-od-fresh`))) fail('no way to set up new instead');
    await js(`(() => { const i = document.querySelector(${JSON.stringify(`${ACCOUNT} .first-od-mp`)}); i.value = ${JSON.stringify(MP2)}; return true; })()`);
    await js(`document.querySelector(${JSON.stringify(`${ACCOUNT} .first-od-take`)})?.click(); true`);
    if (!(await until(() => js('!!document.querySelector("dialog[open].settings-import-modal")'), 10000))) return fail(`no import preview after the master password (${await js('document.getElementById("toast")?.textContent || ""')})`);
    await js('document.querySelector("dialog[open].settings-import-modal .modal-footer .btn.primary")?.click(); true');
    if (!(await until(() => config.get().theme === 'dark', 5000))) fail('the configuration was not taken over');
    if (!config.get().unlockKeys?.blob) fail('the master password was not set up on the new device');
    if (!config.get().personalVaults.includes(personalFile)) fail('the personal vault was not set up on the new device');
    const opened = (await api.state()).containers.find((c) => c.path === personalFile);
    if (!opened || opened.locked) fail('the personal vault is not open after taking over');
    if (!(await until(async () => (await count(`${ACCOUNT} .first-pin, ${ACCOUNT} .first-hello-on`)) > 0, 6000))) fail('no "Windows Hello aktivieren?" / app PIN step after taking over');
  } catch (e) {
    fail(e.message);
  } finally {
    await js('window.kvSmokeAccountStep = false; window.kvSmokeWizards = false; true');
    for (let i = 0; i < 4; i++) {
      await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
      await sleep(300);
    }
    const id = await personalId().catch(() => null);
    if (id) await api.removeContainer(id).catch(() => {});
    for (const [k, v] of [['KVPWSAFE_TEST_ONEDRIVE', env.od], ['KVPWSAFE_TEST_REMOTE', env.remote], ['KVPWSAFE_TEST_HELLO', env.hello]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    config.update(before);
    resetPinGuard?.();
    changed();
    await sleep(500);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return undefined;
}
