import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileContainers } from '../desktop/files.js';

// #526: the watcher reloads a file vault when the file changed on disk. A change that bypassed the per-file queue could
// run while such a reload was under way: the reload then put the document read before the write back in memory, and the
// change was gone in the app (smoke 0.9.33: a team file's access request, logo or folder missing right after saving).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The open vault's next reload reads the file at its start and takes 300 ms before it uses what it read. */
function slowReload(vault) {
  const load = vault.load.bind(vault);
  let started;
  const read = new Promise((r) => { started = r; });
  vault.load = async () => {
    const io = vault.io;
    const text = await io.read();
    started();
    await sleep(300);
    vault.io = { ...io, read: async () => text };
    try {
      return await load();
    } finally {
      vault.io = io;
      vault.load = load;
    }
  };
  return read;
}

for (const [name, change, check] of [
  ['logo', (c, id) => c.setLogo(id, PNG), async (c, id) => assert.equal(await c.logo(id), PNG)],
  ['folder', (c, id) => c.addFolder(id, 'Neu'), async (c, id) => assert.ok(c.folders(id).includes('Neu'))],
  ['name', (c, id) => c.rename(id, 'Umbenannt'), async (c, id) => assert.equal((await c.containers()).find((x) => x.id === id)?.name, 'Umbenannt')],
]) {
  test(`file vault: a change (${name}) during the watcher's reload stays in memory (#526)`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-queue-'));
    let paths = [];
    const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
    try {
      const { id } = await containers.create(path.join(dir, 'Team.kvpws'), 'Team', { password: 'Smoke-Pass-1234' }, 'me');
      const entry = containers.entries.get(id);
      const read = slowReload(entry.vault);
      const reload = containers.watched(entry); // as the watcher does after a write it saw
      await Promise.race([read, sleep(1000)]); // the reload has read the file (or waits in the queue)
      await change(containers, id);
      await reload;
      await check(containers, id);
    } finally {
      containers.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
