import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryTemplate, normalizeItem, serializeItem, parseItem, summaryFromSecret, itemHosts, isSophosLogin, sophosFillPassword } from '../extension/core/model.js';

test('sophos login: template with logo and named portals (VPN, Admin, User portal)', () => {
  const tpl = entryTemplate('sophos');
  assert.equal(tpl.type, 'login');
  assert.equal(tpl.sophos, true);
  assert.match(tpl.icon, /^data:image\/png;base64,/);
  assert.deepEqual(tpl.portals.map((p) => p.label), ['VPN-Portal', 'Admin-Portal', 'User-Portal']);
  // Rows without an address are not kept.
  assert.deepEqual(normalizeItem(tpl).portals, []);
});

test('sophos login: portals survive saving, their hosts find the entry, the tag marks the flavour', () => {
  const item = normalizeItem({
    type: 'login', title: 'Firewall', username: 'vpnuser', password: 'Vpn-Pass-1', totp: 'JBSWY3DPEHPK3PXP', sophos: true,
    portals: [{ label: 'VPN-Portal', url: 'https://vpn.contoso.com' }, { label: ' Admin-Portal ', url: 'vpn.contoso.com:4444' }, { label: 'leer', url: '' }],
  });
  assert.ok(isSophosLogin(item));
  assert.deepEqual(item.portals.map((p) => p.label), ['VPN-Portal', 'Admin-Portal']);
  assert.ok(item.portals[1].url.startsWith('https://vpn.contoso.com:4444'));
  assert.deepEqual(itemHosts(item), ['vpn.contoso.com']);
  const { value, tags } = serializeItem(item);
  assert.equal(tags.sop, '1');
  assert.equal(tags.h, 'vpn.contoso.com');
  assert.equal(summaryFromSecret({ name: 'pws-1', tags }, 'kv').sophos, true);
  const back = parseItem({ name: 'pws-1', value }, 'kv');
  assert.equal(back.sophos, true);
  assert.deepEqual(back.portals, item.portals);
  assert.equal(back.password, 'Vpn-Pass-1', 'the stored password stays the password alone');
  // An ordinary login carries neither.
  const plain = serializeItem(normalizeItem({ type: 'login', title: 'x', urls: ['https://example.com'] }));
  assert.equal(plain.tags.sop, undefined);
  assert.equal(JSON.parse(plain.value).portals, undefined);
});

test('sophos login: the browser fill gets password + one-time code only with MFA and only for Sophos', () => {
  const sophos = normalizeItem({ type: 'login', sophos: true, password: 'Vpn-Pass-1', totp: 'JBSWY3DPEHPK3PXP' });
  assert.equal(sophosFillPassword(sophos, '123456'), 'Vpn-Pass-1123456');
  assert.equal(sophosFillPassword({ ...sophos, totp: '' }, '123456'), 'Vpn-Pass-1', 'without MFA the password alone');
  const other = normalizeItem({ type: 'login', password: 'Pw-1', totp: 'JBSWY3DPEHPK3PXP' });
  assert.equal(sophosFillPassword(other, '123456'), 'Pw-1', 'other logins never get the code appended');
});
