// Demo mode (desktop: npm run demo, extension: developer switch devDemo): the apps against an in-memory imitation of Key Vault, Resource Graph,
// RBAC and Graph – for trying out the interface without Azure. Nothing leaves the process.

import { serializeItem } from './model.js';

const VAULTS = [
  { name: 'kv-pws-demo-personal', displayName: 'Persönlich' },
  { name: 'kv-pws-demo-team', displayName: 'Team Infrastruktur' },
];

const SAMPLE = {
  'kv-pws-demo-personal': [
    { title: 'GitHub', username: 'alex@contoso.com', password: 'Fq7#xV2!mPz9@Lk4', urls: ['https://github.com/login'], totp: 'JBSWY3DPEHPK3PXP', favorite: true },
    { title: 'Microsoft 365', username: 'alex@contoso.com', password: 'Gh4$wQ8&nRt2*Ys6', urls: ['https://login.microsoftonline.com'], folder: 'Arbeit' },
    { type: 'note', title: 'WLAN Zuhause', notes: 'SSID: Contoso-Home\nPasswort: siehe Router-Aufkleber' },
  ],
  'kv-pws-demo-team': [
    { title: 'Firewall Admin', username: 'admin', password: 'Tz9!kB3#vNq7$Hw2', urls: ['https://fw01.contoso.local'], folder: 'Netzwerk' },
    { title: 'Azure Notfallkonto', username: 'breakglass@contoso.onmicrosoft.com', password: 'Xc5&rM8!pLq3#Vz7', urls: ['https://portal.azure.com'], folder: 'Notfall', favorite: true,
      notes: 'Nur im Notfall verwenden. Nutzung wird überwacht.' },
    { title: 'Grafana', username: 'ops', password: 'Lm2#tR6!wQz9&Kv4', urls: ['https://grafana.contoso.com'], folder: 'Monitoring',
      passkeys: [{ credentialId: 'ZGVtby1wYXNza2V5', rpId: 'grafana.contoso.com', rpName: 'Grafana', userName: 'ops', userHandle: 'b3Bz', privateKey: '', created: '2026-09-01T08:00:00Z' }] },
  ],
};

export function createDemoBackend() {
  const store = new Map(); // vault -> Map(name -> versions[])
  const deleted = new Map();
  let seq = 0;
  const now = () => Math.floor(Date.now() / 1000);
  for (const v of VAULTS) {
    store.set(v.name, new Map());
    deleted.set(v.name, new Map());
    for (const item of SAMPLE[v.name]) {
      const { value, contentType, tags } = serializeItem(item, 'alex@contoso.com');
      store.get(v.name).set(`pws-demo${++seq}`, [{ version: `v${seq}a`, value, contentType, tags, attributes: { enabled: true, updated: now() - seq * 3600 } }]);
    }
  }

  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const resourceId = (name) => `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-kvpwsafe-demo/providers/Microsoft.KeyVault/vaults/${name}`;

  function keyVault(url, method, body) {
    const vault = url.hostname.split('.')[0];
    const secrets = store.get(vault);
    const trash = deleted.get(vault);
    if (!secrets) return json(404, { error: { message: 'Vault not found' } });
    const [kind, name, version] = url.pathname.split('/').filter(Boolean);
    const base = `https://${url.hostname}`;
    const meta = (n, v) => ({ id: `${base}/secrets/${n}`, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
    const bundle = (n, v) => ({ ...meta(n, v), id: `${base}/secrets/${n}/${v.version}`, value: v.value });
    if (kind === 'secrets' && !name) return json(200, { value: [...secrets].map(([n, vs]) => meta(n, vs.at(-1))) });
    if (kind === 'secrets' && version === 'versions') {
      return json(200, { value: (secrets.get(name) || []).map((v) => ({ ...meta(name, v), id: `${base}/secrets/${name}/${v.version}` })) });
    }
    if (kind === 'secrets' && method === 'GET') {
      const vs = secrets.get(name);
      const v = vs && (version ? vs.find((x) => x.version === version) : vs.at(-1));
      return v ? json(200, bundle(name, v)) : json(404, { error: { message: 'Nicht gefunden' } });
    }
    if (kind === 'secrets' && method === 'PUT') {
      const b = JSON.parse(body);
      const v = { version: `v${++seq}`, value: b.value, contentType: b.contentType, tags: b.tags, attributes: { enabled: true, updated: now() } };
      secrets.set(name, [...(secrets.get(name) || []), v]);
      return json(200, bundle(name, v));
    }
    if (kind === 'secrets' && method === 'DELETE') {
      trash.set(name, { versions: secrets.get(name), deletedDate: now() });
      secrets.delete(name);
      return json(200, {});
    }
    if (kind === 'deletedsecrets' && method === 'GET') {
      return json(200, { value: [...trash].map(([n, d]) => ({ ...meta(n, d.versions.at(-1)), recoveryId: `${base}/deletedsecrets/${n}`, deletedDate: d.deletedDate, scheduledPurgeDate: d.deletedDate + 90 * 86400 })) });
    }
    if (kind === 'deletedsecrets' && version === 'recover') {
      secrets.set(name, trash.get(name).versions);
      trash.delete(name);
      return json(200, {});
    }
    if (kind === 'deletedsecrets' && method === 'DELETE') {
      trash.delete(name);
      return json(204);
    }
    return json(400, { error: { message: 'Im Demo-Modus nicht unterstützt' } });
  }

  function arm(url, method) {
    if (url.pathname.endsWith('/providers/Microsoft.ResourceGraph/resources')) {
      return json(200, { data: VAULTS.map((v) => ({ id: resourceId(v.name), name: v.name, displayName: v.displayName, vaultUri: `https://${v.name}.vault.azure.net/`, rbac: true, tagged: true, resourceGroup: 'rg-pwsafe' })) });
    }
    if (url.pathname === '/tenants') {
      return json(200, { value: [{ tenantId: '00000000-0000-0000-0000-000000000000', displayName: 'Contoso', defaultDomain: 'contoso.com' }] });
    }
    if (url.pathname.endsWith('/providers/Microsoft.Authorization/permissions')) {
      return json(200, { value: [{ actions: ['*'], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'] }] });
    }
    if (url.pathname.includes('/providers/Microsoft.Authorization/roleAssignments') && method === 'GET') {
      const scope = url.pathname.split('/providers/Microsoft.Authorization/')[0];
      const assignment = (principalId, principalType, role, inherited = false) => ({
        id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${principalId}-${role}`,
        properties: { roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${role}`, principalId, principalType, scope: inherited ? '/subscriptions/00000000-0000-0000-0000-000000000000' : scope },
      });
      return json(200, { value: [
        assignment('u-alex', 'User', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'),
        assignment('u-alex', 'User', '8b54135c-b56d-4d72-a534-26097cfdc8d8'),
        assignment('g-ops', 'Group', '4633458b-17de-408a-b874-0445c86b69e6'),
        assignment('u-admin', 'User', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', true),
      ] });
    }
    if (/^\/subscriptions\/[^/]+$/.test(url.pathname)) return json(200, { subscriptionId: url.pathname.split('/')[2], tenantId: '00000000-0000-0000-0000-000000000000', displayName: 'Demo-Abonnement', state: 'Enabled' });
    if (url.pathname === '/subscriptions') return json(200, { value: [{ subscriptionId: '00000000-0000-0000-0000-000000000000', displayName: 'Demo-Abonnement', state: 'Enabled' }] });
    return json(403, { error: { code: 'Demo', message: 'Im Demo-Modus nicht verfügbar' } });
  }

  const people = { 'u-alex': ['Alex Demo', 'alex@contoso.com'], 'g-ops': ['Ops-Team', 'Sicherheitsgruppe'], 'u-admin': ['Azure Admin', 'admin@contoso.com'] };
  function graph(url, method, body) {
    if (url.pathname.endsWith('/$batch') && method === 'POST') {
      const { requests } = JSON.parse(body);
      return json(200, { responses: requests.map((r) => {
        const id = r.url.split('/')[2].split('?')[0];
        return { id: r.id, status: people[id] ? 200 : 404, body: { displayName: people[id]?.[0], userPrincipalName: people[id]?.[1] } };
      }) });
    }
    if (url.pathname.endsWith('/users')) return json(200, { value: [{ id: 'u-kim', displayName: 'Kim Beispiel', userPrincipalName: 'kim@contoso.com' }] });
    if (url.pathname.endsWith('/groups')) return json(200, { value: [{ id: 'g-dev', displayName: 'Entwicklung', securityEnabled: true }] });
    return json(404, { error: { message: 'Nicht gefunden' } });
  }

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    if (url.hostname.endsWith('.vault.azure.net')) return keyVault(url, method, init.body);
    if (url.hostname === 'management.azure.com') return arm(url, method);
    if (url.hostname === 'graph.microsoft.com') return graph(url, method, init.body);
    return json(404, {});
  }

  return {
    fetch,
    account: { name: 'Alex Demo', username: 'alex@contoso.com', tenantId: '00000000-0000-0000-0000-000000000000', localAccountId: 'u-alex' },
  };
}
