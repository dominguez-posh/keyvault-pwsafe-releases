// Smoke check of #539 Etappe 8: secured file vaults at the app's master password (member key in the personal vault).
// A temporary test folder (KVPWSAFE_TEST_REMOTE) holds the personal vault and two secured files – never a real one.
// - created with the master password only: no passkey in the file, opens after an app unlock by itself and with the
//   window button "Mit Masterpasswort öffnen";
// - a passkey file gets the same identity at the master password after its passkey unlock (migration);
// - a key change of the personal vault keeps the identities (only wrapped anew);
// - "Nur mit Passkey": refused while a member has no passkey, then no master password access any more;
// - "master password compromised": only right after a key change; the admin's new identity applies at once.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { until } from './smoke-wait.js';

const MP = 'Smoke-Mitglied-539-alt!';
const NEW = 'Smoke-Mitglied-539-neu!';
const NEW2 = 'Smoke-Mitglied-539-neu2!';
const rejects = (p) => p.then(() => false, () => true);
const appCreds = (doc) => doc.keyring.members.flatMap((m) => (m.credentials || []).filter((c) => c.kind === 'app'));

export async function memberKeyCheck({ js, sleep, api, config, changed, ensurePin, resetPinGuard, fail }) {
  const keep = ['appPin', 'unlockKeys', 'personalDeviceKeys', 'pinGuard', 'personalVaults', 'personalRecoveryPending', 'personalRecoveryRenewed', 'settingsCopy', 'memberKeySeen'];
  const before = Object.fromEntries(keep.map((k) => [k, config.get()[k]]));
  const env = { remote: process.env.KVPWSAFE_TEST_REMOTE, hello: process.env.KVPWSAFE_TEST_HELLO };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-member-'));
  const personalFile = path.join(dir, 'Keevault-Persoenlich.kvpws');
  const teamFile = path.join(dir, 'team-mp.kvpws');
  const pkFile = path.join(dir, 'team-passkey.kvpws');
  const doc = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const container = async (file) => (await api.state()).containers.find((c) => c.path === file) || null;
  let password = MP;
  const ids = [];
  try {
    process.env.KVPWSAFE_TEST_REMOTE = dir;
    delete process.env.KVPWSAFE_TEST_HELLO;
    config.update({ unlockKeys: null, appPin: null, personalVaults: [], personalDeviceKeys: {}, settingsCopy: false, memberKeySeen: null });
    const pin = await ensurePin();
    await api.lock();
    await api.verifyPin(pin);
    await api.unlock({ entra: true });
    await api.setupMasterPassword({ password: MP, pin });
    await api.createPersonal({ folder: dir, password: MP });
    const personalId = (await container(personalFile))?.id;
    if (!personalId) return fail('no personal vault in the test folder');
    ids.push(personalId);
    config.update({ personalRecoveryPending: {}, personalRecoveryRenewed: {} });

    // Lucas 13.11.2026: no new shared file vault in the old format (shared password) any more.
    if (!(await rejects(api.createFile({ path: path.join(dir, 'alt.kvpws'), name: 'Alt', password: 'Alt-Format-539!' })))) fail('a file vault in the old format could still be created');
    // Created with the master password: an app credential, no passkey, no passkey ceremony.
    const { id } = await api.createSecureFile({ path: teamFile, name: 'Team-MP', email: 'alex@smoke.invalid', method: 'app' });
    ids.push(id);
    const d1 = await doc(teamFile);
    if (appCreds(d1).length !== 1) fail(`the new file has no app credential (${appCreds(d1).length})`);
    if (d1.keyring.members[0].credentials.some((c) => c.kind !== 'app')) fail('a passkey was registered although the master password was chosen');
    if (!config.get().memberKeySeen?.gen) fail('the device did not note the member key it used');
    if (!(await api.protectionInfo(id))?.memberKey) fail('protectionInfo does not offer the master password for the file');
    await api.save(id, { title: 'Smoke-MP-Eintrag', password: 'geheim-539' }).catch((e) => fail(`saving in the file failed: ${e.message}`));

    // App locked and unlocked with the master password: the secured file opens by itself.
    await api.lock();
    resetPinGuard?.();
    await api.verifyPin(MP, 'password');
    await api.unlock({ entra: true });
    if (!(await until(async () => (await container(teamFile))?.locked === false, 10000))) fail('the secured file did not open with the app unlock');

    // Window: locked file → "Mit Masterpasswort öffnen" → open.
    await api.lockContainer(id);
    changed();
    await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-MP"))?.click(); true`);
    if (!(await until(() => js('!!document.querySelector("[data-unlock-member-key]")'), 6000))) fail('the locked file shows no "Mit Masterpasswort öffnen"');
    else {
      await js('document.querySelector("[data-unlock-member-key]").click(); true');
      if (!(await until(async () => (await container(teamFile))?.locked === false, 8000))) fail('"Mit Masterpasswort öffnen" did not open the file');
    }

    // Konrad H1: an older app changed the personal vault's key and left the member keys unreadable – this device's copy
    // (sealed with DK) brings them back under the current key; nothing new is created over them.
    if (!config.get().memberKeyDevice?.ct) fail('no device copy of the member keys');
    const pdoc = await doc(personalFile);
    const garbage = (pdoc.memberKeys || []).map((e) => ({ ...e, data: Buffer.from(`kaputt-${e.fp}`.padEnd(60, 'x')).toString('base64') }));
    if (!garbage.length) fail('the personal vault holds no member key');
    await writeFile(personalFile, JSON.stringify({ ...pdoc, memberKeys: garbage }, null, 1));
    await sleep(2500); // the file watcher reloads the personal vault
    await api.lockContainer(id);
    await api.unlockContainerMemberKey(id).catch((e) => fail(`the file does not open after the member keys became unreadable: ${e.message}`));
    if (!(await until(async () => (await doc(personalFile)).memberKeys?.some((e) => !garbage.some((g) => g.data === e.data)), 8000))) fail('the member key was not sealed again under the current key');
    if ((await doc(personalFile)).memberKeys?.length !== garbage.length) fail('a new member key was created next to the unreadable one');

    // Migration: a passkey file links the same identity to the master password after its passkey unlock.
    const pk = await api.createSecureFile({ path: pkFile, name: 'Team-Passkey', email: 'alex@smoke.invalid', attachment: 'cross-platform' });
    ids.push(pk.id);
    if (appCreds(await doc(pkFile)).length) fail('the passkey file has an app credential right after creating');
    await api.lockContainer(pk.id);
    await api.unlockContainerPasskey(pk.id).catch((e) => fail(`passkey unlock failed: ${e.message}`));
    if (!(await until(async () => appCreds(await doc(pkFile)).length === 1, 8000))) fail('the passkey member was not linked to the master password');
    const pkDoc = await doc(pkFile);
    if (pkDoc.keyring.members.filter((m) => !m.breakGlass).length !== 1) fail('the migration made a new identity instead of linking the same one');
    if (pkDoc.keyring.members.some((m) => m.breakGlass && m.credentials.some((c) => c.kind === 'app'))) fail('the break-glass member was linked to the master password');
    await api.lockContainer(pk.id);
    await api.unlockContainerMemberKey(pk.id).catch((e) => fail(`the linked passkey file does not open with the master password: ${e.message}`));
    // Konrad M4: removed on purpose stays removed – the next passkey unlock does not link again.
    const appCred = (await api.fileMembers(pk.id)).members.find((m) => m.me)?.credentials?.find((c) => c.kind === 'app');
    if (!appCred) fail('the members view does not list the own master password access');
    else await api.fileMemberOp(pk.id, { type: 'removeCredential', credentialEntryId: appCred.id });
    await api.lockContainer(pk.id);
    await api.unlockContainerPasskey(pk.id).catch((e) => fail(`passkey unlock failed: ${e.message}`));
    await sleep(2000);
    if (appCreds(await doc(pkFile)).length) fail('a removed master password access was linked again by itself');

    // "Nur mit Passkey": refused while the master-password-only member has no passkey; on the passkey file it drops the
    // app credential and the master password opens nothing.
    if (!(await rejects(api.fileMemberOp(id, { type: 'passkeyOnly', enabled: true })))) fail('"Nur mit Passkey" was switched on with a member without a passkey');
    await api.fileMemberOp(pk.id, { type: 'passkeyOnly', enabled: true }).catch((e) => fail(`"Nur mit Passkey" failed: ${e.message}`));
    if (appCreds(await doc(pkFile)).length) fail('"Nur mit Passkey" left an app credential in the file');
    if ((await api.fileMembers(pk.id))?.passkeyOnly !== true) fail('the members view does not show "Nur mit Passkey"');
    await api.lockContainer(pk.id);
    if (!(await rejects(api.unlockContainerMemberKey(pk.id)))) fail('the master password opened a file with "Nur mit Passkey"');
    // A member key from the window is ignored: linking again adds nothing (the own one is already there).
    await api.fileMemberOp(id, { type: 'addAppCredential', mk: 'AAAA' }).catch((e) => fail(`linking again failed: ${e.message}`));
    if (appCreds(await doc(teamFile)).length !== 1) fail('a member key from the window made a second app credential');

    // "Master password compromised" only right after a key change.
    if (!(await rejects(api.renewMemberIdentity()))) fail('the memberships were renewed without a change of the master password');
    // A key change of the personal vault keeps the identities (only wrapped anew).
    const kvBefore = (await doc(teamFile)).keyring.keyVersion;
    await api.confirmMasterPassword({ password: MP }, 'personal-keyring');
    await api.updateProtection(personalId, { type: 'rekey', password: NEW });
    password = NEW;
    await api.lockContainer(id);
    await api.unlockContainerMemberKey(id).catch((e) => fail(`after the key change the file does not open with the master password: ${e.message}`));
    // Compromised: the admin's new identity applies at once; the old app credential is gone.
    await api.confirmMasterPassword({ password: NEW }, 'personal-keyring');
    await api.updateProtection(personalId, { type: 'rekey', password: NEW2 });
    password = NEW2;
    const oldCred = appCreds(await doc(teamFile))[0]?.id;
    const renewed = await api.renewMemberIdentity().catch((e) => ({ error: e.message }));
    const mine = Array.isArray(renewed) ? renewed.find((x) => x.id === id) : null;
    if (!mine?.replaced) fail(`the admin's identity was not replaced at once (${JSON.stringify(renewed)})`);
    const after = await doc(teamFile);
    if (appCreds(after).some((c) => c.id === oldCred)) fail('the old app credential is still in the file');
    if (after.keyring.keyVersion <= kvBefore) fail('replacing the identity changed no key');
    // The break-glass member (#539 Etappe 10) stays active – only the person's own identities count.
    if (after.keyring.members.filter((m) => !m.breakGlass && m.grants?.at(-1)?.status === 'active').length !== 1) fail('the old identity is still active after the replacement');
    await api.lockContainer(id);
    await api.unlockContainerMemberKey(id).catch((e) => fail(`the new identity does not open the file: ${e.message}`));
    if (!(await rejects(api.renewMemberIdentity()))) fail('the renewal could be used twice after one key change');
  } catch (e) {
    fail(e.message);
  } finally {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    if (!(await api.state()).opened) {
      resetPinGuard?.();
      await api.verifyPin(password, 'password').then(() => api.unlock({ entra: true }), () => null);
    }
    for (const cid of ids.reverse()) await api.removeContainer(cid).catch(() => {});
    for (const [k, v] of [['KVPWSAFE_TEST_REMOTE', env.remote], ['KVPWSAFE_TEST_HELLO', env.hello]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    config.update(before);
    resetPinGuard?.();
    changed();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return undefined;
}
