// Offline read mode: an encrypted mirror of the Key Vault answers the app has seen (secret lists and secrets), so
// entries can still be read without a network. Off by default, needs an app PIN, and can be forbidden by policy.
// The mirror is written only while the app is unlocked with the PIN. AES-256-GCM with a key that needs BOTH the
// Windows user profile (a random secret protected by the OS key store / DPAPI) AND the PIN (PBKDF2) – neither
// alone opens it. Writes are refused offline; the app only replays what it recorded.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { t } from '../extension/core/i18n.js';

const pbkdf2 = promisify(crypto.pbkdf2);
const MAGIC = Buffer.from('KVOM');
const PIN_ITERATIONS = 200_000;

export class OfflineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfflineError';
  }
}

const isVaultUrl = (url) => /^https:\/\/[^/]+\.vault\.azure\.net\//i.test(String(url));

/** Errors that mean "no network" rather than "sign-in refused". */
export const isNetworkError = (e) => /network|ENOTFOUND|ECONN|EAI_AGAIN|fetch failed|offline|timed ?out|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/i
  .test(`${e?.errorCode || ''} ${e?.code || ''} ${e?.message || ''}`);

export class OfflineMirror {
  /** protect/unprotect(Buffer) → Buffer: the OS key store (Electron safeStorage) – injected so tests run without Electron. */
  constructor({ dir, protect, unprotect, now = Date.now }) {
    this.dataFile = path.join(dir, 'offline.bin');
    this.keyFile = path.join(dir, 'offline.key');
    this.protect = protect;
    this.unprotect = unprotect;
    this.now = now;
    this.entries = new Map(); // URL → { status, type, body }
    this.containers = [];
    this.key = null; // derived data key, RAM only, after a PIN unlock
    this.at = 0;
    this.timer = null;
  }

  get ready() {
    return !!this.key;
  }

  async exists() {
    return !!(await fs.stat(this.dataFile).catch(() => null));
  }

  /** After a verified PIN: derives the data key from the OS-protected secret and the PIN (created on first use). */
  async unlockKey(pin) {
    let secret;
    try {
      secret = await this.unprotect(await fs.readFile(this.keyFile));
      if (secret.length !== 32) throw new Error('bad secret');
    } catch {
      secret = crypto.randomBytes(32);
      await fs.mkdir(path.dirname(this.keyFile), { recursive: true });
      await fs.writeFile(this.keyFile, await this.protect(secret));
    }
    const salt = secret.subarray(0, 16);
    const pinKey = await pbkdf2(String(pin), salt, PIN_ITERATIONS, 32, 'sha256');
    this.key = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([secret, pinKey]), salt, 'keevault-offline-mirror', 32));
  }

  lockKey() {
    this.key = null;
  }

  /** PIN change: re-encrypt the mirror for the new PIN (nothing to do without a mirror). */
  async rekey(oldPin, newPin) {
    if (await this.exists()) {
      await this.unlockKey(oldPin);
      await this.load();
    }
    await this.unlockKey(newPin);
    if (this.entries.size) await this.save();
  }

  async remove() {
    clearTimeout(this.timer);
    this.entries.clear();
    this.containers = [];
    this.key = null;
    await fs.rm(this.dataFile, { force: true });
    await fs.rm(this.keyFile, { force: true });
  }

  /** fetch wrapper: records every successful GET to a Key Vault while the key is available. */
  record(fetch) {
    return async (url, init = {}) => {
      const res = await fetch(url, init);
      const method = String(init.method || 'GET').toUpperCase();
      if (this.key && method === 'GET' && res.ok && isVaultUrl(url)) {
        const body = await res.clone().text();
        this.entries.set(String(url), { status: res.status, type: res.headers.get('content-type') || 'application/json', body });
        this.schedule();
      }
      return res;
    };
  }

  /** fetch replacement without network: answers GETs from the mirror and refuses every change. */
  replay = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET') throw new OfflineError(t('Offline – Änderungen sind erst wieder mit Netzwerk möglich.'));
    const e = this.entries.get(String(url));
    if (!e) throw new OfflineError(t('Offline – dieser Eintrag liegt nicht im Offline-Speicher.'));
    return new Response(e.body, { status: e.status, headers: { 'content-type': e.type } });
  };

  /** The vault list to start from offline (no discovery possible). */
  setContainers(list) {
    this.containers = list.filter((c) => c.kind === 'keyvault').map((c) => ({ name: c.name, vaultUrl: c.vaultUrl, tenantId: c.tenantId || null, resourceId: c.resourceId || null }));
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save().catch(() => {}), 2000);
    this.timer.unref?.();
  }

  async save() {
    if (!this.key) return false;
    clearTimeout(this.timer);
    const plain = Buffer.from(JSON.stringify({ v: 1, at: this.now(), containers: this.containers, entries: [...this.entries] }));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    await fs.writeFile(this.dataFile, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]));
    return true;
  }

  /** → { at, containers, entries }; throws with a wrong PIN (GCM tag) or without a mirror. */
  async load() {
    if (!this.key) throw new OfflineError(t('Bitte zuerst die PIN eingeben'));
    const raw = await fs.readFile(this.dataFile);
    if (!raw.subarray(0, 4).equals(MAGIC)) throw new OfflineError(t('Der Offline-Speicher ist beschädigt.'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(4, 16));
    decipher.setAuthTag(raw.subarray(16, 32));
    let doc;
    try {
      doc = JSON.parse(Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]).toString());
    } catch {
      throw new OfflineError(t('Der Offline-Speicher lässt sich mit dieser PIN nicht öffnen.'));
    }
    this.at = doc.at || 0;
    this.containers = doc.containers || [];
    this.entries = new Map(doc.entries || []);
    return { at: this.at, containers: this.containers.length, entries: this.entries.size };
  }
}
