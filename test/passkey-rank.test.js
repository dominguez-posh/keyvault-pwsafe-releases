import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from '../extension/core/match.js';

const pk = (userName, urls = ['https://login.microsoftonline.com']) => ({ title: 'Microsoft', urls, passkey: { userName } });

test('passkey choice: the account of a running one-click sign-in comes first (#13)', () => {
  const list = [pk('admin@m365x.onmicrosoft.com'), pk('upadmin@contoso.com'), pk('other@contoso.com')];
  assert.equal(rankCandidates(list, 'https://login.microsoft.com/x/fido/get', 'UPADMIN@contoso.com')[0].passkey.userName, 'upadmin@contoso.com');
  // Without a sign-in: the page decides, the order stays otherwise.
  assert.equal(rankCandidates(list, 'https://login.microsoft.com/x/fido/get')[0].passkey.userName, 'admin@m365x.onmicrosoft.com');
  assert.equal(rankCandidates(list, '', 'nobody@x')[0].passkey.userName, 'admin@m365x.onmicrosoft.com');
});
