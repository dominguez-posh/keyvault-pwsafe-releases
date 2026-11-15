// Smoke check of #539 Etappe 10: a secured file vault gets its break-glass stick (the run's virtual authenticator with
// PRF, registered and test-opened in a second ceremony) as an admin member of its own; the last one cannot be removed;
// a request is approved only with the code the person reads out, typed by the admin – in the members dialog, too. The
// file lives in a temporary folder.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { until } from './smoke-wait.js';

const rejects = (p) => p.then(() => false, () => true);

export async function breakGlassCheck({ js, sleep, api, changed, fail }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keevault-smoke-bg-'));
  const file = path.join(dir, 'notfall.kvpws');
  let id = null;
  try {
    ({ id } = await api.createSecureFile({ path: file, name: 'Notfall-Team', email: 'alex@smoke.invalid', attachment: 'cross-platform' }));
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const bg = doc.keyring.members.find((m) => m.breakGlass === true);
    if (!bg) return fail('the new secured file has no break-glass member');
    if (bg.credentials?.[0]?.credentialId === doc.keyring.members.find((m) => !m.breakGlass)?.credentials?.[0]?.credentialId) fail('the break-glass stick is the creator\'s credential');
    const view = await api.fileMembers(id);
    const bgView = view.members.find((m) => m.breakGlass);
    if (bgView?.role !== 'admin' || bgView.status !== 'active') fail(`the break-glass member is not an active admin (${bgView?.role}/${bgView?.status})`);
    if (!(await api.changelog(id)).some((e) => e.action === 'break-glass-add' && e.trusted)) fail('the change log misses the break-glass stick');
    if (!(await rejects(api.fileMemberOp(id, { type: 'remove', memberId: bgView.id })))) fail('the last break-glass access was removed');

    // "Mit Notfall-Stick öffnen": only the stick; it opens as admin, and what it does stands out in the change log.
    await api.lockContainer(id);
    const opened = await api.unlockContainerPasskey(id, { breakGlass: true }).catch((e) => ({ error: e.message }));
    if (opened.error || opened.role !== 'admin') fail(`the break-glass stick did not open the file (${opened.error || opened.role})`);
    else {
      await api.addFolder(id, 'Notfall');
      if (!(await api.changelog(id)).some((e) => e.action === 'folder-create' && e.breakGlass)) fail('the change log does not mark what the break-glass stick did');
      if (JSON.parse(await readFile(file, 'utf8')).keyring.members.some((m) => m.breakGlass && m.credentials.some((c) => c.kind === 'app'))) fail('the break-glass member was linked to the master password');
    }
    await api.lockContainer(id);
    await api.unlockContainerPasskey(id).catch((e) => fail(`the everyday passkey unlock failed: ${e.message}`));
    if ((await api.fileMembers(id)).members.find((m) => m.me)?.breakGlass) fail('the everyday passkey unlock used the break-glass stick');

    // Request: the admin's view shows no code; approving without it, or with a wrong one, does nothing.
    await api.fileMemberOp(id, { type: 'sharing', enabled: true });
    const req = await api.requestFileAccess(id, { email: 'sam@smoke.invalid', attachment: 'cross-platform' });
    const sam = (await api.fileMembers(id)).members.find((m) => m.email === 'sam@smoke.invalid');
    if (!sam || sam.status !== 'pending') return fail('the request is not pending');
    if (sam.safetyCode) fail('the admin sees the requester\'s code (it has to be typed)');
    if (!(await rejects(api.fileMemberOp(id, { type: 'approve', memberId: sam.id, role: 'reader' })))) fail('approved without a code');
    if (!(await rejects(api.fileMemberOp(id, { type: 'approve', memberId: sam.id, role: 'reader', code: '1111 2222 3333 4444' })))) fail('approved with a wrong code');
    if (!(await rejects(api.fileMemberOp(id, { type: 'setRole', memberId: sam.id, role: 'editor' })))) fail('a request became active through setRole, without the code (Konrad M1)');
    if ((await api.fileMembers(id)).members.find((m) => m.id === sam.id)?.status !== 'pending') fail('the request is no longer pending after the refused attempts');

    // Members dialog: the code field, the break-glass badge, no removal of the last one; typed code approves.
    changed();
    await sleep(400);
    await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes("Notfall-Team")); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); return true; })()`);
    await sleep(300);
    await js('document.querySelector(".context-menu [data-action=members]")?.click(); true');
    if (!(await until(() => js(`!!document.querySelector('dialog[open] [data-request="${sam.id}"] [data-safety-code]')`), 5000))) fail('the members dialog has no code field for the request');
    else {
      if (await js(`(document.querySelector('dialog[open] [data-request="${sam.id}"]')?.textContent || '').includes(${JSON.stringify(req.safetyCode)})`)) fail('the members dialog shows the code');
      if (!(await js('!!document.querySelector("dialog[open] [data-break-glass]")'))) fail('the members dialog does not mark the break-glass member');
      if (!(await js('[...document.querySelectorAll("dialog[open] .member-row")].some((r) => r.querySelector("[data-break-glass]") && r.querySelector(".btn.danger")?.disabled)'))) fail('the last break-glass member can be removed in the dialog');
      if (!(await js('!!document.querySelector("dialog[open] [data-add-break-glass]")'))) fail('no "Notfall-Stick hinzufügen" for the admin');
      await js(`(() => { const row = document.querySelector('dialog[open] [data-request="${sam.id}"]'); const f = row.querySelector('[data-safety-code]'); f.value = ${JSON.stringify(req.safetyCode)}; f.dispatchEvent(new Event('input', { bubbles: true })); row.querySelector('.btn.primary').click(); return true; })()`);
      if (!(await until(async () => (await api.fileMembers(id)).members.find((m) => m.id === sam.id)?.status === 'active', 6000))) fail('the typed code did not approve the request');
      await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    }
  } catch (e) {
    fail(e.message);
  } finally {
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
    if (id) await api.removeContainer(id).catch(() => {});
    changed();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return undefined;
}
