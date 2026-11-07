// Smoke check of #404, part of the secured-file area (desktop/main/smoke.js, which is near its size limit): another
// vault copied over a known file is refused by the file watcher's reload, stays refused after remove and open, the
// list offers the comparison, the dialog does not accept without the tick, and accepts with it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { newIdentity, signObject } from '../extension/core/members.js';

export async function fileSwapCheck({ files, js, sleep, errors, dir, changed }) {
  const file = path.join(dir, 'Swap404.kvpws');
  const other = path.join(dir, 'Swap404-fremd.kvpws');
  for (const f of [file, other]) await fs.rm(f, { force: true });
  const team = await files.create(file, 'Swap404', { password: 'Smoke-Pass-1234' }, 'smoke');
  const foreign = await files.create(other, 'Swap404-fremd', { password: 'Smoke-Pass-1234' }, 'smoke');
  files.remove(foreign.id);
  await fs.copyFile(other, file);
  await files.reload(files.entries.get(team.id));
  const swapped = (await files.containers()).find((c) => c.path === file);
  if (!swapped?.swap || swapped.swap.now.id !== foreign.id) errors.push('fileswap: a swapped file was read into the open vault (#404)');
  files.remove(swapped.id);
  const again = await files.open(file);
  if (!(await files.containers()).find((c) => c.id === again)?.swap) errors.push('fileswap: remove and open took the swapped file without comparing (#404)');
  changed();
  await sleep(600);
  await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Swap404"))?.click(), true');
  await sleep(600);
  await js('document.getElementById("file-swap-check")?.click(), true');
  await sleep(400);
  const shown = await js('JSON.stringify([...document.querySelectorAll("dialog[open] .swap-table td")].map((td) => td.textContent))');
  if (!String(shown).includes(swapped.swap.before.code) || !String(shown).includes(swapped.swap.now.code)) errors.push(`fileswap: dialog without both safety codes (${shown})`);
  const accept = 'document.querySelector("dialog[open] .modal-footer .btn.danger")?.click(), true';
  await js(accept);
  await sleep(500);
  if (files.pins()[file] !== team.id) errors.push('fileswap: accepted without the tick (#404)');
  await js('document.getElementById("swap-compared").checked = true, true');
  await js(accept);
  for (let i = 0; i < 10 && files.pins()[file] !== foreign.id; i++) await sleep(300);
  if (files.pins()[file] !== foreign.id) errors.push('fileswap: accepting with the tick did not take the vault');
  files.remove(foreign.id);
  for (const f of [file, other]) await fs.rm(f, { force: true });
  changed();
}

/** #430: the secured team file written back in the old format under its ID is refused; the open vault stays secured. */
export async function downgradeCheck({ files, errors, file, id }) {
  const secured = await fs.readFile(file, 'utf8');
  try {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(secured), version: 1 }));
    const entry = files.entries.get(id);
    if (await files.reload(entry).then(() => true, () => false)) errors.push('downgrade: old format under the secured ID was read (#430)');
    if (files.entries.get(id)?.vault?.secure !== true) errors.push('downgrade: the open vault is no longer secured (#430)');
    // The watcher shows the refusal; a change saved meanwhile is refused, not written as the old format.
    await files.watched(entry);
    if (!(await files.containers()).find((c) => c.id === id)?.warning) errors.push('downgrade: the refused reload is not shown (#430)');
    if (await files.rename(id, 'Team-Datei').then(() => true, () => false)) errors.push('downgrade: saving took the old format from the disk (#430)');
    if (JSON.parse(await fs.readFile(file, 'utf8')).version !== 1) errors.push('downgrade: the planted file was written over');
  } finally {
    await fs.writeFile(file, secured);
    await files.watched(files.entries.get(id));
  }
}

/** #432: an older state of the secured team file (a grant gone, as before an approval) is refused by the watcher. */
export async function rollbackCheck({ files, errors, file, id }) {
  const current = await fs.readFile(file, 'utf8');
  const doc = JSON.parse(current);
  const member = doc.keyring.members.find((m) => (m.grants || []).length);
  if (!member) return errors.push('rollback: no grant in the team file to roll back');
  member.grants = member.grants.slice(0, -1);
  try {
    await fs.writeFile(file, JSON.stringify(doc));
    await files.watched(files.entries.get(id));
    if (!(await files.containers()).find((c) => c.id === id)?.warning) errors.push('rollback: an older state of the secured file was taken (#432)');
  } finally {
    await fs.writeFile(file, current);
    await files.watched(files.entries.get(id));
  }
  return null;
}

/** #433: an unsigned entry in rejected (written by any writer) takes no admin out of the secured team file. */
export async function rejectedCheck({ files, errors, file, id }) {
  const current = await fs.readFile(file, 'utf8');
  const doc = JSON.parse(current);
  const vault = files.entries.get(id)?.vault;
  const me = vault?.memberId;
  try {
    await fs.writeFile(file, JSON.stringify({ ...doc, keyring: { ...doc.keyring, rejected: [...(doc.keyring.rejected || []), me] } }));
    await files.watched(files.entries.get(id));
    if (files.entries.get(id)?.vault?.roster?.current(me)?.role !== 'admin') errors.push('rejected: an unsigned entry took the admin out (#433)');
    // #440: an admin grant for a new member, validly signed but dated before the newest known grant, does not count.
    const n = await newIdentity();
    const at = new Date(0).toISOString();
    const member = { id: 'smoke-440', email: 'n@smoke.invalid', ecdh: n.ecdh, sign: n.sign, requested: at, credentials: [], removedCredentials: [] };
    const g = { role: 'admin', status: 'active', at, by: me };
    g.sig = await signObject(vault.identity, { file: doc.id, member: member.id, email: member.email, ecdh: member.ecdh, sign: member.sign, role: g.role, status: g.status, at, by: me });
    await fs.writeFile(file, JSON.stringify({ ...doc, keyring: { ...doc.keyring, members: [...doc.keyring.members, { ...member, grants: [g] }] } }));
    await files.watched(files.entries.get(id));
    if (files.entries.get(id)?.vault?.roster?.current('smoke-440')?.status === 'active') errors.push('rejected: a backdated admin grant counted (#440)');
    // … and the admin sees it as an invalid entry to take out with a signed rejection.
    if (!(await Promise.resolve().then(() => files.members(id, 'localhost')).catch(() => null))?.members?.find((x) => x.id === 'smoke-440')?.invalid) errors.push('rejected: the backdated grant is not shown as invalid entry (#440)');
    // #444: a known grant changed with its signature kept (here: a role) is refused like an older state.
    const known = doc.keyring.members.find((m) => m.id === me);
    const changedDoc = { ...doc, keyring: { ...doc.keyring, members: doc.keyring.members.map((m) => (m === known ? { ...m, grants: m.grants.map((x, i) => (i === 0 ? { ...x, role: 'reader' } : x)) } : m)) } };
    await fs.writeFile(file, JSON.stringify(changedDoc));
    await files.watched(files.entries.get(id));
    if (!(await files.containers()).find((c) => c.id === id)?.warning) errors.push('rejected: a changed known grant was taken (#444)');
    // #446: offered for repair and put back from the known state – the known grant exactly as signed, the file taken.
    if (!(await files.containers()).find((c) => c.id === id)?.repairable) errors.push('rejected: the refused file is not offered for repair (#446)');
    await files.repair(id).catch((e) => errors.push(`rejected: repair failed (#446): ${e.message}`));
    if ((await files.containers()).find((c) => c.id === id)?.warning) errors.push('rejected: still refused after the repair (#446)');
    const repaired = JSON.parse(await fs.readFile(file, 'utf8')).keyring.members.find((m) => m.id === me)?.grants?.[0];
    if (repaired?.role !== known.grants[0].role) errors.push('rejected: the repair did not put the known grant back (#446)');
  } finally {
    await fs.writeFile(file, current);
    await files.watched(files.entries.get(id));
  }
}
