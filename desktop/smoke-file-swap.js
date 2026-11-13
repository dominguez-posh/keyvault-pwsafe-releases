// Smoke check of #404, part of the secured-file area (desktop/main/smoke.js, which is near its size limit): another
// vault copied over a known file is refused by the file watcher's reload, stays refused after remove and open, the
// list offers the comparison, the dialog does not accept without the tick, and accepts with it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { newIdentity, signObject, wrapKey } from '../extension/core/members.js';
import { ContainerKey } from '../extension/core/protect.js';
import { FileVault } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';
import { until } from './smoke-wait.js';

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

/**
 * #521: a container key wrapped for us by someone with write access to the share (next generation, no signed key change
 * of an admin) is refused by the watcher: shown as a warning, the open vault keeps its key, a save writes nothing.
 */
export async function foreignKeyCheck({ files, errors, file, id, js }) {
  const current = await fs.readFile(file, 'utf8');
  const doc = JSON.parse(current);
  const vault = files.entries.get(id)?.vault;
  const before = vault?.ck?.exported;
  const evil = await ContainerKey.generate();
  const kv = doc.keyring.keyVersion + 1;
  doc.keyring.keyVersion = kv;
  doc.keyring.members = await Promise.all(doc.keyring.members.map(async (m) => (m.id === vault?.memberId
    ? { ...m, wrapped: { kv, ...(await wrapKey(evil.raw, m.ecdh, `kvpwsafe/member-key/${doc.id}/${m.id}/${kv}`)) } } : m)));
  try {
    await fs.writeFile(file, JSON.stringify(doc));
    await files.watched(files.entries.get(id));
    const warning = (await files.containers()).find((c) => c.id === id)?.warning || '';
    if (!/nicht von einem Admin|not set by an admin/.test(warning)) errors.push(`foreign key: an unsigned key change is not shown as a warning (#521): ${warning}`);
    // #522: no "repair" (it would keep the foreign key), the tampering notice instead – in the list and in the window.
    const c = (await files.containers()).find((x) => x.id === id);
    if (!c?.keyRefused || c.repairable) errors.push(`foreign key: offered as ${c?.repairable ? 'repairable' : 'not key-refused'} (#522)`);
    const written = await fs.readFile(file, 'utf8');
    if (await files.repair(id).then(() => true, () => false)) errors.push('foreign key: the repair ran on a refused key (#522)');
    if ((await fs.readFile(file, 'utf8')) !== written) errors.push('foreign key: the refused repair wrote the file (#522)');
    if (js) {
      const ui = await until(() => js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click(), document.getElementById("file-key-refused") ? (document.getElementById("file-repair-btn") ? "repair" : "ok") : ""'), 5000, 200);
      if (ui !== 'ok') errors.push(`foreign key: the window shows ${ui === 'repair' ? 'the repair button' : 'no tampering notice'} (#522)`);
    }
    const now = files.entries.get(id)?.vault?.ck?.exported;
    if (now === evil.exported) errors.push('foreign key: the device took a key wrapped by someone else (#521)');
    else if (now !== before) errors.push('foreign key: the open vault lost its key (#521)');
    await files.rename(id, 'Team-521').catch(() => {});
    if (JSON.parse(await fs.readFile(file, 'utf8')).name === 'Team-521') errors.push('foreign key: a change was saved into the file with the foreign key (#521)');
  } finally {
    await fs.writeFile(file, current);
    await files.watched(files.entries.get(id));
  }
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

/**
 * #523: a write race – admin Bob removes admin Alice on a state read before Alice's key change, Alice's device then changes
 * the key again. Her change is not merged over her removal (the key would have no proof that counts): nothing is written
 * and the others still unlock freshly. Two devices on one real file, passkey secrets made up (no WebAuthn needed).
 */
export async function removeRaceCheck({ errors, dir }) {
  const file = path.join(dir, 'Race523.kvpws');
  await fs.rm(file, { force: true });
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (text) => fs.writeFile(file, text) };
  const passkey = (name) => ({ credentialId: `race-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
  try {
    const pks = { alice: passkey('alice') };
    const alice = await FileVault.createSecure(io, { name: 'Race523', email: 'alice@smoke.invalid', passkey: pks.alice });
    await alice.persist();
    await alice.memberOp({ type: 'sharing', enabled: true });
    const ids = {};
    for (const [name, role] of Object.entries({ bob: 'admin', carol: 'reader', dave: 'editor', erin: 'reader' })) {
      pks[name] = passkey(name);
      ids[name] = (await new FileVault(io).requestAccess({ email: `${name}@smoke.invalid`, passkey: pks[name] })).memberId;
      await alice.load();
      await alice.memberOp({ type: 'approve', memberId: ids[name], role });
    }
    const stale = await io.read();
    await alice.memberOp({ type: 'remove', memberId: ids.carol });
    let first = true; // Bob's device read the file before that write
    const racing = { read: async () => (first ? ((first = false), stale) : io.read()), write: io.write };
    const bob = new FileVault(racing);
    await bob.unlockWithPasskey(pks.bob.credentialId, pks.bob.prfOutput);
    first = true;
    await bob.memberOp({ type: 'remove', memberId: alice.memberId });
    const bobsFile = await io.read();
    const written = await alice.memberOp({ type: 'remove', memberId: ids.erin }).then(() => 'written', (e) => e.message);
    if (written === 'written' || (await io.read()) !== bobsFile) errors.push(`remove race: the removed admin's key change was merged over the removal (#523): ${written}`);
    for (const name of Object.keys(ids).filter((n) => n === 'bob' || n === 'dave')) {
      const why = await new FileVault(io).unlockWithPasskey(pks[name].credentialId, pks[name].prfOutput).then(() => '', (e) => e.message);
      if (why) errors.push(`remove race: ${name} cannot unlock freshly after the race (#523): ${why}`);
    }
  } catch (e) {
    errors.push(`remove race: ${e.message} (#523)`);
  } finally {
    await fs.rm(file, { force: true });
  }
}
