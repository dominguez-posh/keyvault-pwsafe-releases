// Entra ID sign-in for the desktop app with MSAL. On Windows through the Web Account Manager (WAM, like
// PowerShell / Azure CLI): the Microsoft sign-in appears as a Windows dialog and uses the Windows account (SSO);
// otherwise, or if WAM fails, in the system browser with loopback redirect http://localhost.
// The token cache is encrypted with the OS key store (DPAPI on Windows) via Electron safeStorage.

import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { safeStorage, shell, net } from 'electron';
import fs from 'node:fs/promises';
import { KV_SCOPE } from '../extension/core/keyvault.js';
import { ARM_SCOPE } from '../extension/core/azure.js';
import { t, getLanguage } from '../extension/core/i18n.js';
import { decodeJwtPayload } from '../extension/core/util.js';

const CONSENT_SCOPES = [ARM_SCOPE, 'https://graph.microsoft.com/User.ReadBasic.All'];

// Without an own app registration: Microsoft's public Azure CLI client (also the default of the Azure Identity
// SDKs). It is preauthorized for ARM, Key Vault and Graph, so no consent and no tenant setup is needed.
export const DEFAULT_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

/** Tenant and client actually used: settings or the defaults (any work account, Azure CLI client). */
export function entraSettings({ tenantId, clientId }) {
  return { tenantId: tenantId || 'organizations', clientId: clientId || DEFAULT_CLIENT_ID, ownApp: !!clientId };
}

const page = (title, text) => `<!doctype html><html lang="${getLanguage()}"><meta charset="utf-8"><title>${title}</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#1b1d22">
<div style="text-align:center"><h1 style="font-weight:600">${title}</h1><p>${text}</p></div></body></html>`;

// MSAL traffic over Chromium's network stack (Windows certificate store and system proxy, unaffected by
// NODE_TLS_REJECT_UNAUTHORIZED) instead of Node's https module.
async function send(url, options = {}, method = 'GET', timeout) {
  const res = await net.fetch(url, {
    method,
    headers: options.headers,
    body: method === 'POST' ? options.body : undefined,
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  return { headers: Object.fromEntries(res.headers), body, status: res.status };
}

const networkClient = {
  sendGetRequestAsync: (url, options, timeout) => send(url, options, 'GET', timeout),
  sendPostRequestAsync: (url, options) => send(url, options, 'POST'),
};

// AADSTS50020: user from another tenant without guest account; AADSTS90072: same, external identity;
// AADSTS50034: account does not exist in that directory.
const NOT_IN_TENANT = /AADSTS(50020|90072|50034)\b/;

/** Another tenant (customer) needs an interactive sign-in first, e.g. its own MFA policy. */
/**
 * "The user has to sign in interactively". MSAL Node reports it as InteractionRequiredAuthError, the Windows broker
 * (WAM) as a native error with errorCode/message "interaction_required" (e.g. MFA or Conditional Access in a tenant).
 */
export const isInteractionRequired = (e) => e instanceof InteractionRequiredAuthError
  || /interaction_?required|consent_required|login_required/i.test(`${e?.errorCode || ''} ${e?.message || ''}`);

export class TenantSignInError extends Error {
  constructor(tenantId) {
    super(t('Für den Tenant {tenant} ist eine Anmeldung nötig (z. B. MFA des Kunden).', { tenant: tenantId }));
    this.name = 'TenantSignInError';
    this.code = 'TenantSignInRequired';
    this.tenantId = tenantId;
  }
}

// Windows broker (WAM), loaded once. Own app registrations need the redirect URI
// ms-appx-web://Microsoft.AAD.BrokerPlugin/<client ID>; without it the browser is used.
let brokerPlugin;
const brokerReady = (async () => {
  brokerPlugin = null;
  if (process.platform !== 'win32') return;
  try {
    const { NativeBrokerPlugin } = await import('@azure/msal-node-extensions');
    const plugin = new NativeBrokerPlugin();
    if (plugin.isBrokerAvailable) brokerPlugin = plugin;
  } catch {
    // Native runtime missing: browser sign-in.
  }
})();

/** Tenant that issued an access token (tid claim). */
function tokenTenant(result) {
  try {
    return String(decodeJwtPayload(result.accessToken).tid || '').toLowerCase();
  } catch {
    return String(result.tenantId || '').toLowerCase();
  }
}

function notInTenant(tenantId) {
  return new Error(t('Dein Konto ist im Tenant {tenant} nicht vorhanden. Für Key Vaults beim Kunden brauchst du dort ein Gastkonto mit Key-Vault-Rolle – Azure Lighthouse gibt keinen Zugriff auf Secrets.', { tenant: tenantId }));
}

export class LockedError extends Error {
  constructor(message = t('Tresor ist gesperrt')) {
    super(message);
    this.name = 'LockedError';
  }
}

export class Auth {
  /** getWindowHandle(): native handle of the app window (parent of the Windows sign-in dialog). */
  constructor({ cachePath, getConfig, onInteractive, getWindowHandle }) {
    this.cachePath = cachePath;
    this.getConfig = getConfig;
    this.onInteractive = onInteractive;
    this.getWindowHandle = getWindowHandle;
    this.brokerFailed = false;
    this.account = null;
    this.client = null;
    this.clientKey = '';
    // Access tokens per scope + tenant, and requests in flight: parallel callers share one request.
    // Without this, bursts (icons, many vaults) hit the token endpoint so often that Entra stops with
    // AADSTS50196 ("client request loop").
    this.tokens = new Map();
    this.pending = new Map();
  }

  pca() {
    const { tenantId, clientId } = entraSettings(this.getConfig());
    const broker = this.useBroker();
    const key = `${tenantId}|${clientId}|${broker ? 'wam' : 'browser'}`;
    if (this.client && this.clientKey === key) return this.client;
    this.tokens.clear();
    const cachePlugin = {
      beforeCacheAccess: async (ctx) => {
        try {
          const data = await fs.readFile(this.cachePath);
          const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
          ctx.tokenCache.deserialize(result);
          // Key of the OS store changed (or old format): store it again with the current key.
          if (shouldReEncrypt) await fs.writeFile(this.cachePath, await safeStorage.encryptStringAsync(result));
        } catch {
          // No or unreadable cache: start empty.
        }
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged && (await safeStorage.isAsyncEncryptionAvailable())) {
          await fs.writeFile(this.cachePath, await safeStorage.encryptStringAsync(ctx.tokenCache.serialize()));
        }
      },
    };
    this.client = new PublicClientApplication({
      auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
      cache: { cachePlugin },
      system: { networkClient },
      ...(broker ? { broker: { nativeBrokerPlugin: brokerPlugin } } : {}),
    });
    this.clientKey = key;
    return this.client;
  }

  /** WAM unless turned off in the settings or it failed before in this session. */
  useBroker() {
    return !!brokerPlugin && !this.brokerFailed && this.getConfig().signInWindows !== false;
  }

  async interactive(scopes, options = {}) {
    await brokerReady;
    this.onInteractive?.(true);
    try {
      const broker = this.useBroker();
      try {
        return await this.pca().acquireTokenInteractive(this.interactiveRequest(scopes, options, broker));
      } catch (e) {
        // Cancelled by the user: done. Anything else from WAM (e.g. redirect URI missing in an own app
        // registration): once more in the browser.
        if (!broker || /cancel|user_cancelled|access_denied/i.test(`${e.errorCode} ${e.message}`)) throw e;
        this.brokerFailed = true;
        return await this.pca().acquireTokenInteractive(this.interactiveRequest(scopes, options, false));
      }
    } finally {
      this.onInteractive?.(false);
    }
  }

  interactiveRequest(scopes, { prompt, loginHint, extraScopesToConsent, authority }, broker) {
    return {
      scopes,
      authority,
      extraScopesToConsent,
      prompt,
      loginHint,
      ...(broker ? { windowHandle: this.getWindowHandle?.() } : {}),
      openBrowser: async (url) => {
        await shell.openExternal(url);
      },
      successTemplate: page(t('Anmeldung erfolgreich'), t('Du kannst dieses Fenster schließen und zu Keevault zurückkehren.')),
      errorTemplate: page(t('Anmeldung fehlgeschlagen'), t('Bitte in Keevault erneut versuchen.')),
    };
  }

  /** prompt: none (silent if possible) | select_account | login */
  async unlock(prompt = 'select_account') {
    await brokerReady;
    const accounts = await this.pca().getTokenCache().getAllAccounts();
    const known = accounts[0];
    if (prompt === 'none' && known) {
      try {
        const r = await this.pca().acquireTokenSilent({ account: known, scopes: [KV_SCOPE] });
        this.account = r.account;
        return this.account;
      } catch {
        // Fall through to interactive sign-in.
      }
    }
    const r = await this.interactive([KV_SCOPE], {
      prompt: prompt === 'none' ? undefined : prompt,
      loginHint: known?.username,
      // First-party clients are preauthorized; asking them for consent fails (AADSTS65002).
      extraScopesToConsent: entraSettings(this.getConfig()).ownApp ? CONSENT_SCOPES : undefined,
    });
    this.account = r.account;
    return this.account;
  }

  /** After a tenant change: same account, token for the new tenant (interactive only if required). */
  async switchTenant() {
    if (!this.account) return this.unlock('none');
    try {
      const r = await this.pca().acquireTokenSilent({ account: this.account, scopes: [KV_SCOPE] });
      this.account = r.account;
    } catch (e) {
      if (!isInteractionRequired(e)) throw e;
      const r = await this.interactive([KV_SCOPE], { loginHint: this.account.username });
      this.account = r.account;
    }
    return this.account;
  }

  /**
   * tenantId: token for another tenant (vault of a customer where the account is a guest). Those never open the
   * browser on their own – the user starts that sign-in (signInTenant), otherwise every unlock would pop up a
   * sign-in for vaults that are only visible through Azure Lighthouse.
   * silentOnly: never open the browser (background discovery).
   */
  async getToken(scope, { forceRefresh = false, tenantId, silentOnly = false } = {}) {
    if (!this.account) throw new LockedError();
    await brokerReady;
    const key = `${this.account.homeAccountId}|${tenantId || ''}|${scope}`;
    const cached = this.tokens.get(key);
    // A forced refresh (after a 401) only if the token is not brand new – otherwise it cannot help anyway.
    const fresh = cached && cached.expires - Date.now() > 120_000 && (!forceRefresh || Date.now() - cached.at < 30_000);
    if (fresh) return cached.token;
    if (this.pending.has(key)) return this.pending.get(key);
    const run = this.fetchToken(scope, { forceRefresh: forceRefresh && !!cached, tenantId, silentOnly })
      .then((r) => {
        this.tokens.set(key, { token: r.accessToken, expires: r.expiresOn ? new Date(r.expiresOn).getTime() : Date.now() + 300_000, at: Date.now() });
        return r.accessToken;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  async fetchToken(scope, { forceRefresh, tenantId, silentOnly }) {
    const authority = tenantId ? `https://login.microsoftonline.com/${tenantId}` : undefined;
    try {
      const request = { account: this.account, scopes: [scope], forceRefresh, authority };
      let r = await this.pca().acquireTokenSilent(request);
      // MSAL may hand out the cached token of the home tenant although another tenant was asked for (the vault
      // then answers AKV10032 "invalid issuer"): check the issuing tenant and fetch a fresh one if it differs.
      if (tenantId && tokenTenant(r) !== tenantId.toLowerCase()) {
        r = await this.pca().acquireTokenSilent({ ...request, forceRefresh: true });
        if (tokenTenant(r) !== tenantId.toLowerCase()) throw new TenantSignInError(tenantId);
      }
      return r;
    } catch (e) {
      if (tenantId && NOT_IN_TENANT.test(String(e.errorMessage || e.message))) throw notInTenant(tenantId);
      if (!isInteractionRequired(e) || silentOnly) throw e;
      if (tenantId && tenantId !== this.account.tenantId) throw new TenantSignInError(tenantId);
      try {
        return await this.interactive([scope], { loginHint: this.account.username, authority });
      } catch (err) {
        if (tenantId && NOT_IN_TENANT.test(String(err.errorMessage || err.message))) throw notInTenant(tenantId);
        throw err;
      }
    }
  }

  /** Interactive sign-in for another tenant (started by the user). */
  async signInTenant(tenantId, scope) {
    try {
      await this.interactive([scope], { loginHint: this.account?.username, authority: `https://login.microsoftonline.com/${tenantId}` });
    } catch (e) {
      if (NOT_IN_TENANT.test(String(e.errorMessage || e.message))) throw notInTenant(tenantId);
      throw e;
    }
  }

  lock() {
    this.account = null;
    this.tokens.clear();
  }

  async signOut() {
    try {
      const cache = this.pca().getTokenCache();
      for (const a of await cache.getAllAccounts()) await cache.removeAccount(a);
    } catch {
      // Not configured: nothing cached.
    }
    this.account = null;
    this.tokens.clear();
    await fs.rm(this.cachePath, { force: true });
  }
}
