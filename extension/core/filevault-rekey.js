// Container key change of a file container: everything in the document is encrypted again with the new key.

import { rekeyKeyring, KEY_CHANGE } from './protect.js';
import { t } from './i18n.js';

/** A change is always newer than the version it is based on, even within the same millisecond. */
export const stamp = (previous) => Math.max(Date.now(), (previous?.updated || 0) + 1);

/**
 * Re-encrypts items, histories, log, folders, logo, settings and folder icons of `doc` (in place) from `old` to `next`.
 * aad(id) is the vault's context string. Newer timestamps let the re-encrypted entries win the merge with the disk.
 * Parts that do not open with the old key stay as they are.
 */
export async function recryptDoc(doc, old, next, aad) {
  const recrypt = async (sealed, ctx) => {
    try {
      return await next.encrypt(await old.decrypt(sealed, ctx), ctx);
    } catch {
      return sealed;
    }
  };
  for (const [id, entry] of Object.entries(doc.items)) {
    if (!entry.data) continue;
    entry.data = await recrypt(entry.data, aad(id));
    for (const h of entry.history || []) h.data = await recrypt(h.data, aad(id));
    entry.updated = stamp(entry);
  }
  for (const e of doc.log || []) e.data = await recrypt(e.data, aad(`log/${e.id}`));
  for (const [fid, f] of Object.entries(doc.folders || {})) {
    if (f.data) f.data = await recrypt(f.data, aad(`folder/${fid}`));
    f.updated = stamp(f);
  }
  if (doc.logo?.data) doc.logo = { data: await recrypt(doc.logo.data, aad('logo')), updated: stamp(doc.logo) };
  if (doc.appSettings?.data) doc.appSettings = { data: await recrypt(doc.appSettings.data, aad('app-settings')), updated: stamp(doc.appSettings) };
  for (const [fid, f] of Object.entries(doc.folderIcons || {})) {
    if (f.data) f.data = await recrypt(f.data, aad(`folder-icon/${fid}`));
    f.updated = stamp(f);
  }
}

/**
 * Real key change of a format-1 file (#402), switched off in this version (protect.js KEY_CHANGE): new key, everything
 * re-encrypted, new master password and recovery key, format 3. One write of the whole file. → { recoveryKey, dropped }.
 */
export async function rekeyFile(vault, password, actor = '') {
  if (!KEY_CHANGE.enabled) throw new Error(t('Der Schlüsselwechsel ist in dieser Version noch nicht eingeschaltet'));
  vault.requireUnlocked();
  if (vault.secure) throw new Error(t('Abgesicherte Dateien verwalten Zugriff über Benutzer und Rollen'));
  // Changes of other devices between reading and writing are not thrown away: the file is read again and the change
  // starts over (and a key change of another device meanwhile locks this one - so two changes cannot both win).
  for (let attempt = 0; attempt < 3; attempt++) {
    await vault.load();
    vault.requireUnlocked();
    const before = structuredClone(vault.doc);
    const old = vault.ck;
    const restore = async () => {
      vault.doc = before;
      vault.ck = old;
      await vault.decryptAll().catch(() => {});
    };
    try {
      const r = await rekeyKeyring(vault.doc.keyring, old, { password }, actor);
      await recryptDoc(vault.doc, old, r.ck, (id) => vault.aad(id));
      vault.doc.keyring = r.keyring;
      vault.doc.version = 3;
      vault.doc.updated = Date.now();
      vault.ck = r.ck;
      if ((await vault.io.read()) !== vault.loadedText) {
        await restore();
        continue;
      }
      await vault.persist();
      return { recoveryKey: r.recoveryKey, dropped: r.dropped };
    } catch (e) {
      await restore();
      throw e;
    }
  }
  throw new Error(t('Die Datei wird gerade auf einem anderen Gerät geändert – bitte noch einmal versuchen'));
}
