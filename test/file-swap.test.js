import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileContainers } from '../desktop/files.js';
import { vaultIdentity } from '../desktop/file-identity.js';
import { safetyCode } from '../extension/core/members.js';

// #404 (Konrad, decision of the Keevault CTO): another vault where a known one was is never taken by itself – not after
// removing and opening again either. Only after the person compared creator and safety code, before and now.

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-swap-'));
  const state = { paths: [], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  return { dir, state, make };
}

test('a swapped file stays refused after remove and open, shows before and now, and opens only once accepted', async () => {
  const { dir, state, make } = await setup();
  const first = make();
  let later = null;
  try {
    const file = path.join(dir, 'Team.kvpws');
    const other = path.join(dir, 'Fremd.kvpws');
    const team = await first.create(file, 'Team', { password: 'Smoke-Pass-1234' }, 'me');
    const foreign = await first.create(other, 'Team', { password: 'Smoke-Pass-1234' }, 'me');
    assert.match(state.notes[file]?.code || '', /^\d{4} \d{4} \d{4} \d{4}$/);
    first.close();
    await fs.copyFile(other, file);
    state.paths = [file];
    later = make();
    await later.load();
    const c = (await later.containers()).find((x) => x.path === file);
    assert.ok(c.error && c.swap, 'refused with the comparison');
    assert.equal(c.swap.before.id, team.id);
    assert.equal(c.swap.now.id, foreign.id);
    assert.notEqual(c.swap.before.code, c.swap.now.code);
    // Removing keeps the file ID: opening again is still refused (the attack of the first fix).
    later.remove(c.id);
    assert.equal(state.pins[file], team.id);
    const again = await later.open(file);
    assert.ok((await later.containers()).find((x) => x.id === again)?.swap, 'opened again without comparing');
    // The dialog's ID must still be in the file; then the new one is remembered.
    await assert.rejects(later.acceptSwap(file, team.id));
    const id = await later.acceptSwap(file, foreign.id);
    assert.equal(id, foreign.id);
    assert.equal(state.pins[file], foreign.id);
    assert.ok(!(await later.containers()).find((x) => x.id === id).error);
  } finally {
    first.close();
    later?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a file swapped under an open vault is not read into it: the vault closes and the comparison is offered', async () => {
  const { dir, make } = await setup();
  const files = make();
  try {
    const file = path.join(dir, 'Team.kvpws');
    const other = path.join(dir, 'Fremd.kvpws');
    const team = await files.create(file, 'Team', { password: 'Smoke-Pass-1234' }, 'me');
    const foreign = await files.create(other, 'Fremd', { password: 'Smoke-Pass-1234' }, 'me');
    await fs.copyFile(other, file);
    await files.reload(files.entries.get(team.id)); // what the file watcher does after a change
    assert.equal(files.entries.has(team.id), false, 'the old vault still holds the file');
    const c = (await files.containers()).find((x) => x.path === file);
    assert.equal(c.swap?.now.id, foreign.id);
    assert.equal(c.swap?.before.name, 'Team');
  } finally {
    files.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the identity of a secured file names its creator and the creator\'s safety code', async () => {
  const creator = { id: 'm1', email: 'anna@contoso.com', ecdh: 'E', sign: 'ROOT' };
  const vault = { id: 'f1', name: 'Team', secure: true, keyring: { root: 'ROOT', members: [{ id: 'm2', email: 'x@y', ecdh: 'E2', sign: 'S2' }, creator] } };
  const who = await vaultIdentity(vault);
  assert.equal(who.creator, 'anna@contoso.com');
  assert.equal(who.code, await safetyCode(creator));
});
