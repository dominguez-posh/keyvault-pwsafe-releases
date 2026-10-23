// Entra ID sign-in for the extension: authorization code flow with PKCE through chrome.identity.
// The app registration needs the redirect URI https://<extension-id>.chromiumapp.org/ as "Single-page application".
// Tokens live only in chrome.storage.session (memory, cleared when the browser closes or the vault locks).

import { b64uEncode, randomBytes, sha256, utf8, decodeJwtPayload } from '../core/util.js';
import { KV_SCOPE } from '../core/keyvault.js';
import { ARM_SCOPE } from '../core/azure.js';
import { getSettings } from './settings.js';
import { t } from '../core/i18n.js';

const KEY = 'auth';
const BASE_SCOPES = 'openid profile offline_access';

export class LockedError extends Error {
  constructor(message = t('Tresor ist gesperrt')) {
    super(message);
    this.name = 'LockedError';
  }
}

async function load() {
  return (await chrome.storage.session.get(KEY))[KEY] || null;
}

async function save(auth) {
  await chrome.storage.session.set({ [KEY]: auth });
}

export async function clear() {
  await chrome.storage.session.remove(KEY);
}

export async function account() {
  return (await load())?.account || null;
}

const endpoint = (tenantId) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;

async function tokenRequest(tenantId, params) {
  const res = await fetch(`${endpoint(tenantId)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error_description || data.error || t('Anmeldung fehlgeschlagen ({status})', { status: res.status })).split(/\r?\n/)[0]);
    e.code = data.error;
    e.suberror = data.suberror;
    throw e;
  }
  return data;
}

/**
 * Interactive (or silent, interactive=false) sign-in. prompt: none | select_account | login.
 * Consent for Key Vault and Azure Resource Manager is requested together; the first token is for Key Vault.
 */
export async function signIn({ interactive = true, prompt = 'select_account', loginHint } = {}) {
  const { tenantId, clientId } = await getSettings();
  if (!tenantId || !clientId) throw new Error(t('Tenant-ID und Client-ID fehlen – bitte in den Einstellungen eintragen'));
  const verifier = b64uEncode(randomBytes(32));
  const state = b64uEncode(randomBytes(16));
  const nonce = b64uEncode(randomBytes(16));
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: `${BASE_SCOPES} ${KV_SCOPE} ${ARM_SCOPE}`,
    code_challenge: b64uEncode(await sha256(utf8(verifier))),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  if (!interactive) params.set('prompt', 'none');
  else if (prompt && prompt !== 'none') params.set('prompt', prompt);
  if (loginHint) params.set('login_hint', loginHint);

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: `${endpoint(tenantId)}/authorize?${params}`, interactive });
  } catch (e) {
    throw new Error(interactive ? t('Anmeldung abgebrochen ({message})', { message: e.message }) : t('Stille Anmeldung nicht möglich'));
  }
  const q = new URL(redirect).searchParams;
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
  if (q.get('state') !== state) throw new Error(t('Ungültige Anmeldeantwort (state)'));

  const tokens = await tokenRequest(tenantId, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: `${BASE_SCOPES} ${KV_SCOPE}`,
  });
  const claims = decodeJwtPayload(tokens.id_token);
  if (claims.nonce !== nonce) throw new Error(t('Ungültige Anmeldeantwort (nonce)'));
  const auth = {
    tenantId,
    clientId,
    refreshToken: tokens.refresh_token,
    tokens: { [KV_SCOPE]: { token: tokens.access_token, exp: Date.now() + tokens.expires_in * 1000 } },
    account: {
      oid: claims.oid,
      tid: claims.tid,
      name: claims.name || '',
      username: claims.preferred_username || claims.upn || claims.email || '',
    },
    unlockedAt: Date.now(),
  };
  await save(auth);
  return auth.account;
}

/** Developer demo (chrome.storage.local devDemo = true): fake account, tokens are never sent anywhere real. */
export async function signInDemo(account) {
  const far = Date.now() + 365 * 86_400_000;
  const tokens = Object.fromEntries([KV_SCOPE, ARM_SCOPE, 'https://graph.microsoft.com/.default'].map((s) => [s, { token: 'demo-token', exp: far }]));
  await save({ tenantId: 'demo', clientId: 'demo', refreshToken: '', tokens, account: { oid: account.localAccountId, tid: account.tenantId, name: account.name, username: account.username }, unlockedAt: Date.now() });
  return account;
}

const inflight = new Map();

export async function getToken(scope, { forceRefresh = false } = {}) {
  const auth = await load();
  if (!auth) throw new LockedError();
  const cached = auth.tokens[scope];
  if (!forceRefresh && cached && cached.exp - 120_000 > Date.now()) return cached.token;
  if (!inflight.has(scope)) inflight.set(scope, refresh(scope, true).finally(() => inflight.delete(scope)));
  return inflight.get(scope);
}

async function refresh(scope, allowSilentSignIn) {
  const auth = await load();
  if (!auth) throw new LockedError();
  let data;
  try {
    data = await tokenRequest(auth.tenantId, {
      client_id: auth.clientId,
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      scope: `${scope} ${BASE_SCOPES}`,
    });
  } catch (e) {
    if (e.suberror === 'consent_required' || /AADSTS65001/.test(e.message)) {
      throw new Error(t('Zustimmung für {resource} fehlt – Administrator muss die App-Berechtigungen erteilen', { resource: new URL(scope).hostname }));
    }
    if ((e.code === 'invalid_grant' || e.code === 'interaction_required') && allowSilentSignIn) {
      // Refresh tokens of single-page apps expire after 24 hours; the browser session usually signs in silently.
      try {
        await signIn({ interactive: false, loginHint: auth.account.username });
      } catch {
        await clear();
        throw new LockedError(t('Sitzung abgelaufen – bitte erneut entsperren'));
      }
      return refresh(scope, false);
    }
    throw e;
  }
  const latest = (await load()) || auth;
  latest.refreshToken = data.refresh_token || latest.refreshToken;
  latest.tokens = { ...latest.tokens, [scope]: { token: data.access_token, exp: Date.now() + data.expires_in * 1000 } };
  await save(latest);
  return data.access_token;
}
