// File containers of the desktop app (adapter for VaultSession, kind "file"). Each container is one .kvpws file,
// e.g. on a network share or in OneDrive; changes by other users are picked up by watching the file.

import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { canWrite } from '../extension/core/members.js';
import { setupKeyring, unlockKeyring, applyKeyringOp, describeKeyring, passkeyEntries } from '../extension/core/protect.js';
import { t } from '../extension/core/i18n.js';
import { vaultIdentity } from './file-identity.js';
import { floorOf, mergeFloors, repairFromFloor } from '../extension/core/rollback.js';

const SWAPPED = () => t('In der Datei liegt ein anderer Tresor als beim letzten Öffnen. Gleiche Erstellerin und Sicherheitscode mit der Erstellerin außerhalb der App ab (Telefon oder persönlich), bevor du ihn annimmst.');

// OneDrive, the virus scanner or the indexer hold the file for a moment after each change (EPERM/EBUSY on Windows):
// the step is tried again for a while instead of failing.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
export async function retryBusy(fn, ms = 15_000) {
  const started = Date.now();
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try {
      return await fn();
    } catch (e) {
      if (!BUSY.has(e.code) || Date.now() - started > ms) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

let tmpSeq = 0;

export function fileIo(file) {
  return {
    async read() {
      try {
        return await retryBusy(() => fs.readFile(file, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(text) {
      // Write next to the target and rename: a crash never leaves a half-written container. Each write has its own
      // temporary file – two writes into one would hand a half-written file to the rename.
      const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
      await retryBusy(() => fs.writeFile(tmp, text, 'utf8'));
      try {
        await retryBusy(() => fs.rename(tmp, file));
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    },
  };
}

export class FileContainers {
  /**
   * paths(): configured file paths, setPaths(paths), onChange(): notify UI/browser.
   * pins() / setPins(map): file ID seen per path – a file swapped for another one is refused.
   */
  constructor({ paths, setPaths, onChange, pins = () => ({}), setPins = () => {}, pinNotes = () => ({}), setPinNotes = () => {}, personalPaths = () => [], locations = new Map(), onReloadError = () => {}, onRekey = () => {} }) {
    // A refused reload of a changed file is shown (container warning), not dropped (#430).
    this.onReloadError = onReloadError;
    // Creator and safety code of the vault seen per path, shown next to those of a vault that replaced it (#404).
    this.pinNotes = pinNotes;
    this.setPinNotes = setPinNotes;
    this.paths = paths;
    // The personal vault (free, one person, never local – desktop/main.js) and where each file lives.
    this.personalPaths = personalPaths;
    this.isPersonal = (p) => !!p && (this.personalPaths() || []).includes(p);
    this.locations = locations;
    this.onRekey = onRekey;
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
    let swap = null;
    // The floor remembered for this path (#432): an older state of the same secured file is refused by load().
    vault.floor = this.pinNotes()[filePath]?.floor || null;
    // After each own save (e.g. a member removed): remembered at once, not only when the watcher reads it (Konrad).
    vault.onPersisted = (v) => { if (this.pins()[filePath] === v.id) this.noteFloor(filePath, v); };
    try {
      await vault.load();
      id = vault.id;
      const pinned = this.pins()[filePath];
      if (pinned && pinned !== id) {
        // Another vault where a known one was: never taken by itself, also not after removing and opening again – only
        // after the person compared creator and safety code with the creator (acceptSwap, #404).
        swap = await this.swapInfo(filePath, pinned, vault);
        id = `missing:${filePath}`;
        throw new Error(SWAPPED());
      }
      // Remembered as secured, now in the old format under the same ID (#430): refused (the core refuses it, too).
      if (pinned && this.pinNotes()[filePath]?.secure === true && !vault.secure) {
        id = `missing:${filePath}`;
        throw new Error(t('Die Datei wurde manipuliert: ein abgesicherter Tresor im alten Format'));
      }
      if (!pinned) await this.remember(filePath, vault);
      else this.noteFloor(filePath, vault);
    } catch (e) {
      error = e.message;
    }
    const existing = [...this.entries.values()].find((e) => e.id === id && e.path !== filePath);
    if (existing) throw new Error(t('Dieser Tresor ist bereits geöffnet ({path})', { path: existing.path }));
    const entry = { id, path: filePath, vault: error ? null : vault, error, swap };
    this.entries.set(id, entry);
    if (!error) {
      watchFile(filePath, { interval: 3000 }, (cur, prev) => {
        // In the queue (#326): a reload in the middle of a save replaced the document and lost the entry being saved.
        if (cur.mtimeMs !== prev.mtimeMs) this.watched(entry);
      });
    }
    return entry;
  }

  /** The file changed on disk: read again; a refusal (tampered file) stays visible as the container's warning (#430). */
  watched(entry) {
    return this.serial(entry.id, () => this.reload(entry)).then(() => {
      if (entry.vault) this.noteFloor(entry.path, entry.vault);
      entry.warning = null;
      this.onChange();
    }, (e) => {
      entry.warning = e.message;
      this.onReloadError(entry.path, e);
      this.onChange();
    });
  }

  /** Changed on disk: the same vault is read again; another vault in its place is refused like at the start (#404). */
  async reload(entry) {
    const fresh = new FileVault(fileIo(entry.path));
    await fresh.load();
    // The same ID in the old format after the secured one (#430): FileVault.load refuses, the open vault stays as it was.
    if (fresh.id === entry.id) return entry.vault.load();
    unwatchFile(entry.path);
    entry.vault.lock();
    this.entries.delete(entry.id);
    const swapped = { id: `missing:${entry.path}`, path: entry.path, vault: null, error: SWAPPED(), swap: await this.swapInfo(entry.path, entry.id, fresh) };
    this.entries.set(swapped.id, swapped);
    return null;
  }

  async swapInfo(filePath, pinned, vault) {
    const before = this.pinNotes()[filePath] || {};
    return { path: filePath, before: { id: pinned, name: before.name || '', creator: before.creator || '', code: before.code || '' }, now: await vaultIdentity(vault) };
  }

  /** The vault seen at this path from now on: its file ID and what identifies it to a person. */
  async remember(filePath, vault) {
    const { id: _id, ...note } = await vaultIdentity(vault);
    this.setPins({ ...this.pins(), [filePath]: vault.id });
    this.setPinNotes({ ...this.pinNotes(), [filePath]: { ...note, floor: floorOf(vault.doc, vault.roster) } });
  }

  /** The highest state of this secured file seen so far, kept across restarts (#432). */
  noteFloor(filePath, vault) {
    const notes = this.pinNotes();
    const floor = mergeFloors(notes[filePath]?.floor, floorOf(vault.doc, vault.roster));
    if (!floor || JSON.stringify(floor) === JSON.stringify(notes[filePath]?.floor)) return;
    this.setPinNotes({ ...notes, [filePath]: { ...(notes[filePath] || {}), floor } });
  }

  /**
   * The person compared creator and safety code with the creator and takes the vault now at this path. id: the file ID
   * the dialog showed – a file changed again meanwhile is refused.
   */
  async acceptSwap(filePath, id) {
    const entry = [...this.entries.values()].find((e) => e.path === filePath && e.swap);
    if (!entry) throw new Error(t('Tresor nicht gefunden'));
    const vault = new FileVault(fileIo(filePath));
    await vault.load();
    if (vault.id !== id) throw new Error(t('Die Datei hat sich inzwischen wieder geändert – bitte erneut prüfen.'));
    await this.remember(filePath, vault);
    this.entries.delete(entry.id);
    const fresh = await this.attach(filePath);
    if (!this.paths().includes(filePath)) this.setPaths([...this.paths(), filePath]);
    this.onChange();
    return fresh.id;
  }

  /** Refused (at the start or on a reload) and a known state with whole grants (#446) is there to repair it from. */
  repairable(e) {
    return !!((e.error || e.warning) && !e.swap && this.pinNotes()[e.path]?.floor?.members?.length);
  }

  /**
   * #446: a file refused because a known grant was changed or taken out (anyone with write access to the share can do
   * that) is put back from the state seen here – the grants exactly as they were signed. Written only if the result
   * passes the same checks with that state; otherwise the reason is thrown and the file stays as it is. → container id
   */
  async repair(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(t('Tresor nicht gefunden'));
    const floor = mergeFloors(this.pinNotes()[entry.path]?.floor, entry.vault ? floorOf(entry.vault.doc, entry.vault.roster) : null);
    const io = fileIo(entry.path);
    await this.serial(entry.id, async () => {
      const text = await io.read();
      let fixed = null;
      try {
        fixed = text == null ? null : await repairFromFloor(JSON.parse(text), floor);
      } catch {
        fixed = null;
      }
      if (!fixed) throw new Error(t('Die Datei lässt sich nicht aus dem bekannten Stand reparieren.'));
      const probe = new FileVault({ read: async () => JSON.stringify(fixed), write: async () => {} });
      probe.floor = floor;
      await probe.load();
      if (probe.id !== this.pins()[entry.path]) throw new Error(t('Die Datei lässt sich nicht aus dem bekannten Stand reparieren.'));
      await io.write(JSON.stringify(fixed, null, 1));
    });
    if (entry.vault) {
      await this.watched(entry);
      return entry.id;
    }
    this.entries.delete(entry.id);
    const fresh = await this.attach(entry.path);
    this.onChange();
    return fresh.id;
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
      // The personal vault is called "Persönlich" / "Personal" in the app's language, whatever the file says.
      name: this.isPersonal(e.path) ? t('Persönlich') : e.vault?.name || path.basename(e.path),
      path: e.path,
      personal: this.isPersonal(e.path),
      location: this.locations.get(e.path) || null,
      protected: true,
      locked: !e.vault || e.vault.locked,
      error: e.error ? { status: 0, message: e.error } : null,
      swap: e.swap || null,
      warning: e.warning || null,
      repairable: this.repairable(e),
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

  /** One change at a time per file: parallel saves (an import) would otherwise read and write over each other. */
  serial(id, fn) {
    this.queues ??= new Map();
    const run = (this.queues.get(id) || Promise.resolve()).then(() => fn());
    this.queues.set(id, run.catch(() => {}));
    return run;
  }

  async saveItem(id, item, opts) {
    const saved = await this.serial(id, () => this.get(id).saveItem(item, opts));
    this.onChange();
    return saved;
  }

  /** Many new entries in one write (import): → [{ item } | { error }] in the order given. */
  async saveItems(id, items, opts) {
    const results = await this.serial(id, () => this.get(id).saveItems(items, opts));
    this.onChange();
    return results;
  }

  async deleteItem(id, itemId, actor) {
    await this.serial(id, () => this.get(id).deleteItem(itemId, actor));
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

  // In the vault's queue: read, change and write of the keyring belong together, or one change overwrites another (#399).
  updateKeyring(id, op, actor) {
    return this.serial(id, async () => {
      const vault = this.get(id);
      if (vault.secure) throw new Error(t('Abgesicherte Dateien verwalten Zugriff über Benutzer und Rollen'));
      if (vault.locked) throw new Error(t('Der Datei-Tresor ist gesperrt'));
      if (op?.type === 'rekey') {
        // New key (#402): the device binding (PIN) holds the old key and is renewed or dropped.
        const r = await vault.rekey(op.password, actor);
        await this.onRekey(this.entries.get(id));
        this.onChange();
        return r;
      }
      // The personal vault belongs to one person: no invitations.
      if (op?.type === 'createInvite' && this.isPersonal(this.entries.get(id)?.path)) throw new Error(t('Der persönliche Tresor lässt sich nicht teilen'));
      // ... and keeps its master password (new devices open it with it).
      if (op?.type === 'removeEntry' && this.isPersonal(this.entries.get(id)?.path)
        && vault.keyring?.entries?.find((e) => e.id === op.entryId)?.type === 'password') throw new Error(t('Das Masterpasswort des persönlichen Tresors lässt sich nicht entfernen'));
      const { keyring, ...extra } = await applyKeyringOp(vault.keyring, vault.ck, op, actor);
      await vault.setKeyring(keyring);
      return extra;
    });
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

  folderIcons(id) {
    return this.get(id).folderIcons();
  }

  async setFolderIcons(id, patch) {
    await this.serial(id, () => this.get(id).setFolderIcons(patch));
    this.onChange();
  }

  /** Settings of the app kept in a (personal) file vault: { updated, value } or null. */
  appSettings(id) {
    return this.get(id).appSettings();
  }

  async setAppSettings(id, value, updated) {
    await this.serial(id, () => this.get(id).setAppSettings(value, updated));
  }

  /** Format 1 → secured file (new ID). Returns the new ID. */
  async migrate(id, creator) {
    const entry = this.entries.get(id);
    const newId = await this.get(id).migrateToSecure(creator);
    this.entries.delete(id);
    entry.id = newId;
    this.entries.set(newId, entry);
    await this.remember(entry.path, entry.vault);
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
    Object.assign(vault, { floor: entry.vault.floor, onPersisted: entry.vault.onPersisted });
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
    // A new file on purpose, none was there: the file seen here before is gone. Its pin would refuse the new one and the
    // recovery key, made only once, would be lost with an error (#399). Only now: a failed write must leave the pin's check.
    const { [filePath]: _gone, ...pins } = this.pins();
    if (_gone) this.setPins(pins);
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
    // Another vault where a known one was (#404): listed with its notice, the person compares and accepts it there.
    // A known file refused for a changed grant, too: listed, to be repaired from the known state there (#446).
    if (entry.swap || this.repairable(entry)) {
      this.setPaths([...this.paths(), filePath]);
      this.onChange();
      return entry.id;
    }
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
