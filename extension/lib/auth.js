// The extension signs in nowhere: sign-in, tokens and keys belong to the Keevault desktop app. What is left here
// is the locked state and the developer demo (chrome.storage.local devDemo = true), whose fake tokens only reach the
// in-memory demo backend.

import { KV_SCOPE } from '../core/keyvault.js';
import { ARM_SCOPE } from '../core/azure.js';
import { t } from '../core/i18n.js';

const KEY = 'auth';

export class LockedError extends Error {
  constructor(message = t('Tresor ist gesperrt')) {
    super(message);
    this.name = 'LockedError';
  }
}

async function load() {
  return (await chrome.storage.session.get(KEY))[KEY] || null;
}

export async function clear() {
  await chrome.storage.session.remove(KEY);
}

export async function account() {
  return (await load())?.account || null;
}

export async function signInDemo(account) {
  const far = Date.now() + 365 * 86_400_000;
  const tokens = Object.fromEntries([KV_SCOPE, ARM_SCOPE, 'https://graph.microsoft.com/.default'].map((s) => [s, { token: 'demo-token', exp: far }]));
  await chrome.storage.session.set({ [KEY]: { tokens, account: { oid: account.localAccountId, tid: account.tenantId, name: account.name, username: account.username } } });
  return account;
}

export async function getToken(scope) {
  const token = (await load())?.tokens[scope];
  if (!token) throw new LockedError();
  return token.token;
}
