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
    { type: 'note', title: 'WLAN Gäste', notes: 'SSID: Contoso-Gaeste\nPasswort: siehe Aushang am Empfang' },
    { title: 'Streaming-Abo', username: 'alex@contoso.com', password: 'Nb6!dK3#yWq8$Rt5', urls: ['https://streaming.contoso.com'], folder: 'Privat' },
    { type: 'note', title: 'Urlaubsideen', notes: 'Küstenwanderung im Herbst, Zugfahrt planen.', folder: 'Privat' },
  ],
  'kv-pws-demo-team': [
    // Dates for the compliance view (#500): an old password, one never changed since creation, one changed recently.
    { title: 'Firewall Admin', username: 'admin', password: 'Tz9!kB3#vNq7$Hw2', urls: ['https://fw01.contoso.local'], folder: 'Netzwerk',
      created: '2025-03-01T08:00:00Z', passwordChanged: '2025-06-15T08:00:00Z' },
    { title: 'Azure Notfallkonto', username: 'breakglass@contoso.onmicrosoft.com', password: 'Xc5&rM8!pLq3#Vz7', urls: ['https://portal.azure.com'], folder: 'Notfall', favorite: true,
      notes: 'Nur im Notfall verwenden. Nutzung wird überwacht.', created: '2025-09-01T08:00:00Z' },
    { title: 'Grafana', username: 'ops', password: 'Lm2#tR6!wQz9&Kv4', urls: ['https://grafana.contoso.com'], folder: 'Monitoring',
      created: '2025-05-01T08:00:00Z', passwordChanged: '2026-09-20T08:00:00Z',
      passkeys: [{ credentialId: 'ZGVtby1wYXNza2V5', rpId: 'grafana.contoso.com', rpName: 'Grafana', userName: 'ops', userHandle: 'b3Bz', privateKey: '', created: '2026-09-01T08:00:00Z' }] },
  ],
};

// Example Azure around the vaults (setup wizard): resource groups, regions and an empty Key Vault to take over.
const SUB = '00000000-0000-0000-0000-000000000000';
/** A member who left (#500): her role assignment was deleted 30 days ago (activity log). */
const KIM = '11111111-2222-4333-8444-555555555555';
const GROUPS = [
  { name: 'rg-pwsafe', location: 'germanywestcentral' },
  { name: 'rg-security', location: 'westeurope' },
  { name: 'rg-team-it', location: 'germanywestcentral' },
];
const REGIONS = [{ name: 'germanywestcentral', displayName: 'Germany West Central' }, { name: 'westeurope', displayName: 'West Europe' },
  { name: 'northeurope', displayName: 'North Europe' }, { name: 'switzerlandnorth', displayName: 'Switzerland North' }];

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

  // Key Vault resources (ARM): the demo vaults, an empty one in rg-security and the ones created in the wizard.
  const vaultResources = new Map(VAULTS.map((v) => [v.name, { group: 'rg-pwsafe', location: 'germanywestcentral', tags: { kvpwsafe: 'container', 'kvpwsafe-name': v.displayName } }]));
  for (const name of ['kv-pws-demo-leer']) {
    store.set(name, new Map());
    deleted.set(name, new Map());
    vaultResources.set(name, { group: 'rg-security', location: 'westeurope', tags: {} });
  }
  const vaultResource = (name) => {
    const r = vaultResources.get(name);
    return { id: `/subscriptions/${SUB}/resourceGroups/${r.group}/providers/Microsoft.KeyVault/vaults/${name}`, name, location: r.location, tags: r.tags,
      properties: { tenantId: SUB, vaultUri: `https://${name}.vault.azure.net/`, enableRbacAuthorization: true, enableSoftDelete: true, softDeleteRetentionInDays: 90,
        enablePurgeProtection: !!r.purge, provisioningState: 'Succeeded', sku: { family: 'A', name: 'standard' } } };
  };

  const made = new Map(); // resource groups created in the demo
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

  // Monitoring (#486): Log Analytics workspaces, diagnostic settings, alert rules – kept as written, with systemData.
  const monitor = new Map([[`/subscriptions/${SUB}/resourceGroups/rg-security/providers/Microsoft.OperationalInsights/workspaces/law-contoso`,
    { name: 'law-contoso', location: 'westeurope', properties: { retentionInDays: 30, provisioningState: 'Succeeded' } }]]);
  // Log Analytics query API (#500): fixed answers per report, named in the query's first line ("// keevault:<kind>").
  // Kim read the firewall before and Grafana after its last password change but before it changed again; pws-gone is
  // an entry that no longer exists (shown masked).
  function logQuery(body) {
    const kind = /^\/\/ keevault:(\w+)/.exec(JSON.parse(body || '{}').query || '')?.[1];
    const table = (columns, rows) => json(200, { tables: [{ name: 'PrimaryResult', columns: columns.map((name) => ({ name, type: 'string' })), rows }] });
    const kim = 'kim@contoso.com';
    if (kind === 'coverage') return table(['First', 'Last', 'Events'], [['2025-11-01T08:00:00Z', new Date().toISOString(), 412]]);
    if (kind === 'reads') {
      return table(['Person', 'Oid', 'Entry', 'Reads', 'First', 'Last'], [
        [kim, KIM, 'pws-demo6', 4, '2025-11-03T09:00:00Z', '2025-12-01T10:00:00Z'],
        [kim, KIM, 'pws-demo8', 2, '2026-01-10T09:00:00Z', '2026-01-15T10:00:00Z'],
        [kim, KIM, 'pws-gone', 1, '2025-12-02T09:00:00Z', '2025-12-02T09:00:00Z'],
        ['alex@contoso.com', 'u-alex', 'pws-demo7', 7, '2025-11-05T09:00:00Z', '2026-11-01T10:00:00Z'],
      ]);
    }
    if (kind === 'many') return table(['Person', 'Hour', 'Entries', 'Reads'], [[kim, '2026-01-15T10:00:00Z', 31, 44]]);
    if (kind === 'denied') return table(['TimeGenerated', 'Person', 'OperationName', 'Entry', 'CallerIPAddress'], [['2026-02-01T07:00:00Z', kim, 'SecretGet', 'pws-demo7', '203.0.113.7']]);
    if (kind === 'apps') return table(['App', 'Person', 'Requests', 'First', 'Last', 'Operations'], [['22222222-3333-4444-8555-666666666666', kim, 12, '2026-01-02T08:00:00Z', '2026-01-03T08:00:00Z', ['SecretList', 'SecretGet']]]);
    if (kind === 'changes') return table(['TimeGenerated', 'Person', 'OperationName', 'Entry'], [['2026-09-20T08:00:00Z', 'alex@contoso.com', 'SecretSet', 'pws-demo8'], ['2026-03-01T08:00:00Z', 'alex@contoso.com', 'SecretDelete', 'pws-gone']]);
    return json(400, { error: { code: 'BadArgumentError', message: 'unknown query' } });
  }

  function monitoring(p, method, body) {
    if (/\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+\/api\/query$/i.test(p) && method === 'POST') return logQuery(body);
    const key = p.replace(/\/register$/, '');
    if (/^\/subscriptions\/[^/]+\/providers\/Microsoft\.(OperationalInsights|Insights)$/i.test(key)) return json(200, { namespace: key.split('/').pop(), registrationState: 'Registered' });
    if (p.endsWith('/providers/Microsoft.Insights/diagnosticSettings') && method === 'GET') {
      return json(200, { value: [...monitor].filter(([k]) => k.toLowerCase().startsWith(`${p.toLowerCase()}/`)).map(([id, v]) => ({ id, ...v })) });
    }
    if (!/\/providers\/Microsoft\.(OperationalInsights\/workspaces|Insights\/(diagnosticSettings|actionGroups|scheduledQueryRules|activityLogAlerts))\/[^/]+$/i.test(p)) return null;
    const had = monitor.get(p);
    if (method === 'GET') return had ? json(200, { id: p, ...had }) : json(404, { error: { code: 'ResourceNotFound', message: 'Not found' } });
    if (method === 'DELETE') { monitor.delete(p); return json(200, {}); }
    if (method !== 'PUT' && method !== 'PATCH') return null;
    const b = JSON.parse(body || '{}');
    const at = new Date().toISOString();
    const next = method === 'PATCH' ? { ...had, properties: { ...had?.properties, ...b.properties } } : { ...b, name: p.split('/').pop() };
    if (/OperationalInsights/i.test(p)) next.properties = { ...next.properties, provisioningState: 'Succeeded' };
    next.systemData = { createdAt: had?.systemData?.createdAt || at, createdBy: 'alex@contoso.com', lastModifiedAt: at, lastModifiedBy: 'alex@contoso.com' };
    monitor.set(p, next);
    return json(200, { id: p, ...next });
  }

  function arm(url, method, body) {
    const p = url.pathname;
    const watched = monitoring(p, method, body);
    if (watched) return watched;
    const oneGroup = /^\/subscriptions\/[^/]+\/resourcegroups\/([^/]+)$/i.exec(p);
    if (oneGroup && method === 'GET') {
      const g = GROUPS.find((x) => x.name.toLowerCase() === oneGroup[1].toLowerCase()) || made.get(oneGroup[1].toLowerCase());
      return g ? json(200, { id: p, ...g }) : json(404, { error: { code: 'ResourceGroupNotFound', message: 'Not found' } });
    }
    if (oneGroup && method === 'PUT') {
      made.set(oneGroup[1].toLowerCase(), { name: oneGroup[1], location: JSON.parse(body || '{}').location });
      return json(201, { id: p, ...made.get(oneGroup[1].toLowerCase()) });
    }
    if (/^\/subscriptions\/[^/]+\/resourcegroups$/i.test(p)) return json(200, { value: GROUPS.map((g) => ({ id: `/subscriptions/${SUB}/resourceGroups/${g.name}`, ...g })) });
    if (/^\/subscriptions\/[^/]+\/locations$/.test(p)) return json(200, { value: REGIONS.map((r) => ({ ...r, metadata: { regionType: 'Physical' } })) });
    if (p.endsWith('/providers/Microsoft.KeyVault/checkNameAvailability')) {
      const { name } = JSON.parse(body || '{}');
      return json(200, store.has(name) ? { nameAvailable: false, reason: 'AlreadyExists', message: `Der Name „${name}“ ist bereits vergeben.` } : { nameAvailable: true });
    }
    const group = /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults$/i.exec(p);
    if (group && method === 'GET') return json(200, { value: [...vaultResources].filter(([, r]) => r.group === group[1]).map(([name]) => vaultResource(name)) });
    const one = /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/i.exec(p);
    if (one && method === 'PUT') {
      const b = JSON.parse(body || '{}');
      store.set(one[2], new Map());
      deleted.set(one[2], new Map());
      vaultResources.set(one[2], { group: one[1], location: b.location, tags: b.tags || {}, purge: !!b.properties?.enablePurgeProtection });
      return json(200, vaultResource(one[2]));
    }
    if (one && vaultResources.has(one[2]) && method === 'PATCH') {
      const b = JSON.parse(body || '{}');
      if (b.tags) vaultResources.get(one[2]).tags = b.tags;
      return json(200, vaultResource(one[2]));
    }
    if (one && vaultResources.has(one[2]) && method === 'GET') return json(200, vaultResource(one[2]));
    if (p.includes('/providers/Microsoft.Authorization/roleAssignments/') && method === 'PUT') return json(201, { id: p, properties: JSON.parse(body || '{}').properties });
    if (url.pathname.endsWith('/providers/Microsoft.ResourceGraph/resources')) {
      if (/operationalinsights\/workspaces/i.test(JSON.parse(body || '{}').query || '')) {
        return json(200, { data: [...monitor].filter(([k]) => /\/workspaces\/[^/]+$/i.test(k)).map(([id, v]) => ({ id, name: v.name, resourceGroup: id.split('/')[4],
          subscriptionId: SUB, location: v.location, retention: v.properties?.retentionInDays })) });
      }
      return json(200, { data: VAULTS.map((v) => ({ id: resourceId(v.name), name: v.name, displayName: v.displayName, vaultUri: `https://${v.name}.vault.azure.net/`, rbac: true, tagged: true, resourceGroup: 'rg-pwsafe' })) });
    }
    if (url.pathname === '/tenants') {
      return json(200, { value: [{ tenantId: '00000000-0000-0000-0000-000000000000', displayName: 'Contoso', defaultDomain: 'contoso.com' }] });
    }
    if (url.pathname.endsWith('/providers/Microsoft.Authorization/permissions')) {
      // The demo user is Key Vault Administrator (vault settings available).
      return json(200, { value: [{ actions: ['*'], dataActions: ['Microsoft.KeyVault/vaults/*'] }] });
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
    if (/\/providers\/Microsoft\.Insights\/eventtypes\/management\/values$/i.test(url.pathname)) {
      const at = new Date(Date.now() - 30 * 86_400_000).toISOString();
      // Both resource IDs of a demo vault (Resource Graph and ARM name different groups).
      return json(200, { value: VAULTS.flatMap((v) => [resourceId(v.name), vaultResource(v.name).id]).flatMap((id) => ['Started', 'Succeeded'].map((status) => ({
        operationName: { value: 'Microsoft.Authorization/roleAssignments/delete' }, status: { value: status }, eventTimestamp: at, caller: 'alex@contoso.com',
        resourceId: `${id}/providers/Microsoft.Authorization/roleAssignments/${KIM}-secrets-user`,
        properties: { responseBody: JSON.stringify({ properties: { principalId: KIM, roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6' } }) },
      }))) });
    }
    if (/^\/subscriptions\/[^/]+$/.test(url.pathname)) return json(200, { subscriptionId: url.pathname.split('/')[2], tenantId: '00000000-0000-0000-0000-000000000000', displayName: 'Demo-Abonnement', state: 'Enabled' });
    if (url.pathname === '/subscriptions') return json(200, { value: [{ subscriptionId: '00000000-0000-0000-0000-000000000000', displayName: 'Demo-Abonnement', state: 'Enabled' }] });
    return json(403, { error: { code: 'Demo', message: 'Im Demo-Modus nicht verfügbar' } });
  }

  const people = { 'u-alex': ['Alex Demo', 'alex@contoso.com'], 'g-ops': ['Ops-Team', 'Sicherheitsgruppe'], 'u-admin': ['Azure Admin', 'admin@contoso.com'], [KIM]: ['Kim Beispiel', 'kim@contoso.com'] };
  function graph(url, method, body) {
    if (url.pathname.endsWith('/$batch') && method === 'POST') {
      const { requests } = JSON.parse(body);
      return json(200, { responses: requests.map((r) => {
        const id = r.url.split('/')[2].split('?')[0];
        return { id: r.id, status: people[id] ? 200 : 404, body: { displayName: people[id]?.[0], userPrincipalName: people[id]?.[1] } };
      }) });
    }
    if (url.pathname.endsWith('/me')) return json(200, { id: 'u-alex', displayName: 'Alex Demo', userPrincipalName: 'alex@contoso.com' });
    if (url.pathname.endsWith('/invitations') && method === 'POST') {
      const { invitedUserEmailAddress: email } = JSON.parse(body || '{}');
      return json(201, { invitedUser: { id: `guest-${email}` }, invitedUserDisplayName: email });
    }
    if (url.pathname.endsWith('/users')) return json(200, { value: [{ id: 'u-kim', displayName: 'Kim Beispiel', userPrincipalName: 'kim@contoso.com' }] });
    if (url.pathname.endsWith('/groups')) return json(200, { value: [{ id: 'g-dev', displayName: 'Entwicklung', securityEnabled: true }] });
    return json(404, { error: { message: 'Nicht gefunden' } });
  }

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    if (url.hostname.endsWith('.vault.azure.net')) return keyVault(url, method, init.body);
    if (url.hostname === 'management.azure.com') return arm(url, method, init.body);
    if (url.hostname === 'graph.microsoft.com') return graph(url, method, init.body);
    return json(404, {});
  }

  return {
    fetch,
    account: { name: 'Alex Demo', username: 'alex@contoso.com', tenantId: '00000000-0000-0000-0000-000000000000', localAccountId: 'u-alex' },
  };
}
