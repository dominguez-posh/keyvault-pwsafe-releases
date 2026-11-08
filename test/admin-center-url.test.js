import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminCenterUrl } from '../desktop/admin-center-url.js';
import { microsoftPage } from '../extension/core/tabtrust.js';

// #457: an admin center opens with the entry's account, not with another account of the same tenant in the browser.
const USER = 'unique@Contoso.com';
const LINKS = {
  azure: 'https://portal.azure.com',
  pim: 'https://portal.azure.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles',
  entra: 'https://entra.microsoft.com',
  intune: 'https://intune.microsoft.com',
  m365: 'https://admin.microsoft.com',
  sharepoint: 'https://admin.microsoft.com/sharepoint',
  exchange: 'https://admin.exchange.microsoft.com',
  teams: 'https://admin.teams.microsoft.com',
  defender: 'https://security.microsoft.com',
  purview: 'https://purview.microsoft.com',
};

test('Azure portal, Entra and Intune start the sign-in with the account (loginHint) in its tenant', () => {
  assert.equal(adminCenterUrl(LINKS.azure, USER), 'https://portal.azure.com/signin/index/@contoso.com?loginHint=unique%40Contoso.com');
  assert.equal(adminCenterUrl(LINKS.entra, USER), 'https://entra.microsoft.com/signin/index/@contoso.com?loginHint=unique%40Contoso.com');
  assert.equal(adminCenterUrl(LINKS.intune, USER), 'https://intune.microsoft.com/signin/index/@contoso.com?loginHint=unique%40Contoso.com');
});

test('PIM keeps its view in the account tenant', () => {
  assert.equal(adminCenterUrl(LINKS.pim, USER),
    'https://portal.azure.com/signin/index/@contoso.com?loginHint=unique%40Contoso.com#@contoso.com/view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles');
  // A tenant already in the link is replaced by the account's.
  assert.equal(adminCenterUrl('https://portal.azure.com/#@fabrikam.com/view/X', USER), 'https://portal.azure.com/signin/index/@contoso.com?loginHint=unique%40Contoso.com#@contoso.com/view/X');
});

test('the other admin centers carry login_hint, path and parameters stay', () => {
  for (const id of ['m365', 'exchange', 'teams', 'defender', 'purview']) {
    const u = new URL(adminCenterUrl(LINKS[id], USER));
    assert.equal(u.origin, new URL(LINKS[id]).origin, id);
    assert.equal(u.searchParams.get('login_hint'), USER, id);
  }
  assert.equal(adminCenterUrl(LINKS.sharepoint, USER), 'https://admin.microsoft.com/sharepoint?login_hint=unique%40Contoso.com');
  assert.equal(adminCenterUrl('https://admin.microsoft.com/?ref=x', USER), 'https://admin.microsoft.com/?ref=x&login_hint=unique%40Contoso.com');
});

test('accounts without a domain or with odd characters leave the link as it is', () => {
  for (const name of ['CONTOSO\\admin', 'admin', '', undefined, 'a b@contoso.com', 'a@contoso', 'a/b@contoso.com', 'a@contoso.com/x', 'a?x@contoso.com', 'a#b@contoso.com', 'a&b@contoso.com']) {
    for (const url of Object.values(LINKS)) assert.equal(adminCenterUrl(url, name), url, `${name} ${url}`);
  }
});

test('every built address stays on its admin center and counts as a Microsoft page (no loosening of #424/#425/#429)', () => {
  for (const url of Object.values(LINKS)) {
    const built = adminCenterUrl(url, USER);
    assert.equal(new URL(built).origin, new URL(url).origin, url);
    assert.equal(microsoftPage(built), true, built);
  }
  // A crafted account name cannot move the address elsewhere.
  for (const name of ['x@evil.example', 'x@contoso.com.evil.example']) {
    for (const url of Object.values(LINKS)) assert.equal(new URL(adminCenterUrl(url, name)).origin, new URL(url).origin);
  }
});
