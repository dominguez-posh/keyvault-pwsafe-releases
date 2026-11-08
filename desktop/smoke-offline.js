// Smoke check of the offline mirror (#413): what the vault says is gone can't be read offline any more, password included.
// The demo never records (session.js: mirrorWanted), so this wraps the session's fetch the way session.js does and reads
// the result as an offline start does: a new mirror from the file, with a client that has only its replay. Part of the
// feature checks (desktop/smoke-features.js), which have reached their size limit. Not covered: the OS key store, a test double here.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineMirror } from './offline.js';
import { KeyVaultClient } from '../extension/core/keyvault.js';

const PIN = '2468';
const keyStore = (buf) => Buffer.from(buf);

export async function offlineDeleteCheck({ vault, kvc, fail }) {
  const dir = await mkdtemp(join(tmpdir(), 'kvpwsafe-smoke-offline-'));
  const options = { dir, protect: keyStore, unprotect: keyStore };
  const mirror = new OfflineMirror(options);
  const online = vault.fetch;
  const ids = [];

  // As the app starts offline: only what is in the file.
  const offline = async () => {
    await mirror.save();
    const file = new OfflineMirror(options);
    await file.unlockKey(PIN);
    await file.load();
    const client = new KeyVaultClient({ vaultUrl: kvc.vaultUrl, getToken: async () => 'offline', fetch: file.replay });
    return {
      readable: (id) => client.getSecret(id).then(() => true, () => false),
      listed: async () => (await client.listSecrets()).map((s) => s.name),
      // Any URL of any version: a stored answer with this very secret value.
      holds: (value) => [...file.entries.values()].some((e) => { try { return JSON.parse(e.body).value === value; } catch { return false; } }),
    };
  };
  const add = async (title) => {
    const { id } = await vault.saveItem(kvc.id, { type: 'login', title, username: 'offline', password: `${title}-Geheim` });
    ids.push(id);
    const bundle = await vault.kv(kvc).getSecret(id);
    await vault.kv(kvc).getSecret(id, bundle.version);
    return { id, value: bundle.value };
  };

  try {
    await mirror.unlockKey(PIN);
    vault.fetch = mirror.record(online);
    const deleted = await add('Smoke Offline gelöscht');
    const elsewhere = await add('Smoke Offline anderswo');
    const kept = await add('Smoke Offline bleibt');

    // Without this the checks below would pass with nothing recorded at all.
    let view = await offline();
    for (const [what, s] of Object.entries({ deleted, elsewhere, kept })) {
      if (!(await view.readable(s.id)) || !view.holds(s.value)) fail('offlinedelete', `${what}: not in the mirror before the delete`);
    }

    await vault.deleteItem(kvc.id, deleted.id);
    view = await offline();
    if (await view.readable(deleted.id)) fail('offlinedelete', 'a deleted entry can still be read offline');
    if (view.holds(deleted.value)) fail('offlinedelete', 'the mirror file still holds the value of a deleted entry');
    if (!(await view.readable(kept.id))) fail('offlinedelete', 'deleting one entry took another out of the mirror');

    // Deleted on another device: the app only learns it from the next list.
    vault.fetch = online;
    await vault.kv(kvc).deleteSecret(elsewhere.id);
    vault.fetch = mirror.record(online);
    await vault.refreshIndex([kvc.id]);
    view = await offline();
    if (await view.readable(elsewhere.id)) fail('offlinedelete', 'an entry deleted elsewhere can still be read offline after a list');
    if (view.holds(elsewhere.value)) fail('offlinedelete', 'the mirror file still holds the value of an entry deleted elsewhere');
    const names = await view.listed();
    if (names.includes(deleted.id) || names.includes(elsewhere.id)) fail('offlinedelete', 'the offline list still names a deleted entry');
    if (!names.includes(kept.id) || !(await view.readable(kept.id))) fail('offlinedelete', 'the entry that stays is gone from the mirror');
  } finally {
    vault.fetch = online;
    mirror.lockKey();
    clearTimeout(mirror.timer);
    for (const id of ids) await vault.deleteItem(kvc.id, id).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
