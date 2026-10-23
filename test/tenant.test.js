import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyVaultClient, challengeTenant } from '../extension/core/keyvault.js';
import { AzureClient } from '../extension/core/azure.js';
import { VaultSession, MemoryStore } from '../extension/core/session.js';

const HOME = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('challenge header names the tenant', () => {
  assert.equal(challengeTenant(`Bearer authorization="https://login.microsoftonline.com/${CUSTOMER}", resource="https://vault.azure.net"`), CUSTOMER);
  assert.equal(challengeTenant(`Bearer authorization_uri="https://login.windows.net/${CUSTOMER.toUpperCase()}"`), CUSTOMER);
  assert.equal(challengeTenant('Bearer realm=""'), null);
});

// A vault in the customer tenant: accepts only tokens of that tenant, otherwise 401 with challenge.
function customerVault() {
  return async (url, init) => {
    const token = init.headers.Authorization.slice(7);
    if (token !== `kv-${CUSTOMER}`) {
      return json(401, { error: { code: 'Unauthorized' } }, { 'www-authenticate': `Bearer authorization="https://login.microsoftonline.com/${CUSTOMER}", resource="https://vault.azure.net"` });
    }
    if (new URL(url).pathname === '/secrets') return json(200, { value: [] });
    return json(404, { error: { code: 'SecretNotFound' } });
  };
}

test('Key Vault client switches to the vault tenant from the 401 challenge', async () => {
  const asked = [];
  let learned = null;
  const kv = new KeyVaultClient({
    vaultUrl: 'kv-kunde',
    fetch: customerVault(),
    getToken: async (o) => {
      asked.push(o.tenantId || 'home');
      return `kv-${o.tenantId || HOME}`;
    },
    onTenant: (tenant) => { learned = tenant; },
  });
  assert.deepEqual(await kv.listSecrets(), []);
  assert.deepEqual(asked, ['home', CUSTOMER]);
  assert.equal(learned, CUSTOMER);
  // Wrong token even for the right tenant: no endless loop.
  const broken = new KeyVaultClient({ vaultUrl: 'kv-kunde', fetch: customerVault(), getToken: async () => 'nope' });
  await assert.rejects(broken.listSecrets(), (e) => e.status === 401);
});

test('session remembers the tenant of a container and uses it next time', async () => {
  const asked = [];
  const session = new VaultSession({
    getToken: async (scope, o = {}) => {
      asked.push(o.tenantId || 'home');
      return `kv-${o.tenantId || HOME}`;
    },
    store: new MemoryStore(),
    fetch: customerVault(),
  });
  await session.refreshContainers({ configured: [{ name: 'Kunde', vaultUrl: 'kv-kunde' }], discover: false });
  await session.refreshIndex();
  assert.equal((await session.container('kv-kunde.vault.azure.net')).tenantId, CUSTOMER);
  asked.length = 0;
  await session.refreshContainers({ configured: [{ name: 'Kunde', vaultUrl: 'kv-kunde' }], discover: false });
  await session.refreshIndex();
  assert.ok(asked.length && asked.every((x) => x === CUSTOMER), 'no detour over the home tenant');
});

test('discovery covers the tenants where the account is a guest; tenants needing sign-in are skipped', async () => {
  const vault = (name, tenantId) => ({ id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/${name}`, name, vaultUri: `https://${name}.vault.azure.net/`, rbac: true, tenantId });
  const session = new VaultSession({
    multiTenant: true,
    store: new MemoryStore(),
    getToken: async (scope, o = {}) => {
      if (o.tenantId === 'locked-tenant') throw new Error('interaction required');
      return `arm-${o.tenantId || HOME}`;
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      const tenant = init.headers.Authorization.slice(11);
      if (u.pathname === '/tenants') return json(200, { value: [{ tenantId: HOME }, { tenantId: CUSTOMER, displayName: 'Kunde' }, { tenantId: 'locked-tenant' }] });
      if (u.pathname.endsWith('/providers/Microsoft.ResourceGraph/resources')) {
        return json(200, { data: tenant === CUSTOMER ? [vault('kv-kunde', CUSTOMER)] : [vault('kv-eigen', HOME)] });
      }
      if (u.pathname.endsWith('/permissions')) return json(200, { value: [] });
      return json(404, {});
    },
  });
  const { containers } = await session.refreshContainers({});
  assert.deepEqual(containers.map((c) => [c.id, c.tenantId]).sort(), [['kv-eigen.vault.azure.net', HOME], ['kv-kunde.vault.azure.net', CUSTOMER]]);
});

test('invite guest, then assign roles even while the new principal replicates', async () => {
  let puts = 0;
  const calls = [];
  const azure = new AzureClient({
    getArmToken: async () => 'arm',
    getGraphToken: async () => 'graph',
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.pathname}`);
      if (u.pathname === '/v1.0/invitations') {
        assert.equal(JSON.parse(init.body).invitedUserEmailAddress, 'gast@partner.de');
        return json(201, { invitedUser: { id: 'guest-1' }, invitedUserDisplayName: 'Gast' });
      }
      if (init.method === 'PUT' && u.pathname.includes('roleAssignments')) {
        puts++;
        if (puts === 1) return json(400, { error: { code: 'PrincipalNotFound', message: 'not yet' } });
        return json(201, {});
      }
      if (init.method === 'GET' && u.pathname.includes('roleAssignments')) return json(200, { value: [] });
      return json(404, {});
    },
  });
  azure.retryDelay = 0;
  const guest = await azure.inviteGuest('gast@partner.de');
  assert.deepEqual([guest.id, guest.type], ['guest-1', 'User']);
  await azure.addMember('/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-kunde', guest, 'write');
  assert.ok(puts >= 3, 'retried after PrincipalNotFound, data role + reader assigned');

  const denied = new AzureClient({ getArmToken: async () => 'a', getGraphToken: async () => 'g', fetch: async () => json(403, { error: { code: 'Authorization_RequestDenied' } }) });
  await assert.rejects(denied.inviteGuest('x@y.de'), /Einladen nicht erlaubt/);
});
