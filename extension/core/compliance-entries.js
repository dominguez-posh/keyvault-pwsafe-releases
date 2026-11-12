// Compliance (#500 review): the age of the passwords from metadata only. Opening the compliance view must not read
// every secret value – each read counts in the read alert of #486 (core/loganalytics.js readsQuery). The listing of
// the vault (SecretList) carries the tag pc (core/model.js serializeItem); entries without it (saved before, or with
// all 15 tags in use) are estimated from their oldest version (SecretListVersions). Neither reads a value.

import { isItemSecret, passwordChangedTag, summaryFromSecret } from './model.js';
import { KEYRING_SECRET } from './session.js';
import { mapLimit } from './util.js';

/** Types that never hold a password: their row shows the last change of the entry. */
const NO_PASSWORD = /^(note|card)$/;

/**
 * session: the VaultSession. → { entries: [{ summary, hasPassword, passwordChanged, created, oldestVersion, estimated }],
 * locked } – `estimated`: no pc tag, the age is the oldest version and whether there is a password is assumed from the type.
 */
export async function entryMetadata(session, containerId, onProgress = () => {}) {
  const c = await session.container(containerId);
  const kv = session.kv(c);
  const secrets = await kv.listSecrets();
  const isProtected = secrets.some((s) => s.name === KEYRING_SECRET);
  const key = isProtected ? await session.containerKey(c.id) : null;
  if (isProtected && !key) return { entries: [], locked: true, total: secrets.filter((s) => isItemSecret(s)).length };
  const items = secrets.filter((s) => isItemSecret(s) && s.attributes?.enabled !== false);
  let done = 0;
  const entries = await mapLimit(items, 6, async (s) => {
    try {
      const tags = s.tags?.e === '1' ? await session.openTags(key, `${c.id}/${s.name}`, s.tags) : s.tags || {};
      const summary = summaryFromSecret({ ...s, tags }, c.id);
      const pc = passwordChangedTag(tags);
      const iso = (ms) => new Date(ms).toISOString();
      if (pc) return { summary, hasPassword: true, passwordChanged: pc.source === 'password' ? iso(pc.at) : '', created: pc.source === 'created' ? iso(pc.at) : '', oldestVersion: 0, estimated: false };
      if (NO_PASSWORD.test(summary.type)) return { summary, hasPassword: false, passwordChanged: '', created: '', oldestVersion: 0, estimated: false };
      const versions = await kv.listSecretVersions(s.name).catch(() => []);
      const oldest = Math.min(...versions.map((v) => (v.attributes?.created || v.attributes?.updated || 0) * 1000).filter(Boolean));
      return { summary, hasPassword: true, passwordChanged: '', created: '', oldestVersion: Number.isFinite(oldest) ? oldest : 0, estimated: true };
    } catch {
      return null;
    } finally {
      onProgress(++done, items.length);
    }
  });
  return { entries, locked: false, total: items.length };
}
