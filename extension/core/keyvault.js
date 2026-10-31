// Azure Key Vault secrets REST client (data plane). Tokens come from the caller (Entra ID, delegated).

import { sleep } from './util.js';
import { t } from './i18n.js';

export const KV_SCOPE = 'https://vault.azure.net/user_impersonation';
const API_VERSION = '7.5';
const VAULT_HOST = /^[a-z0-9-]{3,24}\.vault\.azure\.net$/;

export class KeyVaultError extends Error {
  /** detail: Key Vault's own message (names caller, tenant and reason – shown for diagnosis). */
  constructor(status, code, message, detail) {
    super(message || `Key Vault Fehler ${status}`);
    this.name = 'KeyVaultError';
    this.status = status;
    this.code = code;
    this.detail = detail || '';
  }
}

/**
 * Accepts "https://name.vault.azure.net/", "name.vault.azure.net" or "name" and returns
 * "https://name.vault.azure.net". Only public-cloud vault hosts are allowed so that a pasted
 * link can never make the client send Key Vault tokens elsewhere.
 */
export function normalizeVaultUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error(t('Key-Vault-Adresse fehlt'));
  if (!s.includes('.') && !s.includes('/')) s = `${s}.vault.azure.net`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !VAULT_HOST.test(host)) {
    throw new Error(t('„{input}“ ist keine gültige Key-Vault-Adresse (https://<name>.vault.azure.net)', { input }));
  }
  return `https://${host}`;
}

export const vaultHost = (vaultUrl) => new URL(normalizeVaultUrl(vaultUrl)).hostname;

function parseId(id) {
  // https://<vault>/secrets/<name>[/<version>] or /deletedsecrets/<name>
  const parts = new URL(id).pathname.split('/').filter(Boolean);
  return { name: parts[1], version: parts[2] || '' };
}

function describe(status, error) {
  const inner = error?.innererror?.code;
  if (status === 403 && inner === 'ForbiddenByFirewall') return t('Zugriff durch die Key-Vault-Firewall blockiert');
  if (status === 403) return t('Keine Berechtigung für diesen Tresor');
  if (status === 404) return t('Nicht gefunden');
  return error?.message;
}

/** Tenant ID from a Key Vault 401 challenge: Bearer authorization="https://login.microsoftonline.com/<tenant>", … */
export function challengeTenant(header) {
  const m = /authori[sz]ation(?:_uri)?="?https:\/\/[^/"]+\/([0-9a-f-]{36})/i.exec(header || '');
  return m ? m[1].toLowerCase() : null;
}

export class KeyVaultClient {
  /**
   * @param {{ vaultUrl: string, getToken: (opts: { forceRefresh?: boolean, tenantId?: string }) => Promise<string>, fetch?: typeof fetch,
   *   tenantId?: string, onTenant?: (tenantId: string) => void }} options
   * The vault may live in another tenant (customer, guest access): its 401 challenge names the tenant, the
   * request is repeated with a token for that tenant and onTenant remembers it.
   */
  constructor({ vaultUrl, getToken, fetch: fetchImpl, tenantId, onTenant }) {
    this.baseUrl = normalizeVaultUrl(vaultUrl);
    this.host = new URL(this.baseUrl).hostname;
    this.getToken = getToken;
    this.tenantId = tenantId || null;
    this.onTenant = onTenant;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  url(path, params = {}) {
    const u = new URL(this.baseUrl + path);
    u.searchParams.set('api-version', API_VERSION);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async send(method, url, body) {
    let forceRefresh = false;
    let switched = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken({ forceRefresh, ...(this.tenantId ? { tenantId: this.tenantId } : {}) });
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new KeyVaultError(0, 'NetworkError', t('Key Vault nicht erreichbar ({message})', { message: e.message }));
      }
      if (res.status === 401) {
        const tenant = challengeTenant(res.headers.get('www-authenticate'));
        if (tenant && tenant !== this.tenantId && !switched) {
          switched = true;
          this.tenantId = tenant;
          this.onTenant?.(tenant);
          continue;
        }
        if (!forceRefresh) {
          forceRefresh = true;
          continue;
        }
      }
      if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 400 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!res.ok) {
        const inner = data?.error?.innererror?.code;
        const detail = [data?.error?.code, inner, data?.error?.message].filter(Boolean).join(' · ');
        throw new KeyVaultError(res.status, data?.error?.code, describe(res.status, data?.error) || res.statusText, detail);
      }
      return data;
    }
  }

  /** onPage(count, pages): called after every page with the items listed so far and the pages read (progress for big vaults). */
  async listPaged(path, params, onPage = null) {
    let url = this.url(path, params);
    const all = [];
    let pages = 0;
    while (url) {
      const data = await this.send('GET', url);
      all.push(...(data?.value || []));
      onPage?.(all.length, ++pages);
      url = data?.nextLink || null;
      if (url && new URL(url).hostname.toLowerCase() !== this.host) {
        throw new KeyVaultError(0, 'InvalidNextLink', t('Ungültiger Folgelink vom Key Vault'));
      }
    }
    return all;
  }

  async listSecrets(onPage = null) {
    const items = await this.listPaged('/secrets', { maxresults: 25 }, onPage);
    return items.map((s) => ({ ...s, name: parseId(s.id).name }));
  }

  async getSecret(name, version = '') {
    const data = await this.send('GET', this.url(`/secrets/${encodeURIComponent(name)}/${version}`));
    return { ...data, ...parseId(data.id) };
  }

  async setSecret(name, value, { contentType, tags } = {}) {
    const data = await this.send('PUT', this.url(`/secrets/${encodeURIComponent(name)}`), {
      value, contentType, tags, attributes: { enabled: true },
    });
    return { ...data, ...parseId(data.id) };
  }

  async deleteSecret(name) {
    return this.send('DELETE', this.url(`/secrets/${encodeURIComponent(name)}`));
  }

  async listSecretVersions(name) {
    const items = await this.listPaged(`/secrets/${encodeURIComponent(name)}/versions`, { maxresults: 25 });
    return items.map((s) => ({ ...s, ...parseId(s.id) }));
  }

  async listDeletedSecrets() {
    const items = await this.listPaged('/deletedsecrets', { maxresults: 25 });
    return items.map((s) => ({ ...s, name: parseId(s.recoveryId || s.id).name }));
  }

  async recoverDeletedSecret(name) {
    return this.send('POST', this.url(`/deletedsecrets/${encodeURIComponent(name)}/recover`));
  }

  async purgeDeletedSecret(name) {
    return this.send('DELETE', this.url(`/deletedsecrets/${encodeURIComponent(name)}`));
  }
}
