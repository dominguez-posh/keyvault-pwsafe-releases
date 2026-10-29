// Entra ID sign-in for the mobile app: OAuth 2.0 device code flow with Microsoft's public Azure CLI client (no app
// registration needed, same as the desktop app), tokens per resource through the refresh token. Network calls go
// through Capacitor's native HTTP (no CORS limits: Key Vault sends no CORS headers). Tokens live in memory; the
// refresh token is kept only AES-GCM-encrypted with a key from the app PIN (PBKDF2) in the app's preferences.

import { Preferences } from '@capacitor/preferences';

export const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
export const KV_SCOPE = 'https://vault.azure.net/user_impersonation';
export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const LOGIN = 'https://login.microsoftonline.com';
const STORE_KEY = 'keevault.session';
const PIN_KEY = 'keevault.pin';
const PBKDF2_ITERATIONS = 310_000;

const form = (data) => Object.entries(data).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);

async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', utf8(String(pin).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export class Auth {
  constructor({ tenant = 'organizations' } = {}) {
    this.tenant = tenant;
    this.refreshToken = null;
    this.account = null; // { name, username, tenantId }
    this.tokens = new Map(); // scope → { token, expires }
    this.pending = new Map();
  }

  get signedIn() {
    return !!this.refreshToken;
  }

  async post(path, data) {
    const res = await fetch(`${LOGIN}/${this.tenant}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body.error !== 'authorization_pending' && body.error !== 'slow_down') throw Object.assign(new Error(body.error_description || body.error || `HTTP ${res.status}`), { code: body.error });
    return body;
  }

  /** Step 1: → { userCode, verificationUri, message, interval } */
  async startDeviceCode() {
    const r = await this.post('/oauth2/v2.0/devicecode', { client_id: CLIENT_ID, scope: `${KV_SCOPE} offline_access openid profile` });
    this.device = { code: r.device_code, interval: (r.interval || 5) * 1000, expires: Date.now() + (r.expires_in || 900) * 1000 };
    return { userCode: r.user_code, verificationUri: r.verification_uri, message: r.message, interval: r.interval || 5 };
  }

  /** Step 2: polls until the user signed in (or the code expired / was cancelled). */
  async waitForDeviceCode({ cancelled = () => false } = {}) {
    while (!cancelled()) {
      if (Date.now() > this.device.expires) throw new Error('Der Code ist abgelaufen – bitte erneut anmelden.');
      await new Promise((r) => setTimeout(r, this.device.interval));
      const r = await this.post('/oauth2/v2.0/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: this.device.code });
      if (r.error === 'authorization_pending') continue;
      if (r.error === 'slow_down') {
        this.device.interval += 5000;
        continue;
      }
      this.accept(r, KV_SCOPE);
      return this.account;
    }
    throw new Error('Anmeldung abgebrochen');
  }

  accept(r, scope) {
    if (r.refresh_token) this.refreshToken = r.refresh_token;
    this.tokens.set(scope, { token: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
    if (r.id_token) {
      try {
        const claims = JSON.parse(new TextDecoder().decode(unb64(r.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(r.id_token.split('.')[1].length / 4) * 4, '='))));
        this.account = { name: claims.name || claims.preferred_username, username: claims.preferred_username || '', tenantId: claims.tid || '' };
      } catch {
        // No name then.
      }
    }
  }

  /** Access token for a resource scope (cached; renewed through the refresh token). */
  async getToken(scope, { forceRefresh = false, tenantId } = {}) {
    if (!this.refreshToken) throw Object.assign(new Error('Nicht angemeldet'), { name: 'LockedError' });
    const key = `${tenantId || ''}|${scope}`;
    const cached = this.tokens.get(key) || (!tenantId ? this.tokens.get(scope) : null);
    if (cached && !forceRefresh && cached.expires - Date.now() > 120_000) return cached.token;
    if (this.pending.has(key)) return this.pending.get(key);
    const run = (async () => {
      const tenant = tenantId || this.tenant;
      const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: this.refreshToken, scope: `${scope} offline_access openid profile` }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(r.error_description || r.error || `HTTP ${res.status}`);
        e.code = r.error;
        if (/invalid_grant|interaction_required|expired/i.test(`${r.error} ${r.error_description}`)) e.name = 'LockedError';
        throw e;
      }
      if (r.refresh_token) this.refreshToken = r.refresh_token;
      this.tokens.set(key, { token: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
      return r.access_token;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  // ---------------------------------------------------------------- persistence (PIN-encrypted refresh token)

  static async hasSaved() {
    return !!(await Preferences.get({ key: STORE_KEY })).value;
  }

  static async hasPin() {
    return !!(await Preferences.get({ key: PIN_KEY })).value;
  }

  /** Sets (or changes) the PIN and stores the refresh token encrypted with it. */
  async setPin(pin) {
    if (String(pin).length < 4) throw new Error('Die PIN braucht mindestens 4 Zeichen');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await pinKey(pin, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const check = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8('keevault-pin-ok'));
    await Preferences.set({ key: PIN_KEY, value: JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), check: b64(check) }) });
    await this.save(pin);
  }

  async save(pin) {
    if (!this.refreshToken) return;
    const record = JSON.parse((await Preferences.get({ key: PIN_KEY })).value || 'null');
    if (!record) return;
    const key = await pinKey(pin, unb64(record.salt));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify({ refreshToken: this.refreshToken, account: this.account, tenant: this.tenant })));
    await Preferences.set({ key: STORE_KEY, value: JSON.stringify({ v: 1, iv: b64(iv), data: b64(data) }) });
  }

  /** Restores the session with the PIN; wrong PIN → error (the GCM tag does not match). */
  async restore(pin) {
    const record = JSON.parse((await Preferences.get({ key: PIN_KEY })).value || 'null');
    const stored = JSON.parse((await Preferences.get({ key: STORE_KEY })).value || 'null');
    if (!record || !stored) throw new Error('Keine gespeicherte Anmeldung');
    const key = await pinKey(pin, unb64(record.salt));
    let plain;
    try {
      plain = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, key, unb64(stored.data))));
    } catch {
      throw new Error('Falsche PIN');
    }
    this.refreshToken = plain.refreshToken;
    this.account = plain.account;
    this.tenant = plain.tenant || this.tenant;
    return this.account;
  }

  lock() {
    this.tokens.clear();
  }

  async signOut() {
    this.refreshToken = null;
    this.account = null;
    this.tokens.clear();
    await Preferences.remove({ key: STORE_KEY });
    await Preferences.remove({ key: PIN_KEY });
  }
}
