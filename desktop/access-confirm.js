// #537 2b "Immer bestätigen" (Lucas: optional, off by default): with the option on in the personal vault, every way a
// secret of a vault it covers (all vaults by default, or only the personal one) leaves the main process – showing it in
// the window, copying, auto-type, the TOTP code, filling in the browser, AI agents, moving it out – needs a fresh confirmation of the person: Windows Hello, the master password or the PIN.
// One confirmation opens exactly one use: one entry, one purpose, used up by that use and gone after a minute; nothing is
// remembered. Wrong secrets count on the shared counter of unlocking (pinGuard), Hello is asked for each use (runProof).
// An app rule, not cryptography: the vault is open in memory – it protects against someone at the unlocked device, not
// against malware (docs/ENTSCHEIDUNGEN.md). No Electron here (unit tests).

import crypto from 'node:crypto';
import { t } from '../extension/core/i18n.js';
import { totpMatches } from '../extension/core/totp.js';
import { inPinQueue } from './pin.js';
import { runProof } from './proof.js';

export const ACCESS_TTL_MS = 60_000;
/**
 * What a confirmation can be for. 'view' shows the secrets in the window, 'fill' hands them to the extension, 'move' takes
 * an entry out of its vault into another one (Konrad H2: there the rule may not hold).
 */
export const ACCESS_PURPOSES = Object.freeze(['view', 'copy', 'type', 'fill', 'agent', 'move', 'backup', 'share']);
/**
 * Konrad N-A: uses of a whole vault – a backup ('backup') and giving someone access ('share': members, guests, invites,
 * passkeys, switching protection off). Their confirmation names the vault, not an entry: itemId VAULT_WIDE.
 */
export const VAULT_PURPOSES = Object.freeze('backup share'.split(' '));
export const VAULT_WIDE = '*';
/** A move of several entries (selection, drag and drop, a folder) is confirmed once for all of them: up to this many. */
export const MOVE_MAX = 1000;
const MOVE_TTL_FACTOR = 5; // the move asks per entry about linked assets – the confirmation must outlast those questions
const REVEALED_MAX = 2000;

const fail = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });
const digest = (text) => crypto.createHash('sha256').update(String(text)).digest('base64');
const key = (containerId, itemId, purpose) => `${containerId}\n${itemId}\n${purpose}`;

/** The secret values of an entry as they could reach the clipboard (no markers, at least 3 characters). */
export const secretTexts = (item) => [
  item?.password, item?.server?.tvPassword, item?.card?.number, item?.card?.cvc, item?.card?.pin, item?.type === 'note' ? item.notes : '',
  ...(item?.fields || []).filter((f) => f.hidden || f.type === 'hidden').map((f) => f.value),
].filter((v) => typeof v === 'string' && v.length >= 3);

/**
 * Konrad M1: the calls whose answer is an entry that was just written, and where its vault is named – the window's API
 * (arguments by position) and the extension's bridge (fields of the message). Their answers are sealed in the two
 * dispatchers (main/api/index.js, main/browser.js through main/access.js answerFor), so no write hands out secrets.
 */
export const WRITE_ANSWERS = Object.freeze({
  window: { save: (a) => a[0], duplicate: (a) => a[0], restoreVersion: (a) => a[0], setPrivate: (a) => a[0], restore: (a) => a[0], move: (a) => a[1], moveWithAssets: (a) => a[1] },
  bridge: { save: (m) => m?.containerId, move: (m) => m?.toId, moveWithAssets: (m) => m?.toId },
});
/** The vault the answer of `method` lives in, when it is a write answer of that side; else null. */
export const writeAnswerVault = (side, method, args) => (Object.hasOwn(WRITE_ANSWERS[side] || {}, method) ? WRITE_ANSWERS[side][method](args) : null);

const itemLike = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string';
/** Does a write answer carry an entry (itself or as { saved })? */
export const answerHasItem = (result) => !!result && typeof result === 'object' && (itemLike(result) || itemLike(result.saved));
/** The write answer with its entry sealed by seal(item). */
export const sealedAnswer = (result, seal) => (itemLike(result?.saved) ? { ...result, saved: seal(result.saved) } : itemLike(result) ? seal(result) : result);

export class AccessConfirm {
  /**
   * strict(containerId) → Promise<boolean>: the vault wants a confirmation for every use. settings(), guard, save, verify,
   * hello: as for the other gates (desktop/main/guards.js). readItem(containerId, itemId) → the stored entry (TOTP check).
   */
  constructor({ strict, settings, guard, save, verify, hello = null, readItem = null, ttlMs = ACCESS_TTL_MS, now = Date.now, queue = inPinQueue }) {
    Object.assign(this, { strict, settings, guard, save, verify, hello, readItem, ttlMs, now, queue });
    this.grants = new Map(); // key → until
    this.revealed = new Map(); // sha256(secret) → { containerId, itemId }
    this.revealedTotp = new Map(); // "containerId\nitemId" → { containerId, itemId }
  }

  /** One fresh proof of the person (master password, PIN or { hello: true }); counts wrong secrets. → true */
  prove(proof, purpose = 'confirm') {
    return runProof(proof, { settings: this.settings(), guard: this.guard, save: this.save, verify: this.verify, hello: this.hello, purpose }, this.queue, () => true);
  }

  /**
   * The proof for one use of one entry: afterwards exactly one take(containerId, itemId, purpose) succeeds. For 'move'
   * itemId may be a list (the entries of one vault in a selection): one proof, one use for each of them.
   */
  async confirm(containerId, itemId, purpose, proof) {
    if (!ACCESS_PURPOSES.includes(purpose)) throw fail('AccessPurpose', t('Unbekannter Zweck'));
    const ids = purpose === 'move' && Array.isArray(itemId) ? [...new Set(itemId)] : [itemId];
    // A vault-wide confirmation only for the vault-wide purposes, and never one of those for a single entry.
    if (ids.some((id) => (id === VAULT_WIDE) !== VAULT_PURPOSES.includes(purpose))) throw fail('AccessPurpose', t('Unbekannter Zweck'));
    if (typeof containerId !== 'string' || !containerId || !ids.length || ids.length > MOVE_MAX || !ids.every((id) => typeof id === 'string' && id)) throw fail('AccessPurpose', t('Nicht gefunden'));
    await this.prove(proof);
    for (const id of ids) this.grant(containerId, id, purpose);
    return true;
  }

  /** A confirmation given without a typed proof (the main process asked in its own dialog and the proof held there). */
  grant(containerId, itemId, purpose) {
    this.grants.set(key(containerId, itemId, purpose), this.now() + this.ttlMs * (purpose === 'move' ? MOVE_TTL_FACTOR : 1));
  }

  /** Uses up the confirmation for this entry and purpose → true; none (or run out) → false. */
  take(containerId, itemId, purpose) {
    const k = key(containerId, itemId, purpose);
    const until = this.grants.get(k) || 0;
    this.grants.delete(k);
    return this.now() < until;
  }

  /** Before a use: the vault wants a confirmation → it must have been given for exactly this; else AccessConfirmRequired. */
  async require(containerId, itemId, purpose) {
    if (!(await this.strict(containerId))) return false;
    if (this.take(containerId, itemId, purpose)) return true;
    throw this.required(containerId, itemId, purpose);
  }

  required(containerId, itemId, purpose) {
    return fail('AccessConfirmRequired', t('Dieser Tresor verlangt für jeden Zugriff eine Bestätigung (Windows Hello, Masterpasswort oder PIN).'), { access: { containerId, itemId, purpose } });
  }

  /** The secrets of an entry handed out after a confirmation: a later copy of one of them needs a confirmation of its own. */
  noteRevealed(containerId, item) {
    if (!item?.id) return item;
    for (const v of secretTexts(item)) {
      if (this.revealed.size >= REVEALED_MAX) this.revealed.delete(this.revealed.keys().next().value);
      this.revealed.set(digest(v), { containerId, itemId: item.id });
    }
    const totp = item.totp || (item.fields || []).some((f) => f.type === 'totp' && f.value);
    if (totp) this.revealedTotp.set(`${containerId}\n${item.id}`, { containerId, itemId: item.id });
    return item;
  }

  /** The entry a text to copy comes from, when it is a secret (or current TOTP code) handed out under this rule; else null. */
  async sourceOf(text) {
    const s = String(text ?? '');
    const hit = this.revealed.get(digest(s));
    if (hit) return hit;
    if (!/^\d{6,8}$/.test(s) || !this.readItem) return null;
    for (const ref of this.revealedTotp.values()) {
      const item = await this.readItem(ref.containerId, ref.itemId).catch(() => null);
      const secrets = [item?.totp, ...(item?.fields || []).filter((f) => f.type === 'totp').map((f) => f.value)].filter(Boolean);
      for (const sec of secrets) if (await totpMatches(sec, s).catch(() => false)) return ref;
    }
    return null;
  }

  /** Before text goes to the clipboard: a secret handed out under this rule needs its own confirmation for copying. */
  async requireCopy(text) {
    const src = await this.sourceOf(text);
    if (src) await this.require(src.containerId, src.itemId, 'copy');
  }

  /** Locking the app ends every confirmation and forgets what was handed out. */
  /** Konrad (low): the move of a selection is over – confirmations it did not use end now. */
  drop(purpose) {
    for (const k of [...this.grants.keys()]) if (k.endsWith(`\n${purpose}`)) this.grants.delete(k);
  }

  clear() {
    this.grants.clear();
    this.revealed.clear();
    this.revealedTotp.clear();
  }
}
