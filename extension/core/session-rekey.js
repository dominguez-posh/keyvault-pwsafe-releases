// Key change of a Key Vault container (#402): every sealed secret is encrypted again with the new container key.
// Many writes, no transaction: the keyring is written first and keeps the old key sealed under the new one
// (keyring.prev); only when every secret is done does it go. Stopped halfway, any unlocked session resumes.

import { rekeyKeyring, previousKey, finishRekey, keyMatches, keyVersionOf, ContainerLockedError } from './protect.js';
import { t } from './i18n.js';
import { isItemSecret } from './model.js';
import { isIndexSecret } from './fastindex.js';
import { mapLimit } from './util.js';

// The same names as in session.js (the test of the key change opens every kind of them with the new key).
const SEALED = 'kvpwsafe-sealed';
const FOLDERS_SECRET = 'pws-folders';
const LOGO_SECRET = 'pws-logo';
const CONTAINER_SECRET = 'pws-container';
const KEYRING_SECRET = 'pws-keyring';

const isSealed = (value) => typeof value === 'string' && value.startsWith(`{"${SEALED}"`);

/** New key for a protected Key Vault container → { recoveryKey, dropped, failed }. s = the VaultSession. */
export async function rekeyKeyvault(s, c, password, actor) {
  const old = await s.requireKey(c.id);
  const keyring = await s.readKeyring(c);
  if (!keyring) throw new Error('not protected');
  if (keyring.prev) throw new Error('A key change is still unfinished – unlock the vault to finish it first');
  const r = await rekeyKeyring(keyring, old, { password, keepPrev: true }, actor);
  await s.writeKeyring(c, r.keyring);
  await s.store.set(`ck:${c.id}`, r.ck.exported);
  s.keys.delete(c.id);
  const failed = await finishKeyChange(s, c, r.ck);
  return { recoveryKey: r.recoveryKey, dropped: r.dropped, failed };
}

const CHECK_FRESH_MS = 3000;

/**
 * The key for SEALING (an entry, folders, logo, index): the one of this session, but only while it is still the one of the
 * keyring's current generation (#402). Another device may have changed the key meanwhile; then this session forgets its
 * key and nothing is sealed with the old one (the entry would be lost: the new key cannot open it). The check is
 * remembered per container for a few seconds and per key generation. quiet: null instead of an error.
 */
export async function currentKey(s, containerId, { quiet = false } = {}) {
  const key = await s.containerKey(containerId);
  if (!key) {
    if (quiet) return null;
    throw new ContainerLockedError();
  }
  const seen = (s.keyChecks ||= new Map());
  const hit = seen.get(containerId);
  if (hit && hit.key === key.exported && Date.now() - hit.at < CHECK_FRESH_MS) return key;
  const keyring = await s.readKeyring(await s.container(containerId));
  if (keyring && !(await keyMatches(keyring, key))) {
    await dropStaleKey(s, containerId, keyring);
    seen.delete(containerId);
    if (quiet) return null;
    throw new ContainerLockedError(t('Der Schlüssel dieses Tresors wurde auf einem anderen Gerät gewechselt – bitte neu entsperren'));
  }
  seen.set(containerId, { key: key.exported, at: Date.now(), generation: keyring ? keyVersionOf(keyring) : 0 });
  return key;
}

/** The container key of this session, or null – and forgotten – when another device changed the key since (#402). */
export async function dropStaleKey(s, containerId, keyring) {
  const key = await s.containerKey(containerId);
  if (!key || (await keyMatches(keyring, key))) return key;
  await s.store.remove(`ck:${containerId}`);
  s.keys.delete(containerId);
  return null;
}

/** Switches off the versions of a secret older than `keep`. Without the right to change attributes they stay (best effort). */
async function disableOlder(kv, name, keep) {
  try {
    // Only versions older than `keep`: one written meanwhile (newer) stays readable. Same second or unknown: stays too.
    const versions = await kv.listSecretVersions(name);
    const since = versions.find((v) => v.version === keep)?.attributes?.created;
    if (since == null) return;
    for (const v of versions) if (v.version !== keep && v.attributes?.created < since) await kv.disableSecretVersion(name, v.version);
  } catch {
    // The keyring change is done all the same.
  }
}

/** Re-encrypts what is still under the old key (all of it, or the rest after an interruption) → names that failed. */
export async function finishKeyChange(s, c, ck) {
  const keyring = await s.readKeyring(c);
  const old = keyring && await previousKey(keyring, ck);
  if (!keyring?.prev || !old || !(await keyMatches(keyring, ck))) return [];
  const kv = s.kv(c);
  const failed = [];
  // Opens with the new key (done already) or, if not, with the old one.
  const open = async (text, aad) => {
    try {
      return { plain: await ck.decrypt(text, aad), done: true };
    } catch {
      return { plain: await old.decrypt(text, aad), done: false };
    }
  };
  const latest = new Map(); // name -> the version that stays (from the vault's answer, not guessed from a time stamp)
  const secrets = await kv.listSecrets();
  await mapLimit(secrets, 4, async (secret) => {
    const name = secret.name;
    try {
      if (isIndexSecret(name)) return;
      if (name === CONTAINER_SECRET) {
        const meta = JSON.parse((await kv.getSecret(name)).value);
        if (!meta?.logo?.sealed) return;
        const aad = `${c.id}/${CONTAINER_SECRET}/logo`;
        const r = await open(meta.logo.sealed, aad);
        if (r.done) return;
        await s.writeContainerMeta(kv, { logo: { sealed: await ck.encrypt(r.plain, aad) } });
        return;
      }
      const itemSecret = isItemSecret(secret);
      if (!itemSecret && name !== FOLDERS_SECRET && name !== LOGO_SECRET) return;
      const bundle = await kv.getSecret(name);
      if (!isSealed(bundle.value)) return;
      const aad = `${c.id}/${name}`;
      const r = await open(itemSecret ? JSON.parse(bundle.value).data : JSON.parse(bundle.value)[SEALED], aad);
      if (r.done) {
        latest.set(name, bundle.version); // also those done before a stop: their older versions go now
        return;
      }
      const value = JSON.stringify(itemSecret ? { [SEALED]: 1, data: await ck.encrypt(r.plain, aad) } : { [SEALED]: await ck.encrypt(r.plain, aad) });
      const tags = itemSecret ? await s.sealTags(ck, aad, await s.openTags(old, aad, bundle.tags || {})) : bundle.tags;
      latest.set(name, (await kv.setSecret(name, value, { contentType: bundle.contentType, tags })).version);
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  });
  if (failed.length) return failed;
  // Older versions of what was rewritten still hold the old key's ciphertext: disabled (kept for the audit, unreadable).
  await mapLimit([...latest], 3, ([name, version]) => disableOlder(kv, name, version));
  await s.writeKeyring(c, finishRekey(keyring));
  // The keyring versions from before hold the old wrappers (old recovery key + such a version = the old key): off too.
  await disableOlder(kv, KEYRING_SECRET, (await kv.getSecret(KEYRING_SECRET)).version);
  await s.purgeFastIndex(kv);
  await s.dropItemCache(c.id);
  await s.refreshIndex([c.id]);
  await s.writeFastIndex(c.id).catch(() => {});
  return failed;
}
