import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTenant, bastionUrlInTenant, normalizeItem } from '../extension/core/model.js';

test('Bastion tenant: domain or tenant ID, portal link opened in that directory', () => {
  assert.equal(normalizeTenant(' @Contoso.com '), 'contoso.com');
  assert.equal(normalizeTenant('11111111-2222-3333-4444-555555555555'), '11111111-2222-3333-4444-555555555555');
  assert.equal(normalizeTenant('not a tenant'), '');
  assert.equal(bastionUrlInTenant('https://portal.azure.com/#@contoso.com/resource/vm/bastionHost', 'fabrikam.com'), 'https://portal.azure.com/#@fabrikam.com/resource/vm/bastionHost');
  assert.equal(bastionUrlInTenant('https://portal.azure.com/#/resource/vm/bastionHost', 'fabrikam.com'), 'https://portal.azure.com/#@fabrikam.com/resource/vm/bastionHost');
  assert.equal(bastionUrlInTenant('https://portal.azure.com/', 'fabrikam.com'), 'https://portal.azure.com/#@fabrikam.com');
  // Shareable links and an empty tenant stay as they are.
  assert.equal(bastionUrlInTenant('https://bst-1.bastion.azure.com/api/shareable-url/abc', 'fabrikam.com'), 'https://bst-1.bastion.azure.com/api/shareable-url/abc');
  assert.equal(bastionUrlInTenant('https://portal.azure.com/#@contoso.com/x', ''), 'https://portal.azure.com/#@contoso.com/x');
  assert.equal(normalizeItem({ type: 'server', server: { kind: 'azurevm', bastionTenant: 'Fabrikam.COM' } }).server.bastionTenant, 'fabrikam.com');
});
