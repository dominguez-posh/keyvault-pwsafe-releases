// One-click sign-in handed to the browser extension (Microsoft, Bastion, admin centers) and the admin center links.

import { totpCode } from '../../extension/core/totp.js';
import { fqdnUserName } from '../../extension/core/model.js';
import { bridge } from './state.js';
import { splitEntryKey, usableItem } from './devices.js';
import { claimJob } from '../signin-claim.js';

// Sign-in handed to the browser extension: for two minutes, only on the named sign-in hosts, the extension may ask
// for this one account (bridge "signIn"; the host comes from the browser, not from the page). Several steps (account,
// password, one-time code) read it again, so the code is always fresh.
export const MS_LOGIN_HOSTS = ['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com'];
const SIGN_IN_MS = 120_000;

export let signInJobs = [];
export const hostIn = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** source: an entry key "containerId/itemId" or { username, password } of a server entry's own account. */
export function addSignInJob(hosts, source, mode) {
  const now = Date.now();
  signInJobs = signInJobs.filter((j) => j.until > now && !j.hosts.some((h) => hosts.includes(h)));
  signInJobs.push({ hosts, source, mode, until: now + SIGN_IN_MS });
  bridge?.broadcast('signin');
}

export async function signInFor(host, tab) {
  const now = Date.now();
  signInJobs = signInJobs.filter((j) => j.until > now);
  const job = signInJobs.find((j) => hostIn(String(host || '').toLowerCase(), j.hosts));
  if (!job || !claimJob(job, tab)) return null;
  const item = typeof job.source === 'string' ? await usableItem(...splitEntryKey(job.source)) : job.source;
  // Bastion's sign-in on the VM always gets the FQDN form (user@contoso.local) when the account knows its domain.
  const username = job.mode === 'form' || job.mode === 'bastion' ? fqdnUserName(item) : item.username || '';
  // passkey: the account has one – the extension prefers it to the password and answers Microsoft's prompt by itself.
  return { mode: job.mode, username, password: item.password || '', totp: item.totp ? (await totpCode(item.totp))?.code || '' : '', passkey: !!item.passkeys?.length };
}

/** Microsoft admin centers (renderer: menu "M365"), opened in the default browser. */
export const ADMIN_CENTER_HOSTS = ['admin.microsoft.com', 'entra.microsoft.com', 'intune.microsoft.com', 'security.microsoft.com', 'purview.microsoft.com',
  'admin.exchange.microsoft.com', 'admin.teams.microsoft.com', 'portal.azure.com'];

// The address for the entry's account: desktop/admin-center-url.js.
export { adminCenterUrl } from '../admin-center-url.js';
export let lastAdminUrl = '';

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setSignInJobs(value) { signInJobs = value; return value; }
export function setLastAdminUrl(value) { lastAdminUrl = value; return value; }
