// Address an admin center opens with for an entry's account (desktop/main/signin.js). No Electron: unit-tested.

/**
 * The admin centers on the Azure portal's framework (Azure portal with PIM, Entra, Intune) start their sign-in through
 * /signin/index/@<domain>?loginHint=<account> (#457): Microsoft then signs in this account, also when the browser is
 * already signed in with another account of the same tenant, which it would otherwise keep silently – the extension
 * never got to pick the entry's account. The other account stays signed in. A deep view (PIM) stays in the #-part in
 * the account's tenant (#@contoso.com), as before.
 */
const AZURE_PORTAL_HOSTS = ['portal.azure.com', 'entra.microsoft.com', 'intune.microsoft.com'];
const UPN = /^[^@\s/\\?#&]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export function adminCenterUrl(url, username) {
  const account = String(username || '').trim();
  const domain = UPN.exec(account)?.[1]?.toLowerCase();
  const u = new URL(url);
  if (!domain) return url;
  if (AZURE_PORTAL_HOSTS.includes(u.hostname)) {
    const view = u.hash.replace(/^#\/?/, '').replace(/^@[^/]*\/?/, '');
    const start = new URL(`/signin/index/@${domain}`, u.origin);
    start.searchParams.set('loginHint', account);
    if (view) start.hash = `@${domain}/${view}`;
    return start.toString();
  }
  // The other admin centers (M365, Exchange, Teams, Defender, Purview) take the account as login_hint, which Microsoft's
  // sign-in uses where the center passes it on; where not, the extension's job still picks the account on the picker.
  u.searchParams.set('login_hint', account);
  return u.toString();
}
