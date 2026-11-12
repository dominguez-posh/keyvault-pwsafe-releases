// File container ("like KeePass"): one JSON file with the keyring and the encrypted entries. Several users
// can work with the same file (network share, OneDrive): every save re-reads the file and merges per entry
// (newest change wins, deletions are kept as tombstones), keyring entries are merged as a union.
//
// Format 1: keyring with password / passkey / recovery key / invitations (core/protect.js).
// Format 3 = format 1 after a key change (#402): older apps refuse it as "newer" instead of writing with the old key.
// Format 2 ("secured"): passkey-only members with roles (core/members.js). Every item version, deletion and
// log entry is signed by its author; changes without a valid signature of a member with write access at
// that time are ignored. The change log keeps every change (who, when, what) for good.

import { createKeyring, ContainerKey, mergeKeyrings, keyVersionOf, keyMatches, UnlockError } from './protect.js';
import {
  createSecureKeyring, unlockSecure, verifyRoster, applyRejections, applySecureOp, rekeyMembers, mergeSecureKeyrings, describeSecure, requestAccess,
  signObject, verifyObject, unwrapKey, fileIdFor, canWrite, secureCredentials,
} from './members.js';
import { keyChangeSigned, keyChangeAt, keyCheck, keyUnsignedMessage, mergeLosesProof } from './key-proof.js';
import { recryptDoc, rekeyFile, stamp } from './filevault-rekey.js';
import { normalizeItem, newItemId, summaryFromItem, normalizeFolder, stampPasswordChange } from './model.js';

export { normalizeFolder };
import { t } from './i18n.js';
import { isImageDataUrl } from './image.js';
import { belowFloor, floorOf, mergeFloors } from './rollback.js';

export const FILE_FORMAT = 'kvpwsafe-file';
export const FILE_EXTENSION = 'kvpws';
const HISTORY = 10;
const SECURE_HISTORY = 50;
const TOMBSTONE_DAYS = 120;
const TRACKED_FIELDS = ['type', 'title', 'username', 'password', 'urls', 'notes', 'totp', 'folder', 'favorite', 'fields', 'passkeys', 'tags'];

// ID of a secured file: derived from the creator's signing key (members.js fileIdFor), never that of an old-format file.
const SECURED_ID = /^file-[A-Za-z0-9_-]{22}$/;

export class FileFormatError extends Error {
  constructor(message = t('Die Datei ist kein Keevault-Tresor')) {
    super(message);
    this.name = 'FileFormatError';
  }
}

/**
 * The complete JSON object at the start of a damaged file: parallel saves through one temporary file (import in
 * 0.9.13/0.9.14) left a whole earlier version followed by the rest of a longer one. Null if there is none.
 */
function leadingJson(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = text.indexOf('{');
  if (start < 0 || text.slice(0, start).trim()) return null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = leadingJson(String(text));
    if (!doc) throw new FileFormatError();
  }
  if (doc?.format !== FILE_FORMAT || !doc.keyring || typeof doc.items !== 'object') throw new FileFormatError();
  if (doc.version > 3) throw new FileFormatError(t('Die Datei stammt aus einer neueren Version von Keevault'));
  return doc;
}

const rev = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
// A change is always newer than the version it is based on, even within the same millisecond.
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
  // A new key generation (#402): the disk's entries are encrypted with the old key and must not mix with ours.
  if (ours.version !== 2 && keyVersionOf(ours.keyring) > keyVersionOf(disk.keyring)) return { ...ours, updated: Math.max(disk.updated || 0, ours.updated || 0) };
  const items = mergeByUpdated(disk.items, ours.items);
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000;
  for (const [id, entry] of Object.entries(items)) if (entry.purged && entry.updated < cutoff) delete items[id];
  const secure = ours.version === 2;
  const log = secure ? [...new Map([...(disk.log || []), ...(ours.log || [])].map((e) => [e.id, e])).values()] : undefined;
  return {
    ...disk,
    // Ours, never the disk's (#430): persist() refuses a disk with another ID or an older format before merging.
    id: ours.id,
    version: ours.version,
    name: (ours.updated || 0) >= (disk.updated || 0) ? ours.name : disk.name,
    keyring: secure ? mergeSecureKeyrings(ours.keyring, disk.keyring) : mergeKeyrings(ours.keyring, disk.keyring),
    items,
    folders: mergeByUpdated(disk.folders, ours.folders),
    logo: (ours.logo?.updated || 0) >= (disk.logo?.updated || 0) ? ours.logo : disk.logo,
    folderIcons: mergeByUpdated(disk.folderIcons, ours.folderIcons),
    appSettings: (ours.appSettings?.updated || 0) >= (disk.appSettings?.updated || 0) ? ours.appSettings : disk.appSettings,
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
    vault.wrapSeen = vault.ownWrap();
    vault.roster = await verifyRoster(r.keyring);
    await vault.addLog({ action: 'file-create', name, email, keyCheck: await keyCheck(r.ck, r.id, 1) }); // #521: proof of the first key
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
    this.loadedText = text; // (key change: has the file changed since?)
    if (text == null) throw new Error(t('Datei nicht gefunden'));
    const doc = parseFile(text);
    if (doc.version === 2 && doc.id !== (await fileIdFor(doc.keyring.root))) {
      throw new FileFormatError(t('Die Datei wurde manipuliert: Ihre Kennung passt nicht zum Schlüssel des Erstellers'));
    }
    // No way back from the secured format (#430): the old one has no signed roles, so any member – also a reader –
    // holding the container key could write it and become a writer. Its IDs are random (file-<uuid>); one derived from
    // a creator's key belongs to a secured file, and a vault that read a secured file never takes an old one.
    if (doc.version !== 2 && (SECURED_ID.test(String(doc.id)) || this.doc?.version === 2)) {
      throw new FileFormatError(t('Die Datei wurde manipuliert: ein abgesicherter Tresor im alten Format'));
    }
    if (doc.version === 2) doc.keyring = await applyRejections(doc.keyring, this.known = mergeFloors(this.floor, floorOf(this.doc, this.roster))); // #432, #433, #440
    const roster = doc.version === 2 ? await verifyRoster(doc.keyring, this.known) : null; // a changed known grant: refused (#444)
    if (belowFloor(doc, this.known, roster) || roster?.tampered) throw Object.assign(new FileFormatError(roster?.tampered ? t('Die Datei wurde manipuliert: ein bekannter Eintrag der Benutzerliste wurde verändert – nicht übernommen.') : t('Die Datei ist ein älterer Stand, als hier schon gesehen wurde – nicht übernommen.')), { code: roster?.tampered ? 'tampered' : 'older' });
    const prev = [this.doc, this.roster];
    this.doc = doc;
    if (this.secure) {
      this.roster = roster;
      if (this.ck) await this.followKeyChange().catch((e) => { [this.doc, this.roster] = prev; throw e; }); // #521: refused → as before
    } else if (this.ck && !(await keyMatches(doc.keyring, this.ck))) {
      // Another device changed the key (#402): ours opens nothing here any more.
      this.lock();
    }
    if (this.ck) await this.decryptAll();
    return this;
  }

  /** After a key change by an admin: unwrap the new container key with our identity (or lock if removed). */
  async followKeyChange() {
    const me = this.doc.keyring.members.find((m) => m.id === this.memberId);
    // #435 (Konrad): the same generation with another wrapping for us is a key change too (an older state taken on purpose).
    if (this.role && me?.wrapped && me.wrapped.kv === this.doc.keyring.keyVersion && (me.wrapped.kv !== this.ck.kv || this.ownWrap() !== this.wrapSeen)) {
      const ck = await ContainerKey.fromRaw(await unwrapKey(me.wrapped, this.identity, `kvpwsafe/member-key/${this.doc.id}/${me.id}/${me.wrapped.kv}`));
      // #521: the wrapping is not signed – the key counts only with an admin's signed log entry it opens.
      if (!(await keyChangeSigned(this.doc, ck, this.roster, me.wrapped.kv))) throw Object.assign(new FileFormatError(keyUnsignedMessage()), { code: 'key-unsigned' });
      this.ck = ck;
      this.ck.kv = me.wrapped.kv;
      this.wrapSeen = this.ownWrap();
    } else if (!this.role || this.ck.kv !== this.doc.keyring.keyVersion) {
      this.lock();
    }
  }

  async unlock(ck) {
    const key = ck instanceof ContainerKey ? ck : await ContainerKey.fromRaw(ck);
    // A key from before a key change (PIN binding of this device, an old session) is refused clearly (#402).
    if (!this.secure && !(await keyMatches(this.doc.keyring, key))) throw new UnlockError(t('Der Schlüssel dieses Tresors wurde gewechselt – bitte mit dem neuen Masterpasswort oder dem neuen Wiederherstellungsschlüssel entsperren'));
    this.ck = key;
    if (!this.secure) this.ck.kv = keyVersionOf(this.doc.keyring);
    await this.decryptAll();
  }

  /** Secured files: unlock with a member passkey. Returns { pending, safetyCode } while access is not granted yet. */
  async unlockWithPasskey(credentialId, prfOutput) {
    await this.load();
    const r = await unlockSecure(this.doc.keyring, credentialId, prfOutput, this.known);
    if (r.pending) return r;
    if (!(await keyChangeSigned(this.doc, r.ck, r.roster, this.doc.keyring.keyVersion))) throw new UnlockError(keyUnsignedMessage()); // #521
    r.ck.kv = this.doc.keyring.keyVersion;
    Object.assign(this, { ck: r.ck, identity: r.identity, memberId: r.memberId, roster: r.roster });
    this.wrapSeen = this.ownWrap();
    await this.decryptAll();
    return { memberId: r.memberId, role: r.role, platform: r.platform, hasPlatform: r.hasPlatform };
  }

  /** Our own wrapping of the container key as stored (#435: compared to notice a key change of the same generation). */
  ownWrap(doc = this.doc) {
    return JSON.stringify(doc?.keyring?.members?.find((m) => m.id === this.memberId)?.wrapped ?? null);
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
    const author = this.roster?.current(body.meta?.by)?.member; // #521: the member whose grants were checked
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
    const author = this.roster?.current(body.by)?.member; // #521
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
    const icons = [];
    for (const [fid, f] of Object.entries(this.doc.folderIcons || {})) {
      if (f.deleted) continue;
      try {
        const { path, icon } = JSON.parse(await this.ck.decrypt(f.data, this.aad(`folder-icon/${fid}`)));
        icons.push({ id: fid, path, icon, updated: f.updated || 0 });
      } catch {
        // Unreadable (other key version): ignore.
      }
    }
    this.folderIconList = icons.sort((a, b) => a.updated - b.updated);
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
    // Format and ID never come from the disk (#430): another vault or an older format there is refused, not merged –
    // otherwise a member could drop an old-format file under this ID and the next change would save it as such.
    const upgrade = this.doc.version === 3 /* format 1 becomes 3 by a key change (#402) */ && (disk?.version || 1) === 1;
    if (disk && (disk.id !== this.doc.id || ((disk.version || 1) < (this.doc.version || 1) && !upgrade))) {
      throw new FileFormatError(t('Die Datei wurde manipuliert: Format oder Kennung haben sich geändert – nichts gespeichert.'));
    }
    if (!this.secure && disk && keyVersionOf(disk.keyring) > keyVersionOf(this.doc.keyring)) {
        await this.load();
      this.lock();
      throw new Error(t('Der Schlüssel dieses Tresors wurde auf einem anderen Gerät gewechselt. Bitte mit dem neuen Masterpasswort neu entsperren und die Änderung wiederholen.'));
    }
    if (this.secure && disk?.version === 2 && (disk.keyring.keyVersion > this.doc.keyring.keyVersion
      || (this.memberId && disk.keyring.keyVersion === this.doc.keyring.keyVersion && this.ownWrap(disk) !== this.ownWrap()))) {
      // An admin changed the container key meanwhile (#435: also within the same generation): our change is encrypted with the old key.
      await this.load();
      throw new Error(t('Die Datei wurde gerade neu verschlüsselt (Benutzer entfernt). Bitte die Änderung wiederholen.'));
    }
    const known = this.secure ? mergeFloors(this.floor, floorOf(this.doc, this.roster)) : null;
    const merged = mergeDocs(disk, this.doc);
    if (this.secure) merged.keyring = await applyRejections(merged.keyring, known); // what we held counted, the disk's is new (#440)
    // #523: a merge that takes the proof of our key away (key-proof.js mergeLosesProof) is not written.
    if (this.secure && disk && this.ck && (await mergeLosesProof(this, merged, await verifyRoster(merged.keyring, known)))) {
      await this.load(); // usually refuses itself: the disk is an older state than this device has seen
      throw new Error(t('In der Datei wurde inzwischen der Admin entfernt, der den Tresor-Schlüssel dieses Geräts gesetzt hat. Es wurde nichts gespeichert – bitte die Datei neu öffnen.'));
    }
    [this.known, this.doc] = [known, merged];
    await this.io.write(JSON.stringify(this.doc, null, 1));
    if (this.secure) this.roster = await verifyRoster(this.doc.keyring, this.known);
    if (this.ck) await this.decryptAll();
    this.onPersisted?.(this); // the app remembers the state just written (desktop: rollback floor, #432)
  }

  // ---------------------------------------------------------------- change log (format 2)

  async addLog(payload, at = nowIso()) {
    if (!this.secure) return;
    const id = rev();
    const meta = { id, at, by: this.memberId };
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
    await this.stage(id, input, actor);
    await this.persist();
    return this.getItem(id);
  }

  /**
   * New entries in one read and one write (#326 – an import of hundreds of entries otherwise reads, decrypts and writes
   * the whole file once per entry). → [{ item } | { error }] in the order given; one broken entry stops none of the others.
   */
  async saveItems(inputs, { actor = '' } = {}) {
    this.requireWrite();
    if ((await this.io.read()) != null) await this.load();
    this.requireWrite();
    const staged = [];
    for (const input of inputs) {
      try {
        const id = newItemId();
        await this.stage(id, { ...input, id }, actor);
        staged.push({ id });
      } catch (e) {
        staged.push({ error: e.message });
      }
    }
    await this.persist();
    return staged.map((s) => (s.error ? s : { item: this.getItem(s.id) }));
  }

  /** Encrypts one entry into the document (not yet written). */
  async stage(id, input, actor) {
    const previous = this.doc.items[id];
    const shown = this.items.get(id);
    const at = nowIso();
    const by = this.secure ? this.memberId : actor;
    const who = this.secure ? this.memberEmail(this.memberId) : actor;
    const stored = shown && { password: shown.item ? shown.item.password ?? '' : null, passwordChanged: shown.item?.passwordChanged || '' };
    const item = normalizeItem({ ...input, id, passwordChanged: stampPasswordChange(input, stored) }); // #500: date never from the input
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

  /** Symbols of the folders: { [path]: symbol } (the newest record of a path wins). */
  folderIcons() {
    this.requireUnlocked();
    return Object.fromEntries((this.folderIconList || []).map((f) => [f.path, f.icon]));
  }

  /** patch: { [path]: symbol | '' } (already checked by the caller). */
  async setFolderIcons(patch) {
    this.requireWrite();
    this.doc.folderIcons = { ...(this.doc.folderIcons || {}) };
    for (const [path, value] of Object.entries(patch)) {
      for (const f of (this.folderIconList || []).filter((x) => x.path === path)) this.doc.folderIcons[f.id] = { deleted: true, updated: stamp(this.doc.folderIcons[f.id]) };
      if (!value) continue;
      const fid = rev();
      this.doc.folderIcons[fid] = { updated: Date.now(), data: await this.ck.encrypt(JSON.stringify({ path, icon: value }), this.aad(`folder-icon/${fid}`)) };
    }
    await this.persist();
  }

  async removeFolder(path) {
    this.requireWrite();
    const hit = this.folderList.filter((f) => f.path === path || f.path.startsWith(`${path}/`));
    for (const f of hit) this.doc.folders[f.id] = { deleted: true, updated: Date.now() };
    for (const f of (this.folderIconList || []).filter((x) => x.path === path || x.path.startsWith(`${path}/`))) {
      this.doc.folderIcons[f.id] = { deleted: true, updated: stamp(this.doc.folderIcons[f.id]) };
    }
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

  // ---------------------------------------------------------------- app settings (personal vault)

  /** Settings of the desktop app kept in this file: { updated, value } or null (none, or not readable). */
  async appSettings() {
    this.requireUnlocked();
    const rec = this.doc.appSettings;
    if (!rec?.data) return null;
    try {
      return { updated: rec.updated, value: JSON.parse(await this.ck.decrypt(rec.data, this.aad('app-settings'))) };
    } catch {
      return null;
    }
  }

  async setAppSettings(value, updated = Date.now()) {
    this.requireWrite();
    this.doc.appSettings = { updated, data: await this.ck.encrypt(JSON.stringify(value), this.aad('app-settings')) };
    await this.persist();
  }

  // ---------------------------------------------------------------- keyring and members

  async setKeyring(keyring) {
    this.doc.keyring = keyring;
    this.doc.updated = Date.now();
    await this.persist();
  }

  /**
   * Real key change of a format-1 file (#402): new key, everything re-encrypted, new master password and recovery key.
   * One write of the whole file: stopped before it, the old state stays whole. Returns { recoveryKey, dropped }.
   */
  rekey(password, actor = '') { return rekeyFile(this, password, actor); }

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
    const roster = await verifyRoster(this.doc.keyring, this.known);
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
    const ctx = { ck: this.ck, identity: this.identity, memberId: this.memberId, known: this.known };
    const target = op.memberId && this.memberEmail(op.memberId);
    const r = await applySecureOp(this.doc.keyring, ctx, op);
    const undo = r.rotate && [structuredClone(this.doc), this.ck, this.roster, this.wrapSeen];
    this.doc.keyring = r.keyring;
    this.roster = await verifyRoster(this.doc.keyring, this.known);
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
    // #521: our own proof of the new key must count for every member – checked before anything is written.
    if (r.rotate && !(await keyChangeSigned(this.doc, this.ck, this.roster, this.ck.kv))) {
      [this.doc, this.ck, this.roster, this.wrapSeen] = undo;
      throw new Error(t('Der Schlüsselwechsel ließ sich nicht gültig nachweisen (Uhrzeit dieses Geräts prüfen) – nichts gespeichert.'));
    }
    this.doc.updated = Date.now();
    await this.persist();
  }

  /** New container key: re-encrypts everything and wraps the key for the remaining members. */
  async rotateKey() {
    const old = this.ck;
    const next = await ContainerKey.generate();
    await recryptDoc(this.doc, old, next, (id) => this.aad(id));
    this.doc.keyring = await rekeyMembers(this.doc.keyring, next, this.known);
    next.kv = this.doc.keyring.keyVersion;
    this.ck = next;
    this.wrapSeen = this.ownWrap();
    // The proof of the new key (#521): signed, with its key check, dated after the removal just signed.
    await this.addLog({ action: 'key-rotate', keyVersion: next.kv, keyCheck: await keyCheck(next, this.doc.id, next.kv) }, keyChangeAt(this.roster, this.memberId));
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
    Object.assign(this, { doc: target.doc, ck: target.ck, identity: target.identity, memberId: target.memberId, roster: target.roster, wrapSeen: target.wrapSeen });
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

