import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fqdnUserName } from '../extension/core/model.js';

const ad = (username, fqdn = 'contoso.local') => ({ username, fields: [{ name: 'Domäne (NT)', value: 'CONTOSO' }, { name: 'Domäne (FQDN)', value: fqdn }] });

test('Bastion sign-in name: always the FQDN form when the AD login knows its domain', () => {
  assert.equal(fqdnUserName(ad('admin')), 'admin@contoso.local');
  assert.equal(fqdnUserName(ad('CONTOSO\\admin')), 'admin@contoso.local');
  assert.equal(fqdnUserName(ad('admin@other.org')), 'admin@other.org');
  assert.equal(fqdnUserName({ username: 'root' }), 'root');
  assert.equal(fqdnUserName({ username: 'admin', fields: [{ name: 'Domain (DNS)', value: 'corp.example' }] }), 'admin@corp.example');
});
