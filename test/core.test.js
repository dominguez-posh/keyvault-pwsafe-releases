import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totpCode, hotp, parseTotp } from '../extension/core/totp.js';
import { hostMatches, hostFromUrl, urlScore } from '../extension/core/match.js';
import { generatePassword, passwordStrength } from '../extension/core/generator.js';
import { serializeItem, summaryFromSecret, parseItem, ItemTooLargeError } from '../extension/core/model.js';
import { normalizeVaultUrl } from '../extension/core/keyvault.js';
import { utf8 } from '../extension/core/util.js';
import { parseInvite, buildInvite, accessFromPermissions } from '../extension/core/azure.js';

test('TOTP matches RFC 6238 test vectors', async () => {
  const secret = utf8('12345678901234567890');
  assert.equal(await hotp(secret, Math.floor(59 / 30), 8, 'SHA-1'), '94287082');
  assert.equal(await hotp(secret, Math.floor(1111111109 / 30), 8, 'SHA-1'), '07081804');
  const sha256Secret = utf8('12345678901234567890123456789012');
  assert.equal(await hotp(sha256Secret, Math.floor(59 / 30), 8, 'SHA-256'), '46119246');
  // "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" is the Base32 form of the SHA-1 test secret.
  const code = await totpCode('otpauth://totp/ACME:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8', 59_000);
  assert.equal(code.code, '94287082');
  assert.equal(code.remaining, 1);
  assert.equal(parseTotp('otpauth://totp/ACME:alice?secret=GEZDGNBV&issuer=ACME').account, 'alice');
});

test('host matching is strict', () => {
  assert.ok(hostMatches('login.example.com', 'example.com'));
  assert.ok(hostMatches('www.example.com', 'example.com'));
  assert.ok(hostMatches('example.com', 'www.example.com'));
  assert.ok(!hostMatches('evilexample.com', 'example.com'));
  assert.ok(!hostMatches('example.com', 'login.example.com'));
  assert.ok(!hostMatches('a.github.io', 'b.github.io'));
  assert.equal(hostFromUrl('github.com/login'), 'github.com');
  assert.equal(hostFromUrl('javascript:alert(1)'), null);
});

test('password generator', () => {
  for (let i = 0; i < 50; i++) {
    const pw = generatePassword({ length: 16 });
    assert.equal(pw.length, 16);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /\d/);
    assert.doesNotMatch(pw, /[Il1O0o]/);
  }
  assert.equal(generatePassword({ length: 12, upper: false, digits: false, symbols: false }).match(/[a-z]/g).length, 12);
  assert.equal(passwordStrength(generatePassword({ length: 24 })).label, 'stark');
  assert.equal(passwordStrength('abc').label, 'schwach');
});

test('item serialization keeps list fields in tags', () => {
  const { value, tags, contentType } = serializeItem({
    title: 'GitHub', username: 'octo', password: 'pw', urls: ['github.com/login', 'https://www.github.com'],
    passkeys: [{ credentialId: 'AQID', rpId: 'GitHub.com', privateKey: 'x' }], totp: 'JBSWY3DP', favorite: true,
  }, 'alice@contoso.com');
  assert.match(contentType, /kvpwsafe/);
  assert.equal(tags.kvpwsafe, 'item');
  assert.equal(tags.n, 'GitHub');
  assert.equal(tags.h, 'github.com');
  assert.equal(tags.rp, 'github.com');
  assert.equal(tags.fav, '1');
  assert.ok(Object.keys(tags).length <= 15);
  const summary = summaryFromSecret({ name: 'pws-1', tags, attributes: { updated: 100 } }, 'c1');
  assert.deepEqual(summary.hosts, ['github.com']);
  assert.equal(summary.updated, 100_000);
  const item = parseItem({ name: 'pws-1', version: 'v1', value }, 'c1');
  assert.equal(item.updatedBy, 'alice@contoso.com');
  assert.deepEqual(item.urls, ['https://github.com/login', 'https://www.github.com']);
  assert.throws(() => serializeItem({ title: 'x', notes: 'a'.repeat(30_000) }), ItemTooLargeError);
});

test('vault URLs and invites', () => {
  assert.equal(normalizeVaultUrl('kv-team'), 'https://kv-team.vault.azure.net');
  assert.equal(normalizeVaultUrl('https://KV-Team.vault.azure.net/'), 'https://kv-team.vault.azure.net');
  assert.throws(() => normalizeVaultUrl('https://evil.example.com'));
  assert.throws(() => normalizeVaultUrl('http://kv-team.vault.azure.net'));
  const invite = buildInvite({ vaultUrl: 'https://kv-team.vault.azure.net', name: 'Team Ops' });
  assert.deepEqual(parseInvite(`Hallo, hier der Link: ${invite}`), { vaultUrl: 'https://kv-team.vault.azure.net', name: 'Team Ops' });
  assert.equal(parseInvite('https://kv-x1.vault.azure.net/').vaultUrl, 'https://kv-x1.vault.azure.net');
});

test('ARM permissions → access level', () => {
  const officer = [{ actions: ['Microsoft.KeyVault/vaults/*/read'], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'], notDataActions: [] }];
  assert.deepEqual(accessFromPermissions(officer), { read: true, write: true, manage: false, admin: false });
  const user = [{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/getSecret/action', 'Microsoft.KeyVault/vaults/secrets/readMetadata/action'] }];
  assert.deepEqual(accessFromPermissions(user), { read: true, write: false, manage: false, admin: false });
  const owner = [{ actions: ['*'], notActions: [], dataActions: [] }];
  assert.deepEqual(accessFromPermissions(owner), { read: false, write: false, manage: true, admin: false });
});

test('Key Vault Administrator is recognized from the permissions (Secrets Officer is not)', async () => {
  const { accessFromPermissions } = await import('../extension/core/azure.js');
  const officer = accessFromPermissions([{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'] }]);
  const admin = accessFromPermissions([{ actions: ['Microsoft.Authorization/*/read'], dataActions: ['Microsoft.KeyVault/vaults/*'] }]);
  assert.equal(officer.write, true);
  assert.equal(officer.admin, false);
  assert.equal(admin.admin, true);
});

test('CSV export: quoting, card fields, BOM', async () => {
  const { itemsToCsv } = await import('../extension/core/export.js');
  const csv = itemsToCsv([{ type: 'login', title: 'A, "B"', username: 'u', password: 'p', urls: ['https://a'], notes: 'x\ny', fields: [] },
    { type: 'card', title: 'Visa', urls: [], fields: [], card: { holder: 'Kim', number: '4111', expiry: '12/28', cvc: '1', pin: '2' } }]);
  assert.ok(csv.startsWith('﻿folder,favorite,type,name'));
  assert.ok(csv.includes('"A, ""B"""'));
  assert.ok(csv.includes('"x\ny"'));
  assert.ok(csv.includes(',Kim,4111,12/28,1,2,'));
});

test('urlScore: an entry for the exact path ranks above one for the bare host, both stay matches', () => {
  const page = 'https://keevault.de/admin/';
  const admin = urlScore(['https://keevault.de/admin'], page);
  const site = urlScore(['https://keevault.de'], page);
  const partner = urlScore(['keevault.de/partner'], page);
  assert.ok(admin > site, 'exact path first');
  assert.ok(site > partner, 'another path ranks below the bare host');
  assert.ok(partner > 0, 'but still belongs to the site');
  assert.equal(urlScore(['https://other.example'], page), 0);
  assert.ok(urlScore(['keevault.de/admin'], 'https://keevault.de/admin/users') > urlScore(['keevault.de'], 'https://keevault.de/admin/users'));
  assert.ok(urlScore(['https://keevault.de'], 'https://www.keevault.de/') >= 2, 'www is the same host');
  assert.equal(urlScore(['x'], 'kein-url'), 0);
});
