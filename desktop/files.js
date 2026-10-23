// File containers of the desktop app (adapter for VaultSession, kind "file"). Each container is one .kvpws file,
// e.g. on a network share or in OneDrive; changes by other users are picked up by watching the file.

import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { canWrite } from '../extension/core/members.js';
import { setupKeyring, unlockKeyring, applyKeyringOp, describeKeyring, passkeyEntries } from '../extension/core/protect.js';
import { t } from '../extension/core/i18n.js';

function fileIo(file) {
  return {
    async read() {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(text) {
      // Write next to the target and rename: a crash never leaves a half-written container.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, file);
    },
  };
}

export class FileContainers {
  /**
   * paths(): configured file paths, setPaths(paths), onChange(): notify UI/browser.
   * pins() / setPins(map): file ID seen per path – a file swapped for another one is refused.
   */
  constructor({ paths, setPaths, onChange, pins = () => ({}), setPins = () => {} }) {
    this.paths = paths;
    this.setPaths = setPaths;
    this.pins = pins;
    this.setPins = setPins;
    this.onChange = onChange;
    this.entries = new Map(); // id → { id, path, vault, error }
  }

  async load() {
    for (const p of this.paths()) {
      if (![...this.entries.values()].some((e) => e.path === p)) await this.attach(p).catch(() => {});
    }
  }

  async attach(filePath) {
    const vault = new FileVault(fileIo(filePath));
    let id = `missing:${filePath}`;
    let error = null;
    try {
      await vault.load();
      id = vault.id;
      const pinned = this.pins()[filePath];
      if (pinned && pinned !== id) {
        id = `missing:${filePath}`;
        throw new Error(t('Die Datei wurde gegen einen anderen Tresor ausgetauscht. Entferne sie und öffne sie neu, wenn das gewollt war.'));
      }
      if (!pinned) this.setPins({ ...this.pins(), [filePath]: id });
    } catch (e) {
      error = e.message;
    }
    const existing = [...this.entries.values()].find((e) => e.id === id && e.path !== filePath);
    if (existing) throw new Error(t('Dieser Tresor ist bereits geöffnet ({path})', { path: existing.path }));
    const entry = { id, path: filePath, vault: error ? null : vault, error };
    this.entries.set(id, entry);
    if (!error) {
      watchFile(filePath, { interval: 3000 }, (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs) entry.vault.load().then(() => this.onChange(), () => {});
      });
    }
    return entry;
  }

  get(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error(t('Tresor nicht gefunden'));
    if (!e.vault) throw new Error(e.error || t('Datei nicht gefunden'));
    return e.vault;
  }

  // ---------------------------------------------------------------- adapter interface

  async containers() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      name: e.vault?.name || path.basename(e.path),
      path: e.path,
      protected: true,
      locked: !e.vault || e.vault.locked,
      error: e.error ? { status: 0, message: e.error } : null,
      sources: ['file'],
      secure: !!e.vault?.secure,
      role: e.vault && !e.vault.locked ? e.vault.role : null,
      access: e.vault?.secure && !e.vault.locked
        ? { read: true, write: canWrite(e.vault.role), manage: e.vault.role === 'admin' }
        : { read: true, write: true, manage: true },
    }));
  }

  async summaries(id) {
    return this.get(id).summaries();
  }

  async getItem(id, itemId) {
    return this.get(id).getItem(itemId);
  }

  async saveItem(id, item, opts) {
    const saved = await this.get(id).saveItem(item, opts);
    this.onChange();
    return saved;
  }

  async deleteItem(id, itemId, actor) {
    await this.get(id).deleteItem(itemId, actor);
    this.onChange();
  }

  trash(id) {
    return this.get(id).trash();
  }

  async restore(id, itemId, actor) {
    await this.get(id).restore(itemId, actor);
    this.onChange();
  }

  purge(id, itemId) {
    return this.get(id).purge(itemId);
  }

  history(id, itemId) {
    return this.get(id).history(itemId);
  }

  getVersion(id, itemId, version) {
    return this.get(id).getVersion(itemId, version);
  }

  async passkeyCandidates(rpId) {
    return [...this.entries.values()].filter((e) => e.vault && !e.vault.locked).flatMap((e) => e.vault.passkeyCandidates(rpId));
  }

  async protectionInfo(id, rpId) {
    const vault = this.get(id);
    if (vault.secure) {
      const passkeys = vault.credentials(rpId);
      return { kind: 'file', secure: true, protected: true, locked: vault.locked, passkeys, methods: { password: false, recovery: false, passkeys: [], invites: [] } };
    }
    return { kind: 'file', protected: true, locked: vault.locked, methods: describeKeyring(vault.keyring, rpId), passkeys: passkeyEntries(vault.keyring, rpId) };
  }

  async unlock(id, params) {
    const vault = this.get(id);
    if (vault.secure) {
      if (!params.prfOutput) throw new Error(t('Diese Datei lässt sich nur mit einem Passkey öffnen'));
      const r = await vault.unlockWithPasskey(params.credentialId, params.prfOutput);
      if (!r.pending) this.onChange();
      return r.pending ? r : { via: 'passkey', role: r.role, platform: r.platform, hasPlatform: r.hasPlatform };
    }
    await vault.load();
    const r = await unlockKeyring(vault.keyring, params);
    await vault.unlock(r.ck);
    this.onChange();
    return { via: r.entry.type, entryId: r.entry.id };
  }

  async lock(id) {
    this.get(id).lock();
    this.onChange();
  }

  lockAll() {
    for (const e of this.entries.values()) e.vault?.lock();
  }

  async updateKeyring(id, op, actor) {
    const vault = this.get(id);
    if (vault.secure) throw new Error(t('Abgesicherte Dateien verwalten Zugriff über Benutzer und Rollen'));
    if (vault.locked) throw new Error(t('Der Datei-Tresor ist gesperrt'));
    const { keyring, ...extra } = await applyKeyringOp(vault.keyring, vault.ck, op, actor);
    await vault.setKeyring(keyring);
    return extra;
  }

  // ---------------------------------------------------------------- secured files: members, log, folders

  async requestAccess(id, request) {
    const r = await this.get(id).requestAccess(request);
    this.onChange();
    return r;
  }

  members(id, rpId) {
    const vault = this.get(id);
    if (!vault.secure || vault.locked) throw new Error(t('Der Datei-Tresor ist gesperrt'));
    return vault.describeMembers(rpId);
  }

  async memberOp(id, op) {
    await this.get(id).memberOp(op);
    this.onChange();
  }

  changelog(id, itemId) {
    return this.get(id).changelog(itemId);
  }

  folders(id) {
    return this.get(id).folders();
  }

  logo(id) {
    return this.get(id).logo();
  }

  license(id) {
    return this.get(id).license();
  }

  async setLicense(id, key) {
    await this.get(id).setLicense(key);
    this.onChange();
  }

  async setLogo(id, dataUrl) {
    await this.get(id).setLogo(dataUrl);
    this.onChange();
  }

  async addFolder(id, path) {
    await this.get(id).addFolder(path);
    this.onChange();
  }

  async removeFolder(id, path) {
    await this.get(id).removeFolder(path);
    this.onChange();
  }

  /** Format 1 → secured file (new ID). Returns the new ID. */
  async migrate(id, creator) {
    const entry = this.entries.get(id);
    const newId = await this.get(id).migrateToSecure(creator);
    this.entries.delete(id);
    entry.id = newId;
    this.entries.set(newId, entry);
    this.setPins({ ...this.pins(), [entry.path]: newId });
    this.onChange();
    return newId;
  }

  // ---------------------------------------------------------------- management

  /** Secured file (passkey only): the creator becomes admin. creator: { email, passkey } → { id } (unlocked). */
  async createSecure(filePath, name, creator) {
    const io = fileIo(filePath);
    if ((await io.read()) != null) throw new Error(t('Die Datei existiert bereits – zum Öffnen „Datei öffnen“ verwenden'));
    const vault = await FileVault.createSecure(io, { name, ...creator });
    await vault.persist();
    this.setPaths([...this.paths().filter((p) => p !== filePath), filePath]);
    const entry = await this.attach(filePath);
    entry.vault = vault;
    this.onChange();
    return { id: entry.id };
  }

  /** methods: { password?, passkey? } → { id, recoveryKey } – the new container is unlocked. */
  async create(filePath, name, methods, actor) {
    const io = fileIo(filePath);
    if ((await io.read()) != null) throw new Error(t('Die Datei existiert bereits – zum Öffnen „Datei öffnen“ verwenden'));
    const { vault } = await FileVault.create(io, { name, actor });
    const { keyring, ck, recoveryKey } = await setupKeyring(vault.id, methods, actor);
    vault.doc.keyring = keyring;
    await vault.persist();
    await vault.unlock(ck);
    this.setPaths([...this.paths().filter((p) => p !== filePath), filePath]);
    const entry = await this.attach(filePath);
    await entry.vault.unlock(ck);
    this.onChange();
    return { id: entry.id, recoveryKey };
  }

  async open(filePath) {
    const already = [...this.entries.values()].find((e) => e.path === filePath);
    if (already) return already.id;
    const entry = await this.attach(filePath);
    if (entry.error) {
      this.entries.delete(entry.id);
      throw new Error(entry.error);
    }
    this.setPaths([...this.paths(), filePath]);
    this.onChange();
    return entry.id;
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    unwatchFile(e.path);
    e.vault?.lock();
    this.entries.delete(id);
    this.setPaths(this.paths().filter((p) => p !== e.path));
    this.onChange();
  }

  async rename(id, name) {
    await this.get(id).rename(name);
    this.onChange();
  }

  close() {
    for (const e of this.entries.values()) unwatchFile(e.path);
  }
}
