// File container ("like KeePass"): one JSON file with the keyring and the encrypted entries. Several users
// can work with the same file (network share, OneDrive): every save re-reads the file and merges per entry
// (newest change wins, deletions are kept as tombstones), keyring entries are merged as a union.
//
// Format 1: keyring with password / passkey / recovery key / invitations (core/protect.js).
// Format 2 ("secured"): passkey-only members with roles (core/members.js). Every item version, deletion and
// log entry is signed by its author; changes without a valid signature of a member with write access at
// that time are ignored. The change log keeps every change (who, when, what) for good.

import { createKeyring, ContainerKey, mergeKeyrings } from './protect.js';
import {
  createSecureKeyring, unlockSecure, verifyRoster, applySecureOp, rekeyMembers, mergeSecureKeyrings, describeSecure, requestAccess,
  signObject, verifyObject, unwrapKey, fileIdFor, canWrite, secureCredentials,
} from './members.js';
import { normalizeItem, newItemId, summaryFromItem, normalizeFolder } from './model.js';

export { normalizeFolder };
import { t } from './i18n.js';
import { isImageDataUrl } from './image.js';

export const FILE_FORMAT = 'kvpwsafe-file';
export const FILE_EXTENSION = 'kvpws';
const HISTORY = 10;
const SECURE_HISTORY = 50;
const TOMBSTONE_DAYS = 120;
const TRACKED_FIELDS = ['type', 'title', 'username', 'password', 'urls', 'notes', 'totp', 'folder', 'favorite', 'fields', 'passkeys', 'tags'];

export class FileFormatError extends Error {
  constructor(message = t('Die Datei ist kein Keevault-Tresor')) {
    super(message);
    this.name = 'FileFormatError';
  }
}

export function parseFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new FileFormatError();
  }
  if (doc?.format !== FILE_FORMAT || !doc.keyring || typeof doc.items !== 'object') throw new FileFormatError();
  if (doc.version > 2) throw new FileFormatError(t('Die Datei stammt aus einer neueren Version von Keevault'));
  return doc;
}

const rev = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
// A change is always newer than the version it is based on, even within the same millisecond.
const stamp = (previous) => Math.max(Date.now(), (previous?.updated || 0) + 1);
const nowIso = () => new Date().toISOString();

function mergeByUpdated(disk = {}, ours = {}) {
  const out = { ...disk };
  for (const [id, entry] of Object.entries(ours)) {
    const other = out[id];
    if (!other || (entry.updated || 0) > (other.updated || 0)) out[id] = entry;
  }
  return out;
}

/** Merges a stored document (disk) with a modified one (ours): newest entry wins per item. */
export function mergeDocs(disk, ours) {
  if (!disk) return ours;
  const items = mergeByUpdated(disk.items, ours.items);
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000;
  for (const [id, entry] of Object.entries(items)) if (entry.purged && entry.updated < cutoff) delete items[id];
  const secure = ours.version === 2;
  const log = secure ? [...new Map([...(disk.log || []), ...(ours.log || [])].map((e) => [e.id, e])).values()] : undefined;
  return {
    ...disk,
    name: (ours.updated || 0) >= (disk.updated || 0) ? ours.name : disk.name,
    keyring: secure ? mergeSecureKeyrings(ours.keyring, disk.keyring) : mergeKeyrings(ours.keyring, disk.keyring),
    items,
    folders: mergeByUpdated(disk.folders, ours.folders),
    logo: (ours.logo?.updated || 0) >= (disk.logo?.updated || 0) ? ours.logo : disk.logo,
    license: ours.license || disk.license,
    ...(secure ? { log } : {}),
    updated: Math.max(disk.updated || 0, ours.updated || 0),
  };
}

/** Names of the fields that differ between two item versions (values are never logged). */
export function changedFields(before, after) {
  if (!before) return [];
  return TRACKED_FIELDS.filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
}

export class FileVault {
  /** io: { read(): Promise<string|null>, write(text): Promise<void> } */
  constructor(io) {
    this.io = io;
    this.doc = null;
    this.ck = null;
    this.items = new Map();
    this.folderList = [];
    this.identity = null;
    this.memberId = null;
    this.roster = null;
    this.ignored = 0;
  }

  static async create(io, { name, actor = '' }) {
    const id = `file-${crypto.randomUUID()}`;
    const { keyring, ck } = await createKeyring(id, actor);
    const vault = new FileVault(io);
    vault.doc = { format: FILE_FORMAT, version: 1, id, name, keyring, items: {}, folders: {}, created: Date.now(), updated: Date.now() };
    vault.ck = ck;
    return { vault, ck };
  }

  /** New secured file: the creator becomes its first admin. creator: { email, passkey } */
  static async createSecure(io, { name, email, passkey }) {
    const r = await createSecureKeyring({ email, passkey });
    const vault = new FileVault(io);
    vault.doc = { format: FILE_FORMAT, version: 2, id: r.id, name, keyring: r.keyring, items: {}, folders: {}, log: [], created: Date.now(), updated: Date.now() };
    r.ck.kv = r.keyring.keyVersion;
    Object.assign(vault, { ck: r.ck, identity: r.identity, memberId: r.memberId });
    vault.roster = await verifyRoster(r.keyring);
    await vault.addLog({ action: 'file-create', name, email });
    return vault;
  }

  get id() {
    return this.doc.id;
  }

  get name() {
    return this.doc.name;
  }

  get keyring() {
    return this.doc.keyring;
  }

  get locked() {
    return !this.ck;
  }

  get secure() {
    return this.doc?.version === 2;
  }

  /** Role of the unlocked user in a secured file (format 1: everyone may do everything). */
  get role() {
    if (!this.secure) return 'admin';
    return this.roster?.current(this.memberId)?.status === 'active' ? this.roster.current(this.memberId).role : null;
  }

  async load() {
    const text = await this.io.read();
    if (text == null) throw new Error(t('Datei nicht gefunden'));
    const doc = parseFile(text);
    if (doc.version === 2 && doc.id !== (await fileIdFor(doc.keyring.root))) {
      throw new FileFormatError(t('Die Datei wurde manipuliert: Ihre Kennung passt nicht zum Schlüssel des Erstellers'));
    }
    this.doc = doc;
    if (this.secure) {
      this.roster = await verifyRoster(doc.keyring);
      if (this.ck) await this.followKeyChange();
    }
    if (this.ck) await this.decryptAll();
    return this;
  }

  /** After a key change by an admin: unwrap the new container key with our identity (or lock if removed). */
  async followKeyChange() {
    const me = this.doc.keyring.members.find((m) => m.id === this.memberId);
    if (this.role && me?.wrapped && me.wrapped.kv === this.doc.keyring.keyVersion && me.wrapped.kv !== this.ck.kv) {
      const raw = await unwrapKey(me.wrapped, this.identity, `kvpwsafe/member-key/${this.doc.id}/${me.id}/${me.wrapped.kv}`);
      this.ck = await ContainerKey.fromRaw(raw);
      this.ck.kv = me.wrapped.kv;
    } else if (!this.role || this.ck.kv !== this.doc.keyring.keyVersion) {
      this.lock();
    }
  }

  async unlock(ck) {
    this.ck = ck instanceof ContainerKey ? ck : await ContainerKey.fromRaw(ck);
    await this.decryptAll();
  }

  /** Secured files: unlock with a member passkey. Returns { pending, safetyCode } while access is not granted yet. */
  async unlockWithPasskey(credentialId, prfOutput) {
    await this.load();
    const r = await unlockSecure(this.doc.keyring, credentialId, prfOutput);
    if (r.pending) return r;
    r.ck.kv = this.doc.keyring.keyVersion;
    Object.assign(this, { ck: r.ck, identity: r.identity, memberId: r.memberId, roster: r.roster });
    await this.decryptAll();
    return { memberId: r.memberId, role: r.role, platform: r.platform, hasPlatform: r.hasPlatform };
  }

  lock() {
    this.ck = null;
    this.identity = null;
    this.memberId = null;
    this.items.clear();
    this.folderList = [];
  }

  aad(id) {
    return `${this.doc.id}/${id}`;
  }

  memberEmail(memberId) {
    return this.doc.keyring.members?.find((m) => m.id === memberId)?.email || memberId || '';
  }

  /** Decrypts a signed format-2 payload and checks author and permission. Returns the inner object or null. */
  async openSigned(sealed, aad, check) {
    let inner;
    try {
      inner = JSON.parse(await this.ck.decrypt(sealed, aad));
    } catch {
      return null;
    }
    const { sig, ...body } = inner;
    const author = this.doc.keyring.members.find((m) => m.id === body.meta?.by);
    if (!author || !check(body.meta) || !(await verifyObject(author.sign, { file: this.doc.id, ...body }, sig))) return null;
    return body;
  }

  async sealSigned(body, aad) {
    const sig = await signObject(this.identity, { file: this.doc.id, ...body });
    return this.ck.encrypt(JSON.stringify({ ...body, sig }), aad);
  }

  async verifyOp(op) {
    if (!op?.sig) return false;
    const { sig, ...body } = op;
    const author = this.doc.keyring.members.find((m) => m.id === body.by);
    return !!author && canWrite(this.roster.roleAt(body.by, body.at)) && verifyObject(author.sign, { file: this.doc.id, ...body }, sig);
  }

  async signOp(id, op) {
    const body = { id, op, at: nowIso(), by: this.memberId };
    return { ...body, sig: await signObject(this.identity, { file: this.doc.id, ...body }) };
  }

  async decryptVersion(id, version) {
    if (!this.secure) return normalizeItem(JSON.parse(await this.ck.decrypt(version.data, this.aad(id))));
    const body = await this.openSigned(version.data, this.aad(id),
      (meta) => meta.id === id && meta.rev === version.rev && canWrite(this.roster.roleAt(meta.by, meta.at)));
    if (!body) throw new Error(t('Änderung ohne gültige Signatur'));
    return normalizeItem(body.item);
  }

  async decryptAll() {
    const items = new Map();
    let ignored = 0;
    for (const [id, entry] of Object.entries(this.doc.items)) {
      if (entry.purged || !entry.data) continue;
      if (!this.secure) {
        try {
          items.set(id, { entry, item: { ...(await this.decryptVersion(id, entry)), id } });
        } catch {
          items.set(id, { entry, item: null, broken: true });
        }
        continue;
      }
      // Newest version with a valid signature; unsigned or forged versions are skipped.
      let found = null;
      for (const version of [entry, ...(entry.history || [])]) {
        try {
          found = { item: { ...(await this.decryptVersion(id, version)), id }, version };
          break;
        } catch {
          ignored++;
        }
      }
      if (!found) continue;
      const deleted = entry.deleted && (await this.verifyOp(entry.op));
      items.set(id, { entry: { ...entry, deleted, rev: found.version.rev, updated: found.version.updated, updatedBy: found.version.updatedBy }, item: found.item });
    }
    this.items = items;
    this.ignored = ignored;
    await this.decryptFolders();
  }

  async decryptFolders() {
    const list = [];
    for (const [fid, f] of Object.entries(this.doc.folders || {})) {
      if (f.deleted) continue;
      try {
        list.push({ id: fid, path: await this.ck.decrypt(f.data, this.aad(`folder/${fid}`)) });
      } catch {
        // Unreadable (other key version): ignore.
      }
    }
    this.folderList = list;
  }

  requireUnlocked() {
    if (!this.ck) throw new Error(t('Der Datei-Tresor ist gesperrt'));
  }

  requireWrite() {
    this.requireUnlocked();
    if (!canWrite(this.role)) throw new Error(t('Du hast in dieser Datei nur Leserechte'));
  }

  decorate(id, item, entry) {
    return {
      ...item,
      id,
      key: `${this.doc.id}/${id}`,
      containerId: this.doc.id,
      version: entry.rev,
      updated: new Date(entry.updated).toISOString(),
      updatedBy: this.secure ? this.memberEmail(entry.updatedBy) : entry.updatedBy || '',
    };
  }

  summaries() {
    this.requireUnlocked();
    return [...this.items].filter(([, x]) => x.item && !x.entry.deleted)
      .map(([id, x]) => ({ ...summaryFromItem({ ...x.item, id }, this.doc.id), updated: x.entry.updated }));
  }

  getItem(id) {
    this.requireUnlocked();
    const x = this.items.get(id);
    if (!x || x.entry.deleted) throw new Error(t('Nicht gefunden'));
    if (!x.item) throw new Error(t('Daten lassen sich nicht entschlüsseln (beschädigt oder falscher Schlüssel)'));
    return this.decorate(id, x.item, x.entry);
  }

  /** Re-reads the file, merges our document into it and writes it back. */
  async persist() {
    const text = await this.io.read();
    const disk = text == null ? null : parseFile(text);
    if (this.secure && disk?.version === 2 && disk.keyring.keyVersion > this.doc.keyring.keyVersion) {
      // An admin changed the container key meanwhile: our change is encrypted with the old key.
      await this.load();
      throw new Error(t('Die Datei wurde gerade neu verschlüsselt (Benutzer entfernt). Bitte die Änderung wiederholen.'));
    }
    this.doc = mergeDocs(disk, this.doc);
    await this.io.write(JSON.stringify(this.doc, null, 1));
    if (this.secure) this.roster = await verifyRoster(this.doc.keyring);
    if (this.ck) await this.decryptAll();
  }

  // ---------------------------------------------------------------- change log (format 2)

  async addLog(payload) {
    if (!this.secure) return;
    const id = rev();
    const meta = { id, at: nowIso(), by: this.memberId };
    this.doc.log = [...(this.doc.log || []), { id, at: meta.at, by: meta.by, kv: this.ck.kv ?? this.doc.keyring.keyVersion, data: await this.sealSigned({ meta, payload }, this.aad(`log/${id}`)) }];
  }

  /** Every logged change, newest first: { at, by, email, action, ..., trusted }. */
  async changelog(itemId) {
    this.requireUnlocked();
    if (!this.secure) return [];
    const out = [];
    for (const e of this.doc.log || []) {
      const body = await this.openSigned(e.data, this.aad(`log/${e.id}`), (meta) => meta.id === e.id);
      const trusted = !!body && !!this.roster.roleAt(body.meta.by, body.meta.at);
      const entry = body ? { ...body.payload, at: body.meta.at, by: body.meta.by } : { action: 'unreadable', at: e.at, by: e.by };
      if (itemId && entry.itemId !== itemId) continue;
      out.push({ ...entry, email: this.memberEmail(entry.by), trusted });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  // ---------------------------------------------------------------- items

  async saveItem(input, { expectedVersion, actor = '' } = {}) {
    this.requireWrite();
    // Fresh state first: another user may have saved this entry since we last read the file.
    if ((await this.io.read()) != null) await this.load();
    this.requireWrite();
    const id = input.id || newItemId();
    const previous = this.doc.items[id];
    const shown = this.items.get(id);
    if (expectedVersion && previous && (shown?.entry.rev || previous.rev) !== expectedVersion) {
      const e = new Error(t('Der Eintrag wurde inzwischen von jemand anderem geändert. Bitte neu laden und erneut speichern.'));
      e.name = 'ConflictError';
      throw e;
    }
    const at = nowIso();
    const by = this.secure ? this.memberId : actor;
    const who = this.secure ? this.memberEmail(this.memberId) : actor;
    const item = normalizeItem({ ...input, id });
    const doc = {
      v: 1, ...item, id: undefined, created: item.created || at, createdBy: item.createdBy || who, updated: at, updatedBy: who,
    };
    delete doc.id;
    const r = rev();
    const data = this.secure
      ? await this.sealSigned({ meta: { id, rev: r, by, at }, item: doc }, this.aad(id))
      : await this.ck.encrypt(JSON.stringify(doc), this.aad(id));
    const keep = this.secure ? SECURE_HISTORY : HISTORY;
    const history = previous?.data ? [{ rev: previous.rev, updated: previous.updated, updatedBy: previous.updatedBy, data: previous.data }, ...(previous.history || [])].slice(0, keep) : [];
    this.doc.items[id] = { rev: r, updated: stamp(previous), updatedBy: by, data, history };
    this.doc.updated = Date.now();
    const before = shown?.item;
    await this.addLog({
      action: before ? 'item-update' : 'item-create', itemId: id, title: item.title, folder: item.folder,
      fields: changedFields(before, item), ...(before && before.folder !== item.folder ? { fromFolder: before.folder } : {}),
    });
    await this.persist();
    return this.getItem(id);
  }

  async deleteItem(id, actor = '') {
    this.requireWrite();
    const entry = this.doc.items[id];
    if (!entry) return;
    this.doc.items[id] = {
      ...entry, deleted: true, deletedAt: Date.now(), updated: stamp(entry), updatedBy: this.secure ? this.memberId : actor,
      ...(this.secure ? { op: await this.signOp(id, 'delete') } : {}),
    };
    await this.addLog({ action: 'item-delete', itemId: id, title: this.items.get(id)?.item?.title });
    await this.persist();
  }

  trash() {
    this.requireUnlocked();
    return [...this.items].filter(([, x]) => x.entry.deleted && x.item).map(([id, x]) => ({
      id, title: x.item.title, username: x.item.username, deletedDate: x.entry.deletedAt || x.entry.updated, scheduledPurgeDate: 0,
    })).sort((a, b) => b.deletedDate - a.deletedDate);
  }

  async restore(id, actor = '') {
    this.requireWrite();
    const entry = this.doc.items[id];
    if (!entry) throw new Error(t('Nicht gefunden'));
    this.doc.items[id] = {
      ...entry, deleted: false, deletedAt: undefined, updated: stamp(entry), updatedBy: this.secure ? this.memberId : actor,
      ...(this.secure ? { op: await this.signOp(id, 'restore') } : {}),
    };
    await this.addLog({ action: 'item-restore', itemId: id, title: this.items.get(id)?.item?.title });
    await this.persist();
  }

  async purge(id) {
    this.requireWrite();
    if (!this.doc.items[id]) return;
    const title = this.items.get(id)?.item?.title;
    this.doc.items[id] = { purged: true, updated: stamp(this.doc.items[id]), ...(this.secure ? { op: await this.signOp(id, 'purge') } : {}) };
    await this.addLog({ action: 'item-purge', itemId: id, title });
    await this.persist();
  }

  history(id) {
    this.requireUnlocked();
    const entry = this.doc.items[id];
    if (!entry) return [];
    return [entry, ...(entry.history || [])].map((h) => ({
      version: h.rev, updated: h.updated, enabled: true, updatedBy: this.secure ? this.memberEmail(h.updatedBy) : h.updatedBy || '',
    }));
  }

  async getVersion(id, version) {
    this.requireUnlocked();
    const entry = this.doc.items[id];
    const h = entry?.rev === version ? entry : entry?.history?.find((x) => x.rev === version);
    if (!h) throw new Error(t('Nicht gefunden'));
    return this.decorate(id, await this.decryptVersion(id, h), h);
  }

  // ---------------------------------------------------------------- folders

  /** Explicitly created folders (paths like "Kunden/Contoso"); folders of entries come from the items. */
  folders() {
    this.requireUnlocked();
    return this.folderList.map((f) => f.path);
  }

  async addFolder(path) {
    this.requireWrite();
    const clean = normalizeFolder(path);
    if (!clean) throw new Error(t('Bitte einen Ordnernamen eingeben'));
    if (this.folderList.some((f) => f.path === clean)) return;
    const fid = rev();
    this.doc.folders = { ...(this.doc.folders || {}), [fid]: { updated: Date.now(), data: await this.ck.encrypt(clean, this.aad(`folder/${fid}`)) } };
    await this.addLog({ action: 'folder-create', folder: clean });
    await this.persist();
  }

  async removeFolder(path) {
    this.requireWrite();
    const hit = this.folderList.filter((f) => f.path === path || f.path.startsWith(`${path}/`));
    for (const f of hit) this.doc.folders[f.id] = { deleted: true, updated: Date.now() };
    await this.addLog({ action: 'folder-delete', folder: path });
    await this.persist();
  }

  // ---------------------------------------------------------------- logo

  async logo() {
    this.requireUnlocked();
    if (!this.doc.logo?.data) return null;
    try {
      const url = await this.ck.decrypt(this.doc.logo.data, this.aad('logo'));
      return isImageDataUrl(url) ? url : null;
    } catch {
      return null;
    }
  }

  async setLogo(dataUrl) {
    this.requireWrite();
    if (dataUrl && !isImageDataUrl(dataUrl)) throw new Error(t('Das Bild ist zu groß'));
    this.doc.logo = { updated: Date.now(), data: dataUrl ? await this.ck.encrypt(dataUrl, this.aad('logo')) : null };
    await this.addLog({ action: dataUrl ? 'logo-set' : 'logo-remove' });
    await this.persist();
  }

  // ---------------------------------------------------------------- keyring and members

  async setKeyring(keyring) {
    this.doc.keyring = keyring;
    this.doc.updated = Date.now();
    await this.persist();
  }

  /** License key of this vault (signed, bound to the file ID – stored as is). */
  license() {
    return this.doc.license || null;
  }

  async setLicense(key) {
    this.requireWrite();
    this.doc.license = key;
    this.doc.updated = Date.now();
    await this.addLog({ action: 'license-set' });
    await this.persist();
  }

  async rename(name) {
    this.requireWrite();
    const from = this.doc.name;
    this.doc.name = name;
    this.doc.updated = Date.now();
    await this.addLog({ action: 'file-rename', from, name });
    await this.persist();
  }

  async describeMembers(rpId) {
    return describeSecure(this.doc.keyring, this.roster, this.memberId, rpId);
  }

  credentials(rpId) {
    return secureCredentials(this.doc.keyring, rpId);
  }

  /** Access request by a new user; the file stays locked for them until an admin approves. */
  async requestAccess({ email, passkey }) {
    await this.load();
    const roster = await verifyRoster(this.doc.keyring);
    const sharing = await describeSecure(this.doc.keyring, roster, null, passkey.rpId);
    if (!sharing.sharing) throw new Error(t('Die Freigabe ist für diese Datei nicht aktiviert – bitte einen Admin der Datei fragen'));
    const r = await requestAccess(this.doc.keyring, { email, passkey });
    this.doc.keyring = r.keyring;
    this.doc.updated = Date.now();
    await this.persist();
    return { memberId: r.memberId, safetyCode: r.safetyCode };
  }

  /** Member management (see applySecureOp); removing a member changes the container key. */
  async memberOp(op) {
    this.requireUnlocked();
    const ctx = { ck: this.ck, identity: this.identity, memberId: this.memberId };
    const target = op.memberId && this.memberEmail(op.memberId);
    const r = await applySecureOp(this.doc.keyring, ctx, op);
    this.doc.keyring = r.keyring;
    this.roster = await verifyRoster(this.doc.keyring);
    const log = {
      approve: { action: 'member-approve', target, role: op.role },
      setRole: { action: 'member-role', target, role: op.role },
      remove: { action: 'member-remove', target },
      reject: { action: 'member-reject', target },
      sharing: { action: op.enabled ? 'sharing-on' : 'sharing-off' },
      addCredential: { action: 'passkey-add', label: op.passkey?.label },
      removeCredential: { action: 'passkey-remove' },
    }[op.type];
    if (log) await this.addLog(log);
    if (r.rotate) await this.rotateKey();
    this.doc.updated = Date.now();
    await this.persist();
  }

  /** New container key: re-encrypts everything and wraps the key for the remaining members. */
  async rotateKey() {
    const old = this.ck;
    const next = await ContainerKey.generate();
    const recrypt = async (sealed, aad) => {
      try {
        return await next.encrypt(await old.decrypt(sealed, aad), aad);
      } catch {
        return sealed;
      }
    };
    // Newer timestamps, so that the re-encrypted entries win the merge with the file on disk.
    for (const [id, entry] of Object.entries(this.doc.items)) {
      if (!entry.data) continue;
      entry.data = await recrypt(entry.data, this.aad(id));
      for (const h of entry.history || []) h.data = await recrypt(h.data, this.aad(id));
      entry.updated = stamp(entry);
    }
    for (const e of this.doc.log || []) e.data = await recrypt(e.data, this.aad(`log/${e.id}`));
    for (const [fid, f] of Object.entries(this.doc.folders || {})) {
      if (f.data) f.data = await recrypt(f.data, this.aad(`folder/${fid}`));
      f.updated = stamp(f);
    }
    if (this.doc.logo?.data) this.doc.logo = { data: await recrypt(this.doc.logo.data, this.aad('logo')), updated: stamp(this.doc.logo) };
    this.doc.keyring = await rekeyMembers(this.doc.keyring, next);
    next.kv = this.doc.keyring.keyVersion;
    this.ck = next;
    await this.addLog({ action: 'key-rotate', keyVersion: next.kv });
  }

  /**
   * Converts an unlocked format-1 file into a secured one; the caller becomes its admin. The file gets a new
   * ID and key, the old password / recovery key / invitations stop working. Returns the new ID.
   */
  async migrateToSecure({ email, passkey }) {
    this.requireUnlocked();
    if (this.secure) throw new Error(t('Die Datei ist bereits abgesichert'));
    const items = [...this.items].filter(([, x]) => x.item && !x.entry.deleted);
    const folders = this.folderList.map((f) => f.path);
    const logo = await this.logo();
    const target = await FileVault.createSecure(this.io, { name: this.doc.name, email, passkey });
    if (logo) target.doc.logo = { updated: Date.now(), data: await target.ck.encrypt(logo, target.aad('logo')) };
    for (const [id, x] of items) {
      const r = rev();
      const at = nowIso();
      target.doc.items[id] = {
        rev: r, updated: Date.now(), updatedBy: target.memberId, history: [],
        data: await target.sealSigned({ meta: { id, rev: r, by: target.memberId, at }, item: { v: 1, ...x.item, id: undefined } }, target.aad(id)),
      };
    }
    for (const path of folders) {
      const fid = rev();
      target.doc.folders[fid] = { updated: Date.now(), data: await target.ck.encrypt(path, target.aad(`folder/${fid}`)) };
    }
    await target.addLog({ action: 'file-migrate', count: items.length, from: this.doc.id });
    await this.io.write(JSON.stringify(target.doc, null, 1));
    Object.assign(this, { doc: target.doc, ck: target.ck, identity: target.identity, memberId: target.memberId, roster: target.roster });
    await this.decryptAll();
    return this.doc.id;
  }

  /** Passkeys of all entries for an RP. */
  passkeyCandidates(rpId) {
    if (!this.ck) return [];
    const out = [];
    for (const [id, x] of this.items) {
      if (!x.item || x.entry.deleted) continue;
      for (const passkey of x.item.passkeys) if (passkey.rpId === rpId) out.push({ containerId: this.doc.id, itemId: id, title: x.item.title, passkey });
    }
    return out;
  }
}

