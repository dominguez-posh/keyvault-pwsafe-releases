// #435: taking an older state of a secured file on purpose (backup put back, update lost) – the main process side.
// Three steps, all here and nowhere in the window: prepare (what the dialog shows, a one-time token bound to the file ID,
// the SHA-256 of the refused text and the known state), unlock (app PIN and passkey, by the API; the accepted state is
// built but not written) and commit (after the wait, with the vault name typed, the file read again unchanged). The
// rules of the state itself are in extension/core/rollback-accept.js. No route from the browser, an agent or a locked
// window leads here (desktop/main/api/index.js, test/accept-older-435-surfaces.test.js).

import { createHash, randomBytes } from 'node:crypto';
import { floorOf, mergeFloors } from '../extension/core/rollback.js';
import { acceptOlder, adminPasskeys, describeOlder } from '../extension/core/rollback-accept.js';
import { parseFile } from '../extension/core/filevault.js';
import { t } from '../extension/core/i18n.js';
import { fileIo } from './files.js';

export const ACCEPT_DELAY_MS = 6000; // the wait of the release approval dialog
export const ACCEPT_TOKEN_MS = 5 * 60_000;

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const fail = (message) => {
  throw Object.assign(new Error(message), { name: 'AcceptOlderError' });
};
const changedMeanwhile = () => fail(t('Die Datei hat sich inzwischen geändert – bitte neu prüfen.'));

export class OlderStateAcceptance {
  constructor(files, { now = () => Date.now() } = {}) {
    this.files = files;
    this.now = now;
    this.tokens = new Map();
  }

  entry(id) {
    const e = this.files.entries.get(id);
    if (!e || !this.files.olderRefused(e)) fail(t('Für diesen Tresor wurde kein älterer Stand abgelehnt.'));
    return e;
  }

  floor(e) {
    return mergeFloors(this.files.pinNotes()[e.path]?.floor, e.vault ? floorOf(e.vault.doc, e.vault.roster) : null);
  }

  /** The newer state still open here (a refused reload): its document, and key and entries if it is unlocked. */
  newer(e) {
    const doc = e.vault?.doc;
    if (doc?.version !== 2) return null;
    const ck = e.vault.locked ? null : e.vault.ck;
    const items = e.vault.locked ? null : [...e.vault.items].filter(([, x]) => x.item && !x.entry.deleted).map(([id, x]) => ({ id, rev: x.entry.rev, title: x.item.title }));
    return { doc, ck, items };
  }

  async read(e) {
    const text = await fileIo(e.path).read();
    if (text == null) fail(t('Datei nicht gefunden'));
    return text;
  }

  /** → what the dialog shows, with a token for the next steps. */
  async prepare(id) {
    const e = this.entry(id);
    const text = await this.read(e);
    const floor = this.floor(e);
    const newer = this.newer(e);
    const info = await describeOlder(text, floor, newer?.doc);
    // Entries new or changed after the older state: known only if the newer state is open and unlocked here.
    const old = parseFile(text);
    const oldRevs = new Set(Object.entries(old.items || {}).flatMap(([iid, x]) => [x, ...(x.history || [])].filter((v) => v?.rev).map((v) => `${iid} ${v.rev}`)));
    const lost = newer?.items ? newer.items.filter((x) => !oldRevs.has(`${x.id} ${x.rev}`)).map((x) => x.title) : null;
    for (const [k, r] of this.tokens) if (r.id === id) this.tokens.delete(k);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { id, path: e.path, fileId: old.id, sha: sha256(text), floorSha: sha256(JSON.stringify(floor)), issued: this.now(), name: info.name, lost });
    return { token, delayMs: ACCEPT_DELAY_MS, ...info, lost };
  }

  /** A live token (one use, a few minutes). */
  check(token) {
    const rec = this.tokens.get(String(token || ''));
    if (!rec) fail(t('Die Bestätigung ist ungültig oder abgelaufen – bitte neu beginnen.'));
    if (this.now() - rec.issued > ACCEPT_TOKEN_MS) {
      this.tokens.delete(token);
      fail(t('Die Bestätigung ist ungültig oder abgelaufen – bitte neu beginnen.'));
    }
    return rec;
  }

  /** The same file and known state as shown in the dialog, read again. → { e, text, floor } */
  async same(rec) {
    const e = this.entry(rec.id);
    if (e.path !== rec.path) changedMeanwhile();
    const text = await this.read(e);
    const floor = this.floor(e);
    if (sha256(text) !== rec.sha || sha256(JSON.stringify(floor)) !== rec.floorSha || parseFile(text).id !== rec.fileId) changedMeanwhile();
    return { e, text, floor };
  }

  /**
   * Passkeys for the ceremony: only those of the older state that belong to an admin of the known state (#527) – with
   * several accounts on a device, another member's passkey could answer and the acceptance would fail. acceptOlder
   * still checks the role itself.
   */
  async passkeys(token, rpId) {
    const rec = this.check(token);
    const { text, floor } = await this.same(rec);
    return { name: rec.name, passkeys: await adminPasskeys(text, floor, rpId) };
  }

  /** After PIN and passkey: builds the accepted state (not written). → { dropped, lost, keyVersion } */
  async unlock(token, passkey) {
    const rec = this.check(token);
    const { e, text, floor } = await this.same(rec);
    const newer = this.newer(e);
    rec.result = await acceptOlder(text, floor, passkey, newer && { doc: newer.doc, ck: newer.ck, lost: rec.lost });
    return { dropped: rec.result.dropped, lost: rec.lost, keyVersion: rec.result.keyVersion };
  }

  /** Writes the accepted state: after the wait, with the vault name typed, only if the file is unchanged. → container id */
  async commit(token, name) {
    const rec = this.check(token);
    if (!rec.result) fail(t('Bitte erst mit App-PIN und Passkey bestätigen.'));
    if (this.now() - rec.issued < ACCEPT_DELAY_MS) fail(t('Bitte die Wartezeit abwarten.'));
    if (String(name || '').trim() !== String(rec.name || '').trim()) fail(t('Der eingegebene Name passt nicht zum Tresor.'));
    this.tokens.delete(token);
    const e = this.entry(rec.id);
    await this.files.serial(e.id, async () => {
      const io = fileIo(e.path);
      if (sha256(await io.read()) !== rec.sha) changedMeanwhile();
      await io.write(rec.result.text);
    });
    if (e.vault) {
      await this.files.watched(e);
      return e.id;
    }
    this.files.entries.delete(e.id);
    const fresh = await this.files.attach(e.path);
    this.files.onChange();
    return fresh.id;
  }
}
