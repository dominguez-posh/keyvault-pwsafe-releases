// Smoke test of the whole app (CI and development): npm run smoke. Never runs in a normal start.

import { app, powerMonitor, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { hashPin } from '../pin.js';
import { pinLengthCheck } from '../smoke-pin-length.js';
import { featureChecks } from '../smoke-features.js';
import { smokeRelease } from './api/release.js';
import { areaSelection } from '../smoke-areas.js';
import { plantedOrgFileTaken } from '../org-file.js';
import { downgradeCheck, fileSwapCheck, foreignKeyCheck, rejectedCheck, removeRaceCheck, rollbackCheck } from '../smoke-file-swap.js';
import { acceptOlderCheck } from '../smoke-accept-older.js';
import { t } from '../../extension/core/i18n.js';
import { appRoot, demo, missingFiles, screenshot, smokeGuard } from './boot.js';
import { config, files, mcp, opened, updater, vault, win, windows } from './state.js';
import { hintContent, hintsShown } from './hint-window.js';
import { askInApp, chooseAgentMicrosoft, questions, confirmAgentPasskey, confirmAgentRead, confirmAgentWrite, nativeQuestion, trustAgentEntry, waitForUnlock } from './agents.js';
import { api, WINDOW_LOCKED_API } from './api/index.js';
import { browserHandlers, confirmBrowserMove, noteExtension, simulateExtensionClients } from './browser.js';
import { simulateExtensionPolicy, simulateExtensionReinstall } from './extension-reinstall.js';
import { copyViaHelperExe } from './clipboard.js';
import { pinGuard } from './guards.js';
import { createPersonal, refreshFileLocations, usePersonal } from './personal.js';
import { changed, emptyPagesHint, lockIfWindowsLocked, lockNow, send, vaultListRun } from './session.js';
import { syncSettings } from './settings-sync.js';
import { adminCenterUrl, lastAdminUrl, setSignInJobs, signInFor, signInJobs } from './signin.js';
import { autoTypeCalls, globalAutoType, runHelperExe, typeViaHelperExe } from './typing.js';
import { startInNormalMode } from './window.js';
import { screenshotProblem, windowViolations } from './smoke-windows.js';
import { windowLockCheck } from './smoke-window-lock.js';
import { windowHelloCheck } from './smoke-window-hello.js';
import { LOCKED_AT_START, watchSmokeSession } from '../smoke-session.js';

async function virtualAuthenticator(contents) {
  const dbg = contents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
  contents.kvAuthenticator = (await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', { // id for checks that set a credential aside (#526)
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  })).authenticatorId;
}

export function runSmokeTest() {
  const errors = [];
  smokeGuard.collect(() => [...errors, ...missingFiles.map((f) => `missing file: ${f}`), ...windowViolations]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message + ' @' + e.sourceId + ':' + e.lineNumber);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed: ${code} ${desc}`));
  // The passkey window gets a virtual authenticator (with PRF); every ceremony is started automatically.
  app.on('browser-window-created', (_e, w) => {
    let attached = false;
    w.webContents.on('did-finish-load', async () => {
      if (!w.webContents.getURL().startsWith('http://localhost/')) return;
      try {
        if (!attached) {
          attached = true;
          await virtualAuthenticator(w.webContents);
          if (process.env.KVPWSAFE_SMOKE_DEBUG) {
            console.log('[smoke] virtual authenticator attached');
            w.webContents.on('console-message', (e) => console.log(`[passkey window] ${e.message}`));
          }
        }
        if (process.env.KVPWSAFE_SMOKE_DEBUG) {
          await w.webContents.executeJavaScript(`for (const m of ['create', 'get']) {
            const orig = navigator.credentials[m].bind(navigator.credentials);
            navigator.credentials[m] = (o) => { console.warn('[page] ' + m + ' called'); return orig(o).then((r) => { console.warn('[page] ' + m + ' ok ' + JSON.stringify(r.getClientExtensionResults())); return r; }, (e) => { console.warn('[page] ' + m + ' failed ' + e.name + ' ' + e.message); throw e; }); };
          }; true`);
        }
        // The page fetches its request asynchronously; wait for the start button.
        await w.webContents.executeJavaScript(`new Promise((resolve) => {
          const timer = setInterval(() => {
            const b = document.querySelector('.actions .btn.primary');
            if (b) { clearInterval(timer); b.click(); resolve(true); }
          }, 100);
          setTimeout(() => { clearInterval(timer); resolve(false); }, 8000);
        })`).then((clicked) => {
          if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] passkey start clicked: ${clicked}`);
        });
      } catch (e) {
        errors.push(`passkey window: ${e.message}`);
      }
    });
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error') errors.push(`passkey window: ${e.message}`);
    });
  });
  win.webContents.once('did-finish-load', () => setTimeout(() => smokeGuard.run(async () => {
    smokeGuard.note('checks');
    // Locked Windows session: no clipboard for anyone (#526) – stop with the cause instead of 15 minutes of timeouts.
    if (watchSmokeSession({ monitor: powerMonitor, blocker: powerSaveBlocker, errors, stage: smokeGuard.stage }).lockedAtStart) throw new Error(LOCKED_AT_START);
    // --only (#397): the areas that are left out, full run: all of them.
    const areas = areaSelection();
    if (areas.partial && !demo) errors.push('--only needs --demo');
    const js = (code) => win.webContents.executeJavaScript(code).catch((e) => errors.push(String(e)));
    const ready = await js('document.body.dataset.ready || ""');
    if (ready !== '1') errors.push('renderer did not signal ready');
    if (demo) {
      // Key Vault demo containers.
      await js('document.querySelector(".card .btn.primary")?.click()');
      await sleep(1200);
      await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team"))?.click()');
      await sleep(600);
      await js('document.querySelector(".row-item")?.click()');
      await sleep(900);
      if (!(await js('document.querySelectorAll(".row-item").length') > 0)) errors.push('demo: no items rendered');
      // Shortcuts through Chromium's real input path (not synthetic DOM events).
      if (areas.runs('shortcuts')) {
        await js('document.querySelector(".row-item:not(.folder-row)")?.click(); window.__keys = []; document.addEventListener("keydown", (e) => window.__keys.push([e.key, e.code, e.ctrlKey, e.shiftKey].join("/")), true)');
        await sleep(400);
        win.focus();
        for (const keyCode of ['U', 'P']) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] });
          await sleep(500);
        }
        const selected = await js('document.querySelector(".row-item.active") ? "yes" : "no"');
        if (selected === 'yes') {
          await globalAutoType('o').catch(() => {});
          await globalAutoType('u');
          if (!autoTypeCalls.includes('global:u')) errors.push('global auto-type: no call');
          autoTypeCalls.splice(autoTypeCalls.indexOf('global:u'), 1);
        }
        if (autoTypeCalls.join() !== 'u,p') {
          errors.push(`auto-type shortcuts: ${autoTypeCalls.join() || 'no call'} (keys seen: ${await js('JSON.stringify(window.__keys)')}, selected: ${await js('document.querySelector(".row-item.active") ? "yes" : "no"')})`);
        }
      }
      // File container protected by a passkey (virtual authenticator) and a master password.
      const file = path.join(app.getPath('userData'), 'demo.kvpws');
      if (areas.runs('protection')) try {
        const created = await api.createFile({ path: file, name: 'Demo-Datei', password: 'demo-passwort', passkeyLabel: 'Smoke' });
        if (!/^RK-/.test(created.recoveryKey)) errors.push('file: no recovery key');
        await api.save(created.id, { title: 'Datei-Eintrag', username: 'u', password: 'p', urls: ['https://example.com'] });
        // Big import into a file vault (#326/#327): all entries arrive (a reload in between lost them before), the fourth
        // level goes into the third one's name, empty source folders are created, the expiry comes along.
        const many = Array.from({ length: 260 }, (_, i) => ({ type: 'login', title: `Import ${i}`, username: `u${i}`, password: 'x', folder: i % 2 ? 'PWDS/Privat/Handy/Alt' : 'PWDS/Cedric', expires: i === 0 ? '2023-05-01' : '' }));
        // Personal for the moment (no entry limit without a license) – the import itself is what is checked here.
        const personalBefore = config.get().personalVaults;
        config.update({ personalVaults: [...(personalBefore || []), file] });
        const reload = setInterval(() => files.serial(created.id, () => files.get(created.id).load()).catch(() => {}), 50);
        const imp = await api.importItems(created.id, many, { folders: ['PWDS/Leer'] }).finally(() => {
          clearInterval(reload);
          config.update({ personalVaults: personalBefore });
        });
        const fileList = await files.summaries(created.id);
        if (imp.imported !== 260 || imp.errors.length || fileList.length !== 261) errors.push(`file import: ${imp.imported} imported, ${fileList.length} in the file, ${imp.errors.slice(0, 2).join('; ')}`);
        if (!fileList.some((x) => x.folder === 'PWDS/Privat/Handy – Alt')) errors.push('file import: fourth folder level not kept in the name');
        if (!files.folders(created.id).includes('PWDS/Leer')) errors.push('file import: empty source folder not created');
        if (fileList.find((x) => x.title === 'Import 0')?.expires !== '2023-05-01') errors.push('file import: expiry not kept');
        await api.lockContainer(created.id);
        await api.unlockContainerPasskey(created.id);
        if ((await files.summaries(created.id)).length !== 261) errors.push('file: entries missing after passkey unlock');
        await api.lockContainer(created.id);
        await api.unlockContainer(created.id, { password: 'demo-passwort' }); await (await import('../smoke-password.js')).passwordCheck({ api, files, errors, id: created.id });
        const kvId = (await vault.containers()).find((c) => c.kind === 'keyvault')?.id; const { KV_PROTECTION_PASSWORD: kvPassword } = await import('../smoke-second-vault.js'); // stays locked; the move checks open it
        const r = await api.enableProtection(kvId, { password: kvPassword });
        if (!r.recoveryKey || r.failed.length) errors.push(`kv protection: ${r.failed.join(', ')}`);
        await api.lockContainer(kvId);
        await api.unlockContainerPasskey(kvId).then(() => errors.push('kv: unexpected passkey unlock'), () => {});
        await api.unlockContainer(kvId, { password: kvPassword });
        await api.lockContainer(kvId);
      } catch (e) {
        errors.push(`protection flow: ${e.message}`);
      }
      // Browser extension through the desktop app: every container (Key Vault too), entries readable.
      if (areas.runs('bridge')) try {
        const hello = await browserHandlers.hello();
        if (!hello.opened || !hello.containers.some((c) => c.source === 'keyvault')) errors.push('bridge: key vault containers missing');
        const list = await browserHandlers.summaries();
        const kvEntry = list.find((s) => hello.containers.some((c) => c.id === s.containerId && c.source === 'keyvault'));
        if (!kvEntry) errors.push('bridge: no key vault entries');
        else if (!(await browserHandlers.item({ containerId: kvEntry.containerId, itemId: kvEntry.id })).title) errors.push('bridge: item not readable');
      } catch (e) {
        errors.push(`bridge flow: ${e.message}`);
      }
      // Vault settings: a non-admin may only use what an admin enabled; folders at most three levels.
      if (areas.runs('vaultsettings')) try {
        const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        const stored = await vault.store.get('containers');
        const entry = stored.find((c) => c.id === kvc.id);
        const asAdmin = entry.access;
        const setAdmin = async (admin) => {
          entry.access = { ...asAdmin, admin };
          await vault.store.set('containers', stored);
        };
        await setAdmin(false);
        const blocked = await api.renameContainer(kvc.id, 'Nicht erlaubt').then(() => false, (e) => /nicht freigeschaltet|not enabled/.test(e.message));
        if (!blocked) errors.push('vault settings: rename not blocked for non-admin');
        if (await api.setPolicy(kvc.id, { rename: true }).then(() => true, () => false)) errors.push('vault settings: non-admin could change the settings');
        await setAdmin(true);
        await api.setPolicy(kvc.id, { rename: true });
        await setAdmin(false);
        await api.renameContainer(kvc.id, kvc.name);
        if (await api.addFolder(kvc.id, 'Gesperrt').then(() => true, () => false)) errors.push('vault settings: folders not blocked for non-admin');
        await setAdmin(true);
        await api.setPolicy(kvc.id, {});
        if (await api.addFolder(kvc.id, 'A/B/C/D').then(() => true, () => false)) errors.push('folders: a fourth level was accepted');
      } catch (e) {
        errors.push(`vault settings: ${e.message}`);
      }
      // Licensing: request code per vault, free limit shown.
      if (areas.runs('license')) try {
        const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        const ls = await api.licenseState(kvc.id);
        if (!/^KVP-/.test(ls.code) || ls.limit !== 10 || ls.licensed) errors.push('license: unexpected state');
      } catch (e) {
        errors.push(`license flow: ${e.message}`);
      }
      // Rename: Key Vault container (locally if the vault tag cannot be written).
      if (areas.runs('rename')) try {
        const kv = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error);
        await api.renameContainer(kv.id, 'Team Umbenannt');
        if ((await vault.container(kv.id)).name !== 'Team Umbenannt') errors.push('rename: key vault name unchanged');
        // Back to the original name: screenshots and the views after this show the demo as it is.
        await api.renameContainer(kv.id, kv.name);
      } catch (e) {
        errors.push(`rename flow: ${e.message}`);
      }
      // App PIN: unlocking needs it once set; wrong PIN is refused.
      if (areas.runs('pin')) try {
        await api.setPin({ next: '258013' });
        await lockNow();
        await api.unlock({ entra: true }).then(() => errors.push('pin: unlock without PIN'), () => {});
        await api.verifyPin('0000').then(() => errors.push('pin: wrong PIN accepted'), () => {});
        await api.verifyPin('258013');
        await api.unlock({ entra: true });
        if (!opened) errors.push('pin: unlock with PIN failed');
        if ((await api.state()).pinShort) errors.push('pin: a 6-character PIN marked as short');
        await api.setPin({ current: '258013', next: null });
        await pinLengthCheck({ api, config, hashPin, lockNow, sleep, js, isOpened: () => opened, errors }); // #475
        if (config.get().appPin) errors.push('pin: not removed');
        await windowLockCheck({ js, sleep, errors }); // #507: unlocked through the extension, the window stays locked
        await windowHelloCheck({ js, sleep, errors }); // #512: Windows Hello (simulated) lifts the window lock besides the PIN
      } catch (e) {
        errors.push(`pin flow: ${e.message}`);
      }
      // Secured file (passkey only): admin creates, folders, change log, access request + approval.
      if (areas.runs('secured')) try {
        // #423: an organization file in a ProgramData folder that a user created (here: this unelevated run) is skipped.
        if (process.platform === 'win32' && await plantedOrgFileTaken(path.join(app.getPath('temp'), `kv-orgfile-${process.pid}`))) errors.push('orgfile: a user-made ProgramData file was taken (#423)');
        const secured = path.join(app.getPath('userData'), 'team.kvpws');
        // The demo profile is named after the process ID – a reused ID finds the file of an earlier run.
        await fs.rm(secured, { force: true });
        const { id } = await api.createSecureFile({ path: secured, name: 'Team-Datei', email: 'Alex@Contoso.com', attachment: 'cross-platform' });
        await api.addFolder(id, 'Kunden/Contoso');
        await api.save(id, { title: 'Contoso VPN', username: 'vpn', password: 'p1', folder: 'Kunden/Contoso' });
        await api.lockContainer(id);
        const unlocked = await api.unlockContainerPasskey(id);
        if (unlocked.pending || unlocked.role !== 'admin') errors.push('secured: admin unlock failed');
        if ((await files.summaries(id)).length !== 1) errors.push('secured: entry missing after unlock');
        if (!(await api.folders(id)).includes('Kunden/Contoso')) errors.push('secured: folder missing');
        // Logo and entry icon (1×1 PNG).
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        await api.setContainerLogo(id, png);
        if ((await api.containerLogo(id)) !== png) errors.push('secured: logo not stored');
        const first = (await files.summaries(id))[0];
        await api.save(id, { ...(await files.getItem(id, first.id)), icon: png });
        if ((await files.summaries(id))[0].icon !== png) errors.push('secured: entry icon missing in list');
        await api.fileMemberOp(id, { type: 'sharing', enabled: true });
        const req = await api.requestFileAccess(id, { email: 'sam@contoso.com', attachment: 'cross-platform' });
        const sam = (await api.fileMembers(id)).members.find((m) => m.email === 'sam@contoso.com');
        if (sam?.status !== 'pending' || sam.safetyCode !== req.safetyCode) errors.push('secured: request not pending');
        await api.fileMemberOp(id, { type: 'approve', memberId: sam.id, role: 'editor' });
        const log = await api.changelog(id);
        for (const action of ['file-create', 'folder-create', 'item-create', 'sharing-on', 'member-approve']) {
          if (!log.some((e) => e.action === action && e.trusted)) errors.push(`secured: log misses ${action}`);
        }
        if ((await fs.readFile(secured, 'utf8')).includes('Contoso')) errors.push('secured: plaintext in file');
        // Folders: rename moves entries and subfolders along; deleting a non-empty folder moves its content up.
        await api.renameFolder(id, 'Kunden', 'Partner');
        const movedItem = (await files.summaries(id)).find((s) => s.title === 'Contoso VPN');
        if (movedItem?.folder !== 'Partner/Contoso' || !(await api.folders(id)).includes('Partner/Contoso')) errors.push('folders: rename did not move entries/subfolders');
        await api.renameFolder(id, 'Partner', '');
        if ((await files.summaries(id)).find((s) => s.title === 'Contoso VPN')?.folder !== 'Contoso') errors.push('folders: delete did not move content up');
        await fileSwapCheck({ files, js, sleep, errors, dir: app.getPath('userData'), changed }); await downgradeCheck({ files, errors, file: secured, id }); await rollbackCheck({ files, errors, file: secured, id }); await rejectedCheck({ files, errors, file: secured, id }); await foreignKeyCheck({ files, errors, file: secured, id, js }); await removeRaceCheck({ errors, dir: app.getPath('userData') }); // #404, #430, #432, #433, #521, #523
        await acceptOlderCheck({ api, files, config, js, sleep, errors, changed, file: secured, id, lockedApi: WINDOW_LOCKED_API, pinGuard }); // #435, 0.9.33 review
      } catch (e) {
        errors.push(`secured flow: ${e.message}`);
      }
      // Windows passkey provider: simulated CTAP requests as the packaged provider would relay them.
      if (areas.runs('windows')) try {
        const { encode, decode } = await import('../../extension/core/cbor.js');
        const { sha256, utf8 } = await import('../../extension/core/util.js');
        const createReq = encode(new Map([
          [1, await sha256(utf8('{"type":"webauthn.create"}'))],
          [2, new Map([['id', 'example.com'], ['name', 'Example']])],
          [3, new Map([['id', new Uint8Array([7, 7, 7])], ['name', 'win@example.com']])],
          [4, [new Map([['alg', -7], ['type', 'public-key']])]],
        ]));
        // A login with the account's user name but another address is offered as save target (and comes first).
        const sameUserTarget = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.locked);
        const sameUser = await vault.saveItem(sameUserTarget.id, { type: 'login', title: 'Konto ohne Adresse', username: 'WIN@example.com', password: 'x' });
        const created = windows.request('create', { request: Buffer.from(createReq).toString('base64'), transactionId: 'smoke-create' });
        await sleep(800);
        if (!(await js('!!document.querySelector("dialog[open] .unlock-head")'))) errors.push('windows: confirmation dialog missing');
        const offered = (await windows.list()).find((p) => p.id === 'smoke-create')?.logins || [];
        if (offered[0]?.id !== sameUser.id || !offered[0]?.sameUser) errors.push('windows: login with the same user name not offered first as save target');
        await vault.deleteItem(sameUserTarget.id, sameUser.id);
        const target = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.locked);
        await api.windowsDecision('smoke-create', { containerId: target.id, title: 'Windows-Test' });
        const made = decode(Buffer.from((await created).response, 'base64'));
        if (made.get(1) !== 'none' || made.get(2).length < 100) errors.push('windows: bad makeCredential response');
        const getReq = encode(new Map([[1, 'example.com'], [2, await sha256(utf8('{"type":"webauthn.get"}'))]]));
        const got = windows.request('get', { request: Buffer.from(getReq).toString('base64'), transactionId: 'smoke-get' });
        await sleep(500);
        const pending = await windows.list();
        const c = pending.find((p) => p.id === 'smoke-get')?.candidates[0];
        if (!c) errors.push('windows: passkey not offered');
        else {
          // #439: no PIN set → nothing is signed; with the PIN the request goes through (more in the feature checks).
          const pinBefore = config.get().appPin;
          if (!pinBefore && (await api.windowsDecision('smoke-get', c).then(() => 'signed', (e) => e.name)) !== 'PinNotSet') errors.push('windows: signed although no PIN is set');
          config.update({ appPin: await hashPin('246813'), pinGuard: null });
          pinGuard.restore(null);
          await api.windowsDecision('smoke-get', { ...c, pin: '246813' });
          config.update({ appPin: pinBefore });
          const assertion = decode(Buffer.from((await got).response, 'base64'));
          if (!assertion.get(3) || assertion.get(4).get('name') !== 'win@example.com') errors.push('windows: bad getAssertion response');
        }
        // Passkey saved in the wrong entry: move it to another login and back (target first, then source).
        try {
          const all = await vault.summaries();
          const src = all.find((x) => x.containerId === target.id && x.title === 'Windows-Test');
          const dst = await vault.saveItem(target.id, { type: 'login', title: 'Passkey-Ziel', username: '' });
          await api.movePasskey({ from: { containerId: target.id, id: src.id }, to: { containerId: target.id, id: dst.id }, credentialId: c?.credentialId });
          const [a, b] = await Promise.all([vault.getItem(target.id, src.id, { fresh: true }), vault.getItem(target.id, dst.id, { fresh: true })]);
          if (a.passkeys.length || b.passkeys.length !== 1 || b.username !== 'win@example.com') errors.push('movePasskey: not moved');
          await api.movePasskey({ from: { containerId: target.id, id: dst.id }, to: { containerId: target.id, id: src.id }, credentialId: c?.credentialId });
          await vault.deleteItem(target.id, dst.id);
        } catch (e) {
          errors.push(`movePasskey: ${e.message}`);
        }
        const view = process.argv.find((a) => a.startsWith('--view='))?.slice('--view='.length);
        if (view === 'windows') {
          windows.request('get', { request: Buffer.from(getReq).toString('base64'), transactionId: 'smoke-view' }).catch(() => {});
          await sleep(800);
        }
      } catch (e) {
        errors.push(`windows flow: ${e.message}`);
      }
      await js('window.dispatchEvent(new Event("kvpwsafe-refresh"))');
      await sleep(900);
      const view = process.argv.find((a) => a.startsWith('--view='))?.slice('--view='.length);
      if (view === 'edit') await js('document.querySelector(".detail-pane .btn.primary")?.click()');
      if (view === 'detail') await js('document.querySelector(".list-pane .row-item:not(.folder-row)")?.click()');
      if (view === 'newcard' || view === 'newcert') {
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js(`document.querySelector('.context-menu [data-action="${view === 'newcard' ? 'new-card' : 'new-certificate'}"]')?.click()`);
      }
      if (view === 'cardcert') {
        // Create a credit card and a certificate through the form, then check their detail views.
        const create = async (action, fill, expect) => {
          await js('document.querySelector(".top-actions .btn.primary")?.click()');
          await sleep(300);
          await js(`document.querySelector('.context-menu [data-action="${action}"]')?.click()`);
          await sleep(400);
          await js(fill);
          await sleep(300);
          await js('document.querySelector(".item-form")?.requestSubmit()');
          await sleep(1500);
          const text = await js('document.querySelector(".detail-pane")?.innerText || ""');
          for (const e of expect) if (!text.includes(e)) errors.push(`${action}: "${e}" missing in detail view`);
        };
        await create('new-card', `(() => { const f = document.querySelector(".item-form");
          f.title.value = "Firmen-Visa"; f.cardHolder.value = "Alex Demo"; f.cardNumber.value = "4111 1111 1111 1111";
          f.cardExpiry.value = "12/28"; f.cardCvc.value = "123"; f.cardPin.value = "9876"; return true; })()`, ['Kartennummer', '•••• •••• •••• 1111', 'Alex Demo', '12/28']);
        await create('new-certificate', `(() => { const f = document.querySelector(".item-form");
          f.title.value = "VPN-Zertifikat"; f.certPassword.value = "geheim";
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(2048).fill(7)], "vpn.pfx"));
          const input = f.querySelector('input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change'));
          return true; })()`, ['Zertifikat', 'vpn.pfx', '2 KB', 'Zertifikats-Passwort']);
      }
      // Resizable panes: two drag handles, widths applied as CSS variables.
      const panes = await js('(() => { const s = document.querySelector(".shell"); return JSON.stringify({ handles: document.querySelectorAll(".shell > .splitter").length, sidebar: s?.style.getPropertyValue("--sidebar-w"), list: s?.style.getPropertyValue("--list-w") }); })()');
      if (!/"handles":2,"sidebar":"\d+px","list":"\d+px"/.test(panes)) errors.push(`resizable panes: ${panes}`);
      if (view === 'small') {
        win.setSize(1000, 560);
        await sleep(300);
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(500);
        const r = await js('(() => { const p = document.querySelector(".detail-pane"); p.scrollTop = p.scrollHeight; const b = [...p.querySelectorAll("button")].find((x) => /Speichern|Save/.test(x.textContent)); const rb = b?.getBoundingClientRect(); return JSON.stringify({ scrolls: p.scrollHeight > p.clientHeight, visible: !!rb && rb.bottom <= window.innerHeight && rb.top >= 0, inner: window.innerHeight, shell: document.querySelector(".shell")?.getBoundingClientRect().height, pane: p.clientHeight, scrollH: p.scrollHeight, btn: !!b, btnBottom: rb?.bottom, editor: !!p.querySelector(".editor") }); })()');
        if (!/"visible":true/.test(r)) errors.push(`small window: save button not reachable ${r}`);
      }
      const menuAction = async (action) => {
        await js('document.querySelector(".sidebar .nav-row.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 }))');
        await sleep(200);
        await js(`document.querySelector('.context-menu [data-action="${action}"]')?.click()`);
      };
      if (view === 'share') await menuAction('share');
      if (view === 'menu') await js('document.querySelector(".sidebar .nav-row.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 }))');
      if (view === 'locked') await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.querySelector(".icon-lock"))?.click()');
      if (view === 'import') await menuAction('import');
      if (view === 'license') await menuAction('license');
      if (['members', 'changelog', 'folders'].includes(view)) {
        await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click()');
        await sleep(600);
        if (view === 'members') await menuAction('members');
        if (view === 'changelog') await menuAction('changelog');
      }
      if (view?.startsWith('settings')) await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=settings]")?.click()');
      // Settings tab: settings-mcp (AI agents) or settings-<n> (n-th tab, 0-based).
      if (view === 'settings-mcp' || /^settings-\d$/.test(view || '')) {
        await new Promise((r) => setTimeout(r, 600));
        const pick = view === 'settings-mcp' ? '[...tabs].find((x) => /KI-Agenten|AI agents/.test(x.textContent))' : `tabs[${view.slice(-1)}]`;
        const tab = await js(`(() => { const tabs = document.querySelectorAll(".modal .tabs button"); const b = ${pick}; if (b) b.click(); return b ? "clicked" : "no tab"; })()`);
        if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] ${view} tab: ${tab}`);
      }
      if (view === 'create') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('document.querySelectorAll("dialog[open] .option-card")[3]?.click()');
      }
      if (view === 'newfile') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('[...document.querySelectorAll("dialog[open] .option-card")].find((b) => /Datei-Tresor|file vault/i.test(b.textContent))?.click()');
      }
      if (view === 'backup') await menuAction('backup');
      if (view === 'vault-settings') await menuAction('vault-settings');
      if (view === 'restore') await menuAction('restore');
      // Success animation after a Windows passkey request (screenshot only).
      if (view === 'passkey-success') send({ type: 'passkeyFlash', text: t('Angemeldet') });
      // Update offer with the real changelog: everything since 0.7.12 (screenshot only).
      if (view === 'update-offer') {
        const { recentSections } = await import('../../scripts/release-notes.mjs');
        const notes = recentSections(await fs.readFile(path.join(appRoot, 'CHANGELOG.md'), 'utf8'), app.getVersion());
        send({ type: 'updateOffer', state: { kind: 'nsis', status: 'available', version: app.getVersion(), current: '0.7.12', notes } });
      }
      // Agent question in the app's style (screenshot only; answered with the cancel choice when the test ends).
      if (view === 'agent-read') confirmAgentRead({ agent: 'claude-code', title: 'Strato SFTP keevault.de', vault: 'kv-team' }).catch(() => {});
      if (view === 'agent-write') confirmAgentWrite({ agent: 'claude-code', action: 'update', title: 'GitHub', vault: 'kv-team', fields: Object.keys({ password: 1, notes: 1 }) }).catch(() => {});
      if (view === 'agent-connect') askInApp({ kind: 'agent-connect', agent: 'claude-code', title: t('„{agent}“ möchte sich verbinden', { agent: 'claude-code' }),
        lead: t('Ein KI-Agent möchte Keevault nutzen. Erlaube das nur für Agenten, die du selbst eingerichtet hast.'),
        choices: [{ value: 'write', label: t('Lesen und Schreiben'), hint: t('Suchen, Passwörter mit deiner Freigabe lesen, Einträge mit Bestätigung anlegen und ändern.') },
          { value: 'read', label: t('Nur lesen'), hint: t('Suchen und Passwörter mit deiner Freigabe lesen – keine Änderungen.') }],
        note: t('Löschen ist nie möglich. Rechte und Gültigkeit änderst du jederzeit in den Einstellungen.'), allow: t('Verbinden'), cancel: 'deny' }).catch(() => {});
      if (view === 'progress') {
        // Progress card bottom right as during a background reconcile (screenshot only).
        send({ type: 'progress', id: 'reconcile', label: t('Tresore werden abgeglichen …'), step: 'fast', detail: t('Schnell-Index wird geladen …') });
        await sleep(300);
        send({ type: 'progress', id: 'reconcile', step: 'list', detail: t('{vaults} Tresore · Seite {page}, {n} Secrets gefunden', { vaults: 3, page: 82, n: 1234 }),
          hint: emptyPagesHint(82, 28), done: 1234, total: 2000 });
        await js('document.querySelector(".progress-toast")?.classList.add("expanded")');
        // … and the spinning refresh icon of the vault being reconciled.
        send({ type: 'busy', containerId: (await vault.containers())[0]?.id, busy: true });
        await sleep(600);
      }
      if (view === 'health') await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=health]")?.click()');
      if (view === 'access') await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=access]")?.click()');
      // Main menu screenshot also shows the optional PIM button top right.
      if (view === 'mainmenu') await js('document.documentElement.classList.add("show-admin"); document.querySelector(".menu-btn")?.click()');
      if (view === 'mainmenu-view') await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-tab=view]")?.click()');
      if (view === 'devlinux' || view === 'devvmware') {
        // New device in the form: Linux asks for SSH port and SSH account, VMware for the vSphere client (screenshot).
        config.update({ adminTools: true });
        changed();
        await sleep(800);
        await js('document.querySelector(".new-split button:last-child")?.click()');
        await sleep(300);
        await js('document.querySelector("[data-action=new-server]")?.click()');
        await sleep(500);
        const kind = view === 'devlinux' ? 'linux' : 'vmware';
        await js(`(() => { const s = document.querySelector("select[name=srvKind]"); s.value = "${kind}"; s.dispatchEvent(new Event("change")); })()`);
        await sleep(300);
        const port = await js('document.querySelector("input[name=srvPort]")?.value');
        if (view === 'devlinux' && port !== '22') errors.push(`devlinux: SSH port ${port}`);
        await js('document.querySelector("select[name=srvKind]")?.scrollIntoView({ block: "start" })');
        await sleep(200);
      }
      if (view === 'linkpick') {
        // Device form: the linked RDP account is picked in a search window; typing filters, a click takes it.
        try {
          const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error && !c.locked);
          await vault.saveItem(kvc.id, { type: 'server', title: 'PICK01', server: { host: '10.0.0.9' } });
          const foreign = (await vault.summaries()).find((x) => x.containerId !== kvc.id && x.type === 'login');
          if (foreign && await api.save(kvc.id, { type: 'server', title: 'X', server: { host: 'x', rdpLink: foreign.key } }).then(() => true, () => false)) {
            errors.push('linkpick: link into another vault was saved');
          }
          config.update({ adminTools: true });
          changed();
          await sleep(800);
          await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
          await sleep(300);
          await js('document.querySelector(".mode-switch [data-mode=devices]")?.click()');
          await sleep(300);
          await js('[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.textContent.includes("PICK01"))?.click()');
          await sleep(500);
          await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
          await sleep(300);
          await js('document.querySelector(".context-menu [data-action=edit]")?.click()');
          await sleep(500);
          await js('document.querySelector(".link-pick[data-name=srvRdpLink]")?.click()');
          await sleep(300);
          await js('(() => { const q = document.querySelector("dialog[open] .link-pick-search"); q.value = "firewall"; q.dispatchEvent(new Event("input")); })()');
          await sleep(300);
          const hits = await js('document.querySelectorAll("dialog[open] .link-pick-row").length');
          if (hits !== 1) errors.push(`linkpick: search found ${hits} entries instead of 1`);
          await js('document.querySelector("dialog[open] .link-pick-row")?.click()');
          await sleep(300);
          const chosen = await js('document.querySelector(".link-pick[data-name=srvRdpLink] .link-pick-text")?.textContent || ""');
          if (!/firewall/i.test(chosen)) errors.push(`linkpick: choice not taken (${chosen})`);
          await js('document.querySelector(".link-pick[data-name=srvBastionLogin]")?.click()');
          await sleep(400);
        } catch (e) {
          errors.push(`linkpick: ${e.message}`);
        }
      }
      if (view === 'devnewmenu') {
        // Devices selected: title, sidebar and the New menu with devices only (screenshot).
        config.update({ adminTools: true });
        changed();
        await sleep(800);
        await js('document.querySelector(".sidebar .nav[data-view=all]")?.click()');
        await sleep(300);
        await js('document.querySelector(".mode-switch [data-mode=devices]")?.click()');
        await sleep(400);
        await js('document.querySelector(".new-split .new-more")?.click()');
        await sleep(300);
      }
      if (view === 'vaultsearch') {
        // Vault search opened in the sidebar header, one hit (screenshot).
        await js('document.querySelector(".vault-find .icon-btn")?.click(); const q = document.querySelector(".vault-find input"); q.value = "Team"; q.dispatchEvent(new Event("input"))');
        await sleep(400);
      }
      if (view === 'mainmenu-small') {
        // Small window: the main menu ends above the bottom edge and scrolls (screenshot only).
        win.setSize(900, 560);
        await sleep(400);
        await js('document.querySelector(".menu-btn")?.click()');
        await sleep(300);
        const fits = await js('(() => { const m = document.querySelector(".main-menu"); return !!m && m.getBoundingClientRect().bottom <= innerHeight && m.scrollHeight > m.clientHeight; })()');
        if (!fits) errors.push('mainmenu-small: menu cut off or not scrollable');
      }
      if (view === 'multi') {
        await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => /Alle Einträge|All entries|All items/.test(n.textContent))?.click()');
        await sleep(400);
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(200);
        await js('document.querySelectorAll(".list li.row-item[data-key]")[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))');
        await sleep(400);
        const r = await js('JSON.stringify({ multi: document.querySelectorAll(".list li.row-item.multi").length, pane: document.querySelector(".multi-selection h2")?.textContent || "" })');
        if (!/"multi":3/.test(r)) errors.push(`multi-select: expected 3 selected rows, got ${r}`);
      }
      if (view === 'expiry') {
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(400);
        await js('(() => { const d = document.querySelector(".editor input[name=expires]"); if (d) { d.value = "2026-11-10"; d.dispatchEvent(new Event("input", { bubbles: true })); } })()');
      }
      if (view === 'fields') {
        // New login with the additional-field menu open and two typed fields (screenshot only).
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(400);
        await js('(() => { const b = [...document.querySelectorAll(".editor button")].find((x) => /Feld hinzufügen|Add field/.test(x.textContent)); b?.click(); [...document.querySelectorAll(".field-menu button")].find((x) => /Wiederherstellungscodes|Recovery codes/.test(x.textContent))?.click(); b?.click(); [...document.querySelectorAll(".field-menu button")].find((x) => /Anhang|Attachment/.test(x.textContent))?.click(); b?.click(); document.querySelector(".custom-field")?.scrollIntoView(); })()');
      }
      if (view === 'detail') {
        // First entry opened in the detail pane (screenshot only).
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(500);
      }
      if (view === 'help') await js('document.querySelector(".help-btn")?.click()');
      if (view === 'trash') {
        // Trash round trip: delete an entry, it shows up in the trash, restore brings it back (screenshot/smoke only).
        const c = (await vault.containers()).find((x) => /kv-pws-demo-team/.test(x.vaultUrl || ''));
        const entry = (await vault.index())[c.id].items.find((x) => x.title === 'Grafana');
        await api.delete(c.id, entry.id);
        const inTrash = (await api.trash(c.id)).some((x) => x.id === entry.id);
        if (!inTrash) errors.push('trash: deleted entry missing in the trash');
        await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => /Team Infrastruktur/.test(r.textContent)); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); document.querySelector(".context-menu [data-action=trash]")?.click(); })()`);
        await sleep(800);
        const shown = await js('document.querySelector("dialog[open]")?.textContent || ""');
        if (!/Grafana/.test(shown)) errors.push('trash: dialog does not list the entry');
        await api.restore(c.id, entry.id);
        if (!(await api.items()).some((x) => x.id === entry.id)) errors.push('trash: restore did not bring the entry back');
        await api.delete(c.id, entry.id);
        await js('(() => { document.querySelector("dialog[open] .modal-head button, dialog[open] button")?.click(); })()');
        await sleep(300);
        await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => /Team Infrastruktur/.test(r.textContent)); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); document.querySelector(".context-menu [data-action=trash]")?.click(); })()`);
        await sleep(800);
      }
      if (view === 'searchall') {
        // Search scope: "o" in the team vault finds only its entries, switched to "All" also the personal ones.
        const typeInto = (v) => js(`(() => { const s = document.getElementById("search"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await typeInto('o');
        await sleep(300);
        const vaultOnly = Number(await js('document.querySelectorAll(".list li.row-item[data-key]").length'));
        await js('document.querySelector(".search-scope button:last-child")?.click()');
        await sleep(300);
        await typeInto('o');
        await sleep(300);
        const all = Number(await js('document.querySelectorAll(".list li.row-item[data-key]").length'));
        if (!(all > vaultOnly)) errors.push(`searchall: expected more hits in all vaults (${vaultOnly} vs ${all})`);
        // The lock and menu buttons in the top strip take clicks.
        await js('document.querySelector(".menu-btn")?.click()');
        await sleep(200);
        if (await js('String(!!document.querySelector(".main-menu"))') !== 'true') errors.push('searchall: menu button did not open the menu');
        const hit = await js('(() => { const b = document.querySelector(".brand .icon-btn"); const r = b.getBoundingClientRect(); return String(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".icon-btn") === b); })()');
        if (hit !== 'true') errors.push('searchall: lock button is covered');
        await js('document.querySelector(".main-menu")?.remove()');
      }
      if (view === 'itemlink') {
        // "Copy link" round trip: the web link of a team entry opens exactly that entry (screenshot/smoke only).
        const c = (await vault.containers()).find((x) => /kv-pws-demo-team/.test(x.vaultUrl || ''));
        const entry = c && (await vault.index())[c.id]?.items?.find((x) => x.title === 'Grafana');
        if (!entry) errors.push('itemlink: demo entry missing');
        else {
          send({ type: 'link', url: `https://keevault.de/open#v=${new URL(c.vaultUrl).host}&i=${entry.id}` });
          await sleep(900);
          const shown = await js('document.querySelector(".detail-pane .item-head h2")?.textContent || ""');
          if (!shown.includes('Grafana')) errors.push(`itemlink: expected Grafana in the detail pane, got "${shown}"`);
        }
      }
      if (view === 'newfolder') {
        // New entry, then a folder picked in the list: the form takes the folder over and keeps what was typed.
        await js('document.querySelector(".top-actions .btn.primary")?.click()');
        await sleep(300);
        await js('document.querySelector(".context-menu [data-action=new-login]")?.click()');
        await sleep(400);
        await js('(() => { const t = document.querySelector(".editor input[name=title]"); t.value = "Neuer Test"; t.dispatchEvent(new Event("input", { bubbles: true })); })()');
        await js('[...document.querySelectorAll(".list li")].find((r) => /Monitoring/.test(r.textContent))?.click()');
        await sleep(400);
        const r = await js('JSON.stringify({ folder: document.querySelector(".editor [name=folder]")?.value, title: document.querySelector(".editor input[name=title]")?.value })');
        if (!/"folder":"Monitoring"/.test(r) || !/"title":"Neuer Test"/.test(r)) errors.push(`newfolder: form did not take the folder over (${r})`);
      }
      if ((!view || view === 'personal') && areas.runs('personal')) {
        // The personal vault end to end (every smoke run): local folders refused, create (master password + PIN), free,
        // named "Persönlich" in the app's language, PIN unlock after lock, not shareable, nothing moved in from a
        // shared vault, folders inside it, and only one personal vault (no second one, created or added).
        try {
          const dir = path.join(app.getPath('temp'), `kv-personal-${process.pid}`);
          await fs.rm(dir, { recursive: true, force: true });
          await fs.mkdir(dir, { recursive: true });
          process.env.KVPWSAFE_TEST_REMOTE = dir;
          config.update({ appPin: await hashPin('246813'), pinGuard: null, personalVaults: [], personalDeviceKeys: {} });
          pinGuard.restore(null);
          const local = path.join(app.getPath('temp'), `kv-local-${process.pid}`);
          await fs.mkdir(local, { recursive: true });
          if (await createPersonal({ folder: local, password: 'Persoenlich-Test-123!', pin: '246813' }).then(() => true, () => false)) errors.push('personal: local folder accepted');
          const r = await createPersonal({ folder: dir, password: 'Persoenlich-Test-123!', pin: '246813' });
          if (!r.recoveryKey) errors.push('personal: no recovery key');
          if (!config.get().personalRecoveryPending?.[r.id]) errors.push('personal: recovery key counts as confirmed right after creating');
          await api.confirmPersonalRecovery(r.id);
          const c = await vault.container(r.id);
          if (!c.personal) errors.push('personal: container not marked personal');
          if (!(await vault.licenseState(r.id)).licensed) errors.push('personal: not free');
          await vault.saveItem(r.id, { title: 'Privat', username: 'me', password: 'x' });
          files.get(r.id).lock();
          if (!Object.keys(config.get().personalDeviceKeys || {}).length) errors.push('personal: key not bound to the device');
          await api.verifyPin('246813');
          if (files.get(r.id).locked) errors.push('personal: PIN did not unlock the vault');
          if (await files.updateKeyring(r.id, { type: 'createInvite' }, 'x').then(() => true, () => false)) errors.push('personal: invitation was allowed');
          const pwEntry = files.get(r.id).keyring?.entries?.find((e) => e.type === 'password');
          if (pwEntry && await files.updateKeyring(r.id, { type: 'removeEntry', entryId: pwEntry.id }, 'x').then(() => true, () => false)) errors.push('personal: master password could be removed');
          const shared = (await vault.containers()).find((x) => x.kind === 'keyvault' && !x.error && !x.locked); if (!shared) errors.push('personal: no open shared vault for the move checks'); // #526: not the one the protection flow locked
          const sharedItem = shared && (await vault.index())[shared.id]?.items?.[0];
          if (sharedItem && await vault.moveItem(shared.id, r.id, sharedItem.id).then(() => true, () => false)) errors.push('personal: entry moved in from a shared vault');
          // #519: nor a passkey (its private key) through the window API's movePasskey.
          const pkOwn = await vault.saveItem(r.id, { type: 'login', title: 'Passkey-Ziel-519', username: '' });
          const pkShared = shared && await vault.saveItem(shared.id, { type: 'login', title: 'Passkey-519', username: 'u', passkeys: [{ credentialId: 'smoke-519', rpId: 'example.com', privateKey: 'x', userName: 'u' }] }).catch((e) => void errors.push(`personal: #519 setup ${e.message}`));
          if (pkShared && await api.movePasskey({ from: { containerId: shared.id, id: pkShared.id }, to: { containerId: r.id, id: pkOwn.id }, credentialId: 'smoke-519' }).then(() => true, () => false)) errors.push('personal: passkey moved in from a shared vault (#519)');
          await Promise.all([pkShared && vault.deleteItem(shared.id, pkShared.id), vault.deleteItem(r.id, pkOwn.id)]);
          if (c.name !== t('Persönlich')) errors.push(`personal: named "${c.name}" instead of "${t('Persönlich')}"`);
          // More structure through folders inside it.
          await vault.saveItem(r.id, { title: 'Steuer', username: 'me', password: 'x', folder: 'Geschäft' });
          if (!(await vault.summaries()).some((x) => x.containerId === r.id && x.folder === 'Geschäft')) errors.push('personal: entry in a folder not saved');
          // #470: export of the personal vault – file holds the entries, locked refused, menu entry with the same warning.
          {
            const exportFile = process.env.KVPWSAFE_TEST_EXPORT = path.join(dir, 'export-470.csv');
            const exp = await api.exportItems(r.id, await api.confirmExportPin(r.id, '246813')).catch((e) => ({ error: e.message })).finally(() => delete process.env.KVPWSAFE_TEST_EXPORT);
            const csv = await fs.readFile(exportFile, 'utf8').catch(() => '');
            if (exp?.count !== 2 || !csv.includes('Steuer') || !csv.includes('Privat') || !csv.includes('Geschäft')) errors.push(`personal export: file lacks the entries (${exp?.error || exp?.count})`);
            files.get(r.id).lock();
            if (await api.exportItems(r.id, await api.confirmExportPin(r.id, '246813')).then(() => true, () => false)) errors.push('personal export: locked vault exported');
            await api.verifyPin('246813');
            changed(); await sleep(1500);
            // #473: menu entry, warning, app PIN (missing, wrong, reused refused; the right one exports) – ../smoke-export-pin.js
            await (await import('../smoke-export-pin.js')).exportPinCheck({ api, js, sleep, errors, id: r.id, dir });
          }
          // Only one personal vault: a second one is refused, created or added.
          if (await createPersonal({ folder: dir, password: 'Zweiter-Test-123!', pin: '246813' }).then(() => true, () => false)) errors.push('personal: a second personal vault was created');
          if (await usePersonal({ folder: local }).then(() => true, () => false)) errors.push('personal: a second personal vault was added');
          // #400: the same vault again (wizard retry after a wrong master password) is no second one; the right password unlocks.
          files.get(r.id).lock();
          const again = await usePersonal({ folder: dir }).catch((e) => ({ error: e.message }));
          if (again.id !== r.id) errors.push(`personal: using the listed vault again refused (${again.error || again.id})`);
          if (await api.unlockContainer(r.id, { password: 'Falsch-Test-123!' }).then(() => true, () => false)) errors.push('personal: wrong master password unlocked');
          if (await api.unlockContainer(r.id, { password: 'Persoenlich-Test-123!' }).then(() => false, () => true)) errors.push('personal: right master password after a wrong one did not unlock');
          if (config.get().personalVaults.length !== 1) errors.push(`personal: ${config.get().personalVaults.length} personal vaults listed`);
          // Settings travel in the personal vault: a change here is written there, a newer state there (another device)
          // is taken over here; the PIN and device keys never go along; switched off, nothing moves.
          const clip = config.get().clipboardSeconds;
          config.update({ clipboardSeconds: 37 });
          if (await syncSettings() !== 'pushed' || (await files.appSettings(r.id))?.value?.clipboardSeconds !== 37) errors.push('settings sync: change not written to the personal vault');
          const stored = (await files.appSettings(r.id)).value;
          if ('appPin' in stored || 'personalDeviceKeys' in stored || 'mcpEnabled' in stored) errors.push('settings sync: device-bound settings in the personal vault');
          await files.setAppSettings(r.id, { ...stored, clipboardSeconds: 41 }, Date.now() + 1000);
          if (await syncSettings() !== 'pulled' || config.get().clipboardSeconds !== 41) errors.push(`settings sync: newer settings not taken over (${config.get().clipboardSeconds})`);
          config.update({ settingsSync: false });
          config.update({ clipboardSeconds: 43 });
          if (await syncSettings() !== null || (await files.appSettings(r.id)).value.clipboardSeconds !== 41) errors.push('settings sync: written although switched off');
          config.update({ settingsSync: true, clipboardSeconds: clip });
          await syncSettings();
          changed();
          let shown = 0;
          for (let i = 0; i < 10 && shown !== 1; i++) { await sleep(300); shown = await js('document.querySelectorAll(".personal-slot .nav-label").length'); }
          if (shown !== 1) errors.push(`personal: sidebar shows ${shown} personal vaults`);
          // "Protection and users" of the personal vault: no "Invite user" button.
          await js('(() => { const row = document.querySelector(".personal-slot .nav-row"); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 200 })); document.querySelector(".context-menu [data-action=protection]")?.click(); })()');
          let dialogText = '';
          for (let i = 0; i < 10 && !dialogText; i++) { await sleep(300); dialogText = await js('document.querySelector("dialog[open]")?.textContent || ""'); }
          if (!dialogText) errors.push('personal: protection dialog did not open');
          else if (/Benutzer einladen|Invite user/.test(dialogText)) errors.push('personal: protection dialog offers "Invite user"');
          else if (/Masterpasswort entfernen|Remove master password/.test(dialogText)) errors.push('personal: protection dialog offers "Remove master password"');
          // "Change master password" shows how strong the new one is while typing (#22): weak red, strong green.
          await js('[...document.querySelectorAll("dialog[open] button")].find((b) => /Masterpasswort ändern|Change master password/.test(b.textContent))?.click()');
          await sleep(400);
          const meterFor = (pw) => js(`(() => { const d = [...document.querySelectorAll("dialog[open]")].at(-1); const i = d?.querySelector("input[type=password]"); const m = d?.querySelector(".strength");
            if (!i || !m) return "missing"; i.value = ${JSON.stringify(pw)}; i.dispatchEvent(new Event("input")); return m.dataset.level + "|" + getComputedStyle(m.querySelector("span"), "::after").backgroundColor; })()`);
          const weak = String(await meterFor('abc'));
          const strong = String(await meterFor('Kv!9xQ#2mLp$7wZr&4tB'));
          if (weak === 'missing' || !/^[01]\|/.test(weak) || !/^[34]\|/.test(strong) || weak.split('|')[1] === strong.split('|')[1]) errors.push(`personal: no strength bar when changing the master password (${weak} / ${strong})`);
          await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click())');
          // OneDrive quit (#15): the personal vault's folder stands in for OneDrive; first running, then stopped – a
          // message, a red mark and a notice above the vault's list.
          Object.assign(process.env, { KVPWSAFE_TEST_PROVIDER: 'OneDrive', KVPWSAFE_TEST_SYNC_CLIENT: 'running' });
          await refreshFileLocations();
          changed();
          await sleep(500);
          await js('document.querySelector(".personal-slot .nav")?.click()');
          await sleep(600);
          const syncView = () => js('JSON.stringify({ problem: !!document.querySelector(".personal-slot .source-badge.problem"), notice: document.querySelector(".list-pane .notice.warn")?.textContent || "", toast: document.getElementById("toast")?.classList.contains("show") ? document.getElementById("toast").textContent : "" })');
          let sv = JSON.parse(await syncView());
          if (sv.problem || /läuft nicht/.test(sv.notice)) errors.push(`sync: warning while OneDrive runs (${JSON.stringify(sv)})`);
          process.env.KVPWSAFE_TEST_SYNC_CLIENT = 'stopped';
          await refreshFileLocations();
          changed();
          for (let i = 0; i < 10 && !(sv = JSON.parse(await syncView())).notice; i++) await sleep(300);
          if (!sv.problem || !/OneDrive läuft nicht/.test(sv.notice) || !/OneDrive läuft nicht/.test(sv.toast)) errors.push(`sync: no warning after OneDrive stopped (${JSON.stringify(sv)})`);
          delete process.env.KVPWSAFE_TEST_PROVIDER;
          delete process.env.KVPWSAFE_TEST_SYNC_CLIENT;
          await refreshFileLocations();
          changed();
        } catch (e) {
          errors.push(`personal: ${e.message}`);
        }
      }
      if (view === 'topmenu') {
        // Variant "actions at the top": quiet ⋯ beside the title, menu open (screenshot only).
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(500);
        await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
        await sleep(400);
      }
      if (view === 'listmenu') {
        // Right-click on the empty list area of a vault (screenshot only).
        // Screenshot size first: resizing the window closes context menus.
        win.setSize(1200, 780);
        await sleep(300);
        await js('(() => { const el = document.querySelector(".list-pane .list-scroll"); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 120 })); })()');
        await sleep(400);
      }
      if (view === 'admin' || view === 'serveritem' || view === 'serveredit') {
        // Admin tools: server entry with a linked account, one-click sign-in only for the host it was started for
        // (nothing is launched in smoke runs – see launchRdp/launchTeamViewer).
        try {
          const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error && !c.locked);
          const login = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.type === 'login');
          const saved = await vault.saveItem(kvc.id, { type: 'server', title: 'DC01', folder: '', server: { host: '10.0.0.4', rdpLink: login.key, tvId: '123456789', tvPassword: 'tv-secret', bastionUrl: 'https://portal.azure.com/#@contoso.com/resource/vm/connect', bastionLoginLink: login.key } });
          await vault.saveItem(kvc.id, { type: 'server', title: 'SQL01', server: { host: 'sql01.contoso.local', port: 3390 }, username: 'CONTOSO\sqladmin', password: 'x' });
          const full = await vault.getItem(kvc.id, login.id);
          const opened = await api.openAdminCenter({ url: 'https://entra.microsoft.com', key: login.key });
          // Azure portal family opens in the account's tenant (another signed-in account must not be taken silently).
          const domain = String(full.username || '').split('@')[1]?.toLowerCase();
          if (domain && opened.url !== `https://entra.microsoft.com/#@${domain}`) errors.push(`admin: Entra not opened in the account's tenant (${opened.url})`);
          const ms = await signInFor('login.microsoftonline.com');
          if (ms?.username !== full.username || ms?.mode !== 'microsoft') errors.push('admin: Microsoft sign-in job not handed out');
          if (await signInFor('evil.example.com')) errors.push('admin: sign-in handed to another host');
          // #372: the job belongs to the first tab that asks; another tab (e.g. opened by a foreign page) gets nothing.
          if (!(await signInFor('login.microsoftonline.com', 'smoke:1'))) errors.push('admin: first tab did not get the sign-in job');
          if (await signInFor('login.microsoftonline.com', 'smoke:2')) errors.push('admin: sign-in job handed to a second tab');
          if (!(await signInFor('login.microsoftonline.com', 'smoke:1'))) errors.push('admin: the claiming tab lost its sign-in job');
          if (await signInFor('login.microsoftonline.com')) errors.push('admin: claimed sign-in job handed out without a tab key (#424)');
          if (await api.openAdminCenter({ url: 'https://evil.example.com', key: login.key }).then(() => true, () => false)) errors.push('admin: unknown admin center accepted');
          const r = await api.connectServer({ containerId: kvc.id, id: saved.id, method: 'bastion' });
          if (r.method !== 'bastion' || (await signInFor('x.bastion.azure.com'))?.password !== full.password) errors.push('admin: Bastion VM sign-in missing');
          if ((await api.connectServer({ containerId: kvc.id, id: saved.id, method: 'rdp' })).method !== 'rdp') errors.push('admin: RDP failed');
          if ((await api.connectServer({ containerId: kvc.id, id: saved.id, method: 'teamviewer' })).method !== 'teamviewer') errors.push('admin: TeamViewer failed');
          // Linux: SSH instead of RDP, password to the clipboard; an address that ssh would read as an option is refused.
          const lnx = await vault.saveItem(kvc.id, { type: 'server', title: 'LNX01', username: 'root', password: 'lnx-pw', server: { kind: 'linux', host: '10.0.0.7' } });
          if ((await vault.getItem(kvc.id, lnx.id)).server.port !== 22 || !(await vault.summaries()).find((x) => x.id === lnx.id)?.methods.includes('ssh')) errors.push('admin: Linux device without SSH');
          if (!(await api.connectServer({ containerId: kvc.id, id: lnx.id, method: 'ssh' })).copied) errors.push('admin: SSH failed');
          const evil = await vault.saveItem(kvc.id, { type: 'server', title: 'EVIL', server: { kind: 'linux', host: '-oProxyCommand=calc' } });
          if (await api.connectServer({ containerId: kvc.id, id: evil.id, method: 'ssh' }).then(() => true, () => false)) errors.push('admin: SSH option injection not refused');
          await vault.deleteItem(kvc.id, evil.id);
          const vm = await vault.saveItem(kvc.id, { type: 'server', title: 'VMW01', server: { kind: 'vmware', host: 'vmw01', mgmtUrl: 'https://vcenter.contoso.local' } });
          if ((await api.connectServer({ containerId: kvc.id, id: vm.id, method: 'mgmt' })).method !== 'mgmt') errors.push('admin: vSphere page failed');
          setSignInJobs([]);
          config.update({ adminTools: true });
          changed();
          await sleep(800);
          await js('document.documentElement.classList.add("show-admin")');
          if (view === 'serveritem' || view === 'serveredit') await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
          await sleep(400);
          if (view === 'serveritem' || view === 'serveredit' || view === 'admin') await js('document.querySelector(".mode-switch [data-mode=devices]")?.click()');
          await sleep(300);
          if (view === 'serveritem' || view === 'serveredit') {
            if (!(await js('[...document.querySelectorAll(".list li.row-item[data-key]")].some((r) => r.textContent.includes("DC01"))'))) errors.push('devices tab: DC01 missing');
            await js('[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.textContent.includes("DC01"))?.click()');
          }
          if (view === 'serveredit') { await sleep(500); await js('document.querySelector(".detail-pane .item-hover-menu")?.click()'); await sleep(300); await js('document.querySelector(".context-menu [data-action=edit]")?.click()'); }
          await sleep(500);
        } catch (e) {
          errors.push(`admin: ${e.message}`);
        }
      }
      if (view === 'newmenu' || view === 'mstemplate') {
        // "New" menu with the login templates; mstemplate: the Microsoft template opened in the editor.
        win.setSize(1200, 780);
        await sleep(300);
        await js('document.querySelector(".new-split button:last-child")?.click()');
        await sleep(400);
        if (view === 'mstemplate') {
          await js('document.querySelector("[data-action=new-microsoft]")?.click()');
          await sleep(600);
          const ok = await js('(() => (document.querySelector(".detail-pane textarea[name=urls]")?.value || "").includes("login.microsoft.com") && !!document.querySelector(".detail-pane img"))()');
          if (!ok) errors.push('mstemplate: addresses or logo missing in the editor');
        }
      }
      if (view === 'msitem' || view === 'msentry') {
        // Microsoft entry with admin tools on: PIM and admin center tiles; a click hands the sign-in to the extension.
        try {
          const kvc = (await vault.containers()).find((c) => c.kind === 'keyvault' && !c.error && !c.locked);
          await vault.saveItem(kvc.id, { type: 'login', title: 'Microsoft', username: 'admin@contoso.onmicrosoft.com', password: 'x', msAdmin: true, urls: ['https://login.microsoftonline.com'] });
          config.update({ adminTools: true });
          changed();
          await sleep(800);
          await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
          await sleep(400);
          await js('[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.textContent.includes("admin@contoso.onmicrosoft.com"))?.click()');
          await sleep(600);
          if (!(await js('!!document.querySelector(".detail-pane [data-admin-link=pim]")'))) errors.push('msitem: PIM tile missing');
          if (view === 'msitem') {
            setSignInJobs([]);
            await js('document.querySelector(".detail-pane [data-admin-link=entra]")?.click()');
            await sleep(500);
            const job = await signInFor('login.microsoftonline.com');
            if (job?.username !== 'admin@contoso.onmicrosoft.com') errors.push(`msitem: Entra tile did not sign in with the entry (${job?.username})`);
            setSignInJobs([]);
          }
        } catch (e) {
          errors.push(`msitem: ${e.message}`);
        }
      }
      if (view === 'pkmove') {
        // Passkey row with the move button, dialog to pick the target entry (screenshot only).
        await js('[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.textContent.includes("Grafana"))?.click()');
        await sleep(600);
        await js('document.querySelector(".detail-pane .passkey-row .icon-btn[title]")?.click()');
        await sleep(400);
      }
      if (view === 'itemmenu') {
        // Entry with the "⋯" menu of its head toolbar open (screenshot only).
        await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
        await sleep(500);
        await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
        await sleep(400);
      }
      if (view === 'add') {
        await js('document.querySelector(".nav-section .icon-btn")?.click()');
        await sleep(300);
        await js('document.querySelectorAll("dialog[open] .option-card")[2]?.click()');
      }
      // Feature checks of the recent functions (desktop/smoke-features.js) – the normal run only, views keep their state.
      if (!view) {
        await featureChecks({
          js, sleep, errors, win, api, vault, config, changed, signInFor, copyViaHelperExe, typeViaHelperExe, vaultListRun, browserHandlers,
          areas,
          note: smokeGuard.note,
          clipboardHas: async (text) => (await runHelperExe('--clipboard-clear', text)) === 0,
          clearSignIns: () => { setSignInJobs([]); },
          adminCenterUrl,
          lastAdminUrl: () => lastAdminUrl,
          confirmAgentRead,
          confirmAgentPasskey,
          confirmAgentWrite,
          confirmBrowserMove,
          nativeQuestion,
          mcpService: mcp,
          chooseAgentMicrosoft,
          hintsShown,
          hintContent,
          browserCopy: (text) => browserHandlers.copy({ text }),
          browserHello: (client) => browserHandlers.hello({}, client),
          browserSnapshot: () => browserHandlers.snapshot(),
          browserPasskeySign: (msg) => browserHandlers.passkeySign(msg),
          browserItem: (msg) => browserHandlers.item(msg),
          browserSave: (msg) => browserHandlers.save(msg),
          browserPasskeyCandidates: (msg) => browserHandlers.passkeyCandidates(msg),
          noteExtension,
          simulateExtensionClients,
          simulateExtensionPolicy, simulateExtensionReinstall,
          waitForUnlock,
          release: smokeRelease,
          lockIfWindowsLocked,
          signInDone: (host) => browserHandlers.signInDone({ host }),
          // The feature checks use PIN 246813 (the personal vault check sets the same one; 6 characters for Enter, #472/#475).
          ensurePin: async () => {
            if (!config.get().appPin) config.update({ appPin: await hashPin('246813'), pinGuard: null });
            pinGuard.restore(null);
            return '246813';
          },
          resetPinGuard: () => { pinGuard.restore(null); config.update({ pinGuard: null }); }, pinGuard,
          openQuestionIds: () => [...questions.keys()],
          windows,
          startInNormalMode,
          trustAgentEntry,
          updaterArgs: () => updater.helperArgs('Keevault-Setup.exe', false),
        }).catch((err) => errors.push(`features: ${err.stack || err.message}`));
        errors.push(...areas.missing());
      }
      if (view) await sleep(1200);
      // Layout check (development): KVPWSAFE_MEASURE="<selector>[,<selector>…]" prints each match's box.
      if (process.env.KVPWSAFE_MEASURE) {
        const sel = JSON.stringify(process.env.KVPWSAFE_MEASURE);
        console.log(await js(`JSON.stringify(${sel}.split(',').flatMap((q) => [...document.querySelectorAll(q)].slice(0, 6).map((e) => { const r = e.getBoundingClientRect(); return [q, (e.textContent || '').trim().slice(0, 18), Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })))`));
      }
    }
    if (screenshot) {
      smokeGuard.note('screenshot');
      if (!process.argv.includes('--view=small')) win.setSize(1200, 780);
      // Transitions do not run in a never-shown window: the picture must show their end, not their start.
      await js('document.getAnimations().forEach((a) => { try { a.finish(); } catch {} })');
      const image = await win.webContents.capturePage();
      const problem = screenshotProblem(image);
      if (problem) errors.push(problem);
      await fs.writeFile(screenshot, image.toPNG());
    }
  }), 1500));
}
