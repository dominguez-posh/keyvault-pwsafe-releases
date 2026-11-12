// Smoke check of #435, part of the secured-file area (desktop/main/smoke.js is at its size limit): a backup of the team
// file put back is refused; only in admin mode the list offers to take it, the dialog names what is lost, and the main
// process refuses without PIN and passkey, before the wait, with a wrong name, outside admin mode and – never listed – in
// a locked window. Taken, the file has a new key above the known state and the change log says so.

import fs from 'node:fs/promises';
import { ACCEPT_DELAY_MS, OlderStateAcceptance } from './file-accept-older.js';
import { until } from './smoke-wait.js';

const PIN = '271828';

/**
 * #527: Alex (admin) and Sam (editor) registered their passkeys in the run's one virtual authenticator, and the older
 * state holds both. Only Alex's may be offered (allowCredentials) – before, the authenticator answered with either and
 * Sam's was refused about every second run (#526). Sam's passkey now stays in the authenticator for the real ceremony.
 */
async function onlyAdminsOffered(files, id, backup, fail) {
  const sam = JSON.parse(backup).keyring.members.find((m) => m.email === 'sam@contoso.com');
  const samCreds = new Set((sam?.credentials || []).map((c) => c.credentialId));
  if (!samCreds.size) fail('no passkey of Sam in the older state (#527)');
  const acc = new OlderStateAcceptance(files);
  const { token } = await acc.prepare(id);
  const { passkeys } = await acc.passkeys(token, 'localhost');
  if (!passkeys.length) fail('no admin passkey offered (#527)');
  if (passkeys.some((p) => samCreds.has(p.credentialId))) fail('the passkey of a non-admin is offered (#527)');
}

export async function acceptOlderCheck({ api, files, config, js, sleep, errors, changed, file, id, lockedApi, pinGuard }) {
  const fail = (msg) => errors.push(`acceptolder: ${msg} (#435)`);
  if (lockedApi.has('acceptOlderPrepare') || lockedApi.has('acceptOlderUnlock') || lockedApi.has('acceptOlderCommit')) fail('allowed while the window is locked');
  const pinBefore = config.get().appPin;
  const adminBefore = config.get().adminTools;
  if (pinBefore) return fail('an app PIN of another check is still set');
  await api.setPin({ next: PIN });
  try {
    const backup = await fs.readFile(file, 'utf8');
    const backupKv = JSON.parse(backup).keyring.keyVersion;
    const sam = (await api.fileMembers(id)).members.find((m) => m.email === 'sam@contoso.com' && m.status === 'active');
    if (!sam) return fail('no second member in the team file');
    await api.save(id, { title: 'Smoke-435 neuer', username: 'n', password: 'n' });
    await api.fileMemberOp(id, { type: 'remove', memberId: sam.id });
    await fs.writeFile(file, backup);
    const entry = files.entries.get(id);
    await files.watched(entry);
    const c = (await files.containers()).find((x) => x.id === id);
    if (!c?.warning || !c.olderState) return fail(`the backup was not refused as an older state (${c?.warning})`);

    // Outside admin mode: no button, and the main process refuses.
    config.update({ adminTools: false });
    changed();
    await sleep(600);
    await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click(), true');
    await sleep(600);
    if (await js('!!document.getElementById("file-accept-older-btn")')) fail('button shown outside admin mode');
    if (await api.acceptOlderPrepare(id).then(() => true, () => false)) fail('prepared outside admin mode');

    // Admin mode: the button opens the dialog with what is lost and who stays.
    config.update({ adminTools: true });
    changed();
    // #526: under load the redraw and the dialog came later than fixed pauses; the checks below ask again.
    const shown = await until(() => js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click(), !!document.getElementById("file-accept-older-btn")'), 6000, 300);
    if (!shown) fail(`no button in admin mode (window: ${await js('JSON.stringify({ shell: !!document.querySelector(".shell"), dialogs: document.querySelectorAll("dialog[open]").length, nav: [...document.querySelectorAll(".sidebar .nav")].map((n) => n.textContent.trim().slice(0, 20)), main: document.querySelector("main, .main-pane, .list-pane")?.innerText.slice(0, 120) })')}, config ${config.get().adminTools})`);
    await js('document.getElementById("file-accept-older-btn")?.click(), true');
    await until(() => js('!!document.querySelector("dialog[open] #accept-older-lost")?.textContent && !!document.querySelector("dialog[open] .accept-older-list")?.textContent'), 5000, 100);
    const lost = await js('document.querySelector("dialog[open] #accept-older-lost")?.textContent || ""');
    if (!String(lost).includes('Smoke-435 neuer')) fail(`dialog does not name the lost entry (${lost})`);
    const members = String(await js('document.querySelector("dialog[open] .accept-older-list")?.textContent || ""')).toLowerCase();
    if (!members.includes('alex@contoso.com') || members.includes('sam@contoso.com')) fail(`dialog lists the wrong active members (${members})`);
    // Accept without PIN and passkey: refused, nothing written.
    await js('[...document.querySelectorAll("dialog[open] .modal-footer .btn.danger")].at(-1)?.click(), true');
    await sleep(500);
    if ((await fs.readFile(file, 'utf8')) !== backup) fail('written without PIN and passkey');
    await js('document.querySelector("dialog[open] .modal-footer .btn")?.click(), true');

    // The main process: wrong PIN, too early, wrong name – then taken.
    const info = await api.acceptOlderPrepare(id);
    if (await api.acceptOlderUnlock(info.token, '000000').then(() => true, () => false)) fail('unlocked with a wrong PIN');
    if (await api.acceptOlderCommit(info.token, 'Team-Datei').then(() => true, () => false)) fail('committed without passkey');
    await onlyAdminsOffered(files, id, backup, fail);
    const started = Date.now();
    const checked = await api.acceptOlderUnlock(info.token, PIN); // Sam's passkey is in the authenticator, too (#527)
    if (typeof checked?.dropped !== 'number') fail('no count of dropped versions');
    if (pinGuard.consume()) fail('the PIN left an unlock token behind'); // 0.9.33 review
    if (Date.now() - started < ACCEPT_DELAY_MS - 500 && await api.acceptOlderCommit(info.token, 'Team-Datei').then(() => true, () => false)) fail('committed before the wait');
    await sleep(Math.max(0, ACCEPT_DELAY_MS - (Date.now() - started)) + 200);
    if (await api.acceptOlderCommit(info.token, 'Falscher Name').then(() => true, () => false)) fail('committed with a wrong name');
    const taken = await api.acceptOlderCommit(info.token, 'Team-Datei');
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!(doc.keyring.keyVersion > backupKv + 1)) fail(`no new key above the known state (${backupKv} → ${doc.keyring.keyVersion})`);
    const after = (await files.containers()).find((x) => x.id === taken);
    if (after?.warning || after?.error || after?.olderState) fail('still refused after taking it');
    if ((await files.summaries(taken)).some((s) => s.title === 'Smoke-435 neuer')) fail('the lost entry is still there');
    if (!(await api.changelog(taken)).some((e) => e.action === 'older-state-accept' && e.trusted)) fail('change log misses the acceptance');
    if ((await api.fileMembers(taken)).members.some((m) => m.email === 'sam@contoso.com' && m.status === 'active')) fail('the removed member came back');
    if (await api.acceptOlderCommit(info.token, 'Team-Datei').then(() => true, () => false)) fail('token used twice');
  } finally {
    config.update({ adminTools: adminBefore });
    if (!pinBefore && config.get().appPin) await api.setPin({ current: PIN, next: null }).catch((e) => errors.push(`acceptolder: PIN not removed: ${e.message}`));
    changed();
  }
  return null;
}

