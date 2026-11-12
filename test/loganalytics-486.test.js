// #486: Log Analytics for a Key Vault – options, KQL, dry run (only reads), the requests written, missing rights as a
// clear sentence, status. Against an imitation of ARM; at the end once against the demo backend through AzureClient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureClient, AzureError } from '../extension/core/azure.js';
import { createDemoBackend } from '../extension/core/demo.js';
import { DIAG_NAME, applyLogging, deniedQuery, loggingStatus, normalizeLoggingOptions, planLogging, readsQuery } from '../extension/core/loganalytics.js';

const SUB = '11111111-2222-3333-4444-555555555555';
const VAULT = `/subscriptions/${SUB}/resourceGroups/rg-vaults/providers/Microsoft.KeyVault/vaults/kv-team`;
const WS = `/subscriptions/${SUB}/resourceGroups/rg-keevault-logs/providers/Microsoft.OperationalInsights/workspaces/law-keevault`;
const ALL = [{ actions: ['*'], notActions: [] }];

/** ARM imitation: `res` maps "METHOD path" (or "GET path") to a value, an Error or a function. Records every call. */
function fakeAzure(res = {}, perms = () => ALL) {
  const calls = [];
  return {
    calls,
    retryDelay: 0,
    async arm(method, path, apiVersion, body) {
      calls.push({ method, path, apiVersion, body });
      const r = res[`${method} ${path}`];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      if (r === undefined) {
        if (method === 'GET') throw new AzureError(404, 'NotFound', `not found ${path}`);
        return {};
      }
      return r;
    },
    async armList(path) {
      calls.push({ method: 'LIST', path });
      return perms(path.replace('/providers/Microsoft.Authorization/permissions', ''));
    },
    async resourceGraph() {
      return [];
    },
  };
}

const opts = (over = {}) => normalizeLoggingOptions({
  workspace: { mode: 'new', resourceGroup: 'rg-keevault-logs', name: 'law-keevault', location: 'germanywestcentral' },
  email: 'it@contoso.com', ...over,
}, VAULT);

test('options: defaults, and wrong input becomes a sentence for the user', () => {
  const o = opts();
  assert.equal(o.retentionDays, 90);
  assert.equal(o.workspace.subscriptionId, SUB);
  assert.deepEqual(o.reads, { mode: 'baseline', factor: 3, minimum: 20 });
  assert.equal(o.denied, false);
  assert.throws(() => opts({ email: 'kein-mail' }), /E-Mail/);
  assert.throws(() => opts({ retentionDays: 5000 }), /Aufbewahrung/);
  assert.throws(() => opts({ workspace: { mode: 'new', resourceGroup: 'rg/../x', name: 'law', location: 'x' } }), /Ressourcengruppe/);
  assert.throws(() => opts({ workspace: { mode: 'existing', id: '/subscriptions/x/evil' } }), /Workspace/);
  assert.throws(() => opts({ reads: { mode: 'fixed', threshold: 0 } }), /Schwelle/);
  assert.throws(() => normalizeLoggingOptions({ email: 'it@contoso.com' }, `${VAULT}"; drop`), /nicht sichtbar/);
});

test('KQL: only this vault, reads per person, fixed and baseline thresholds, denied without the 401 challenge', () => {
  const fixed = readsQuery(VAULT, { mode: 'fixed', threshold: 40 });
  assert.match(fixed, /^AzureDiagnostics\n/);
  assert.match(fixed, /Category == "AuditEvent"/);
  assert.ok(fixed.includes(`_ResourceId =~ "${VAULT.toLowerCase()}"`));
  assert.match(fixed, /OperationName == "SecretGet"/);
  assert.match(fixed, /summarize Reads = dcount\(Entry\) by Person/);
  assert.match(fixed, /where Reads > 40$/);
  assert.match(fixed, /column_ifexists\("identity_claim_upn_s", ""\)/);
  const base = readsQuery(VAULT, { mode: 'baseline', factor: 4, minimum: 25 });
  assert.match(base, /^let reads = AzureDiagnostics/);
  assert.match(base, /ago\(2d\)/);
  assert.match(base, /max_of\(25, Usual \* 4\)/);
  const denied = deniedQuery(VAULT);
  assert.match(denied, /httpStatusCode_d\) == 403/);
  assert.doesNotMatch(denied, /401/);
  assert.match(denied, /"SecretDelete", "SecretPurge", "VaultDelete"/);
  assert.throws(() => readsQuery('/subscriptions/x"|evil', { mode: 'fixed', threshold: 1 }));
});

test('dry run, new workspace: reads only, and lists group, workspace, diagnostic setting, action group, rules, activity alert', async () => {
  const az = fakeAzure({ [`GET /subscriptions/${SUB}/providers/Microsoft.OperationalInsights`]: { registrationState: 'NotRegistered' },
    [`GET /subscriptions/${SUB}/providers/Microsoft.Insights`]: { registrationState: 'Registered' } });
  const plan = await planLogging(az, VAULT, opts({ denied: true, retentionDays: 180 }));
  assert.ok(az.calls.every((c) => c.method === 'GET' || c.method === 'LIST'), 'the dry run wrote something');
  assert.deepEqual(plan.steps.map((s) => `${s.id}:${s.kind}`),
    ['register-Microsoft.OperationalInsights:register', 'group:create', 'workspace:create', 'diagnostics:create', 'actiongroup:create', 'reads:create', 'denied:create', 'activity:create']);
  assert.equal(plan.blocked, false);
  const by = Object.fromEntries(plan.steps.map((s) => [s.id, s.request]));
  assert.deepEqual(by.group, { method: 'PUT', path: `/subscriptions/${SUB}/resourceGroups/rg-keevault-logs`, apiVersion: '2021-04-01', body: { location: 'germanywestcentral' } });
  assert.equal(by.workspace.path, WS);
  assert.deepEqual(by.workspace.body.properties, { sku: { name: 'PerGB2018' }, retentionInDays: 180 });
  assert.equal(by.diagnostics.path, `${VAULT}/providers/Microsoft.Insights/diagnosticSettings/${DIAG_NAME}`);
  assert.deepEqual(by.diagnostics.body.properties, { workspaceId: WS, logs: [{ category: 'AuditEvent', enabled: true }], metrics: [{ category: 'AllMetrics', enabled: true }] });
  assert.deepEqual(by.actiongroup.body.properties.emailReceivers, [{ name: 'mail-1', emailAddress: 'it@contoso.com', useCommonAlertSchema: true }]);
  const reads = by.reads.body;
  assert.equal(reads.kind, 'LogAlert');
  assert.deepEqual(reads.properties.scopes, [WS]);
  assert.equal(reads.properties.overrideQueryTimeRange, 'P2D');
  assert.deepEqual(reads.properties.criteria.allOf[0].dimensions, [{ name: 'Person', operator: 'Include', values: ['*'] }]);
  assert.equal(reads.properties.criteria.allOf[0].query, readsQuery(VAULT, { mode: 'baseline', factor: 3, minimum: 20 }));
  assert.ok(reads.properties.actions.actionGroups[0].endsWith('/actionGroups/keevault-alerts'));
  assert.equal(by.denied.body.properties.criteria.allOf[0].query, deniedQuery(VAULT));
  const act = by.activity;
  assert.equal(act.path, `/subscriptions/${SUB}/resourceGroups/rg-keevault-logs/providers/Microsoft.Insights/activityLogAlerts/keevault-diag-kv-team`);
  assert.deepEqual(act.body.properties.scopes, [VAULT]);
  assert.deepEqual(act.body.properties.condition.allOf[1].anyOf.map((x) => x.equals),
    ['Microsoft.Insights/diagnosticSettings/write', 'Microsoft.Insights/diagnosticSettings/delete']);
});

test('dry run, existing workspace: retention only ever raised, an existing setting to it is reused with its other targets', async () => {
  const storage = `/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.Storage/storageAccounts/stworm`;
  const res = {
    [`GET ${WS}`]: { id: WS, name: 'law-keevault', location: 'westeurope', properties: { retentionInDays: 30 } },
    [`GET ${VAULT}/providers/Microsoft.Insights/diagnosticSettings`]: { value: [{ name: 'it-audit', properties: { workspaceId: WS, storageAccountId: storage,
      logs: [{ categoryGroup: 'audit', enabled: true }], metrics: [] } }] },
    [`GET /subscriptions/${SUB}/resourceGroups/rg-keevault-logs/providers/Microsoft.Insights/actionGroups/keevault-alerts`]: {
      properties: { groupShortName: 'Keevault', enabled: true, emailReceivers: [{ name: 'mail-1', emailAddress: 'IT@contoso.com' }] } },
  };
  let plan = await planLogging(fakeAzure(res), VAULT, opts({ workspace: { mode: 'existing', id: WS } }));
  const by = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
  assert.equal(by.workspace.kind, 'update');
  assert.deepEqual(by.workspace.request.body, { properties: { retentionInDays: 90 } });
  assert.equal(by.diagnostics.request.path.split('/').pop(), 'it-audit');
  assert.equal(by.diagnostics.request.body.properties.storageAccountId, storage);
  assert.equal(by.actiongroup.kind, 'keep');
  assert.equal(by.reads.request.body.location, 'westeurope');
  assert.ok(!plan.steps.some((s) => s.id === 'group'));
  res[`GET ${WS}`].properties.retentionInDays = 365;
  plan = await planLogging(fakeAzure(res), VAULT, opts({ workspace: { mode: 'existing', id: WS }, retentionDays: 90 }));
  assert.equal(plan.steps.find((s) => s.id === 'workspace').kind, 'keep');
});

test('missing rights: the dry run names right and role, and nothing is written', async () => {
  const readOnly = () => [{ actions: ['*/read'] }];
  const plan = await planLogging(fakeAzure({}, readOnly), VAULT, opts());
  assert.equal(plan.blocked, true);
  const diag = plan.steps.find((s) => s.id === 'diagnostics');
  assert.match(diag.missing, /Microsoft\.Insights\/diagnosticSettings\/write/);
  assert.match(diag.missing, /Monitoring Contributor/);
  const az = fakeAzure();
  await assert.rejects(applyLogging(az, plan), /Es fehlen Rechte/);
  assert.equal(az.calls.length, 0);
});

test('setup writes exactly the planned steps; a refused step ends with a clear sentence, not the raw Azure text', async () => {
  const plan = await planLogging(fakeAzure({ [`GET ${WS}`]: { id: WS, name: 'law-keevault', location: 'westeurope', properties: { retentionInDays: 90 } } }),
    VAULT, opts({ workspace: { mode: 'existing', id: WS } }));
  const az = fakeAzure();
  const r = await applyLogging(az, plan);
  const written = az.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(written, plan.steps.filter((s) => s.kind !== 'keep').map((s) => `${s.request.method} ${s.request.path}`));
  assert.deepEqual(r.done, ['diagnostics', 'actiongroup', 'reads', 'activity']);

  const raw = `The client 'max@example.test' with object id 99999999-8888-7777-6666-000000000000 does not have authorization over scope '${VAULT}'`;
  const refusing = fakeAzure({ [`PUT ${plan.steps.find((s) => s.id === 'reads').request.path}`]: new AzureError(403, 'AuthorizationFailed', raw) });
  const err = await applyLogging(refusing, plan).catch((e) => e);
  assert.match(err.message, /Warnregel/);
  assert.match(err.message, /Monitoring Contributor/);
  assert.match(err.message, /Bis dahin erledigt: 2/);
  for (const leak of ['/subscriptions/', 'example.test', '99999999']) assert.ok(!err.message.includes(leak), `leaks ${leak}`);
});

test('status: active since, changed, missing, and not readable', async () => {
  const path = `GET ${VAULT}/providers/Microsoft.Insights/diagnosticSettings`;
  const sd = { createdAt: '2026-11-01T10:00:00Z', lastModifiedAt: '2026-11-05T09:00:00Z', lastModifiedBy: 'kim@contoso.com' };
  let s = await loggingStatus(fakeAzure({ [path]: { value: [{ name: DIAG_NAME, systemData: sd, properties: { workspaceId: WS, logs: [{ category: 'AuditEvent', enabled: true }] } }] } }), VAULT);
  assert.deepEqual(s, { state: 'active', since: sd.createdAt, changedAt: sd.lastModifiedAt, changedBy: 'kim@contoso.com', setting: DIAG_NAME, workspaceId: WS, workspaceName: 'law-keevault' }); // workspaceId: #500 queries it
  s = await loggingStatus(fakeAzure({ [path]: { value: [{ name: 'other', properties: { workspaceId: WS, logs: [{ categoryGroup: 'allLogs', enabled: true }] } }] } }), VAULT);
  assert.equal(s.state, 'active');
  s = await loggingStatus(fakeAzure({ [path]: { value: [{ name: DIAG_NAME, systemData: sd, properties: { workspaceId: WS, logs: [{ category: 'AuditEvent', enabled: false }] } }] } }), VAULT);
  assert.equal(s.state, 'changed');
  assert.equal(s.changedBy, 'kim@contoso.com');
  s = await loggingStatus(fakeAzure({ [path]: { value: [{ name: 'storage-only', properties: { storageAccountId: 'x', logs: [{ category: 'AuditEvent', enabled: true }] } }] } }), VAULT);
  assert.equal(s.state, 'missing');
  s = await loggingStatus(fakeAzure({ [path]: new AzureError(403, 'AuthorizationFailed', 'raw') }), VAULT);
  assert.equal(s.state, 'unknown');
  assert.match(s.reason, /Monitoring Reader/);
});

test('demo backend: missing → dry run → setup → active, through the real AzureClient', async () => {
  const demo = createDemoBackend();
  const azure = new AzureClient({ getArmToken: async () => 't', getGraphToken: async () => 't', fetch: demo.fetch });
  azure.retryDelay = 0;
  const vault = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-kvpwsafe-demo/providers/Microsoft.KeyVault/vaults/kv-pws-demo-team';
  assert.equal((await loggingStatus(azure, vault)).state, 'missing');
  const o = normalizeLoggingOptions({ workspace: { mode: 'new', resourceGroup: 'rg-keevault-logs', name: 'law-keevault', location: 'germanywestcentral' }, email: 'it@contoso.com' }, vault);
  const plan = await planLogging(azure, vault, o);
  assert.equal(plan.blocked, false);
  assert.equal((await loggingStatus(azure, vault)).state, 'missing', 'the dry run changed something');
  await applyLogging(azure, plan);
  const s = await loggingStatus(azure, vault);
  assert.equal(s.state, 'active');
  assert.equal(s.workspaceName, 'law-keevault');
  assert.ok(s.since);
});

test('infra script: the same fixed KQL as the app, and the same diagnostic setting name', async () => {
  const { readFile } = await import('node:fs/promises');
  const ps = (await readFile(new URL('../infra/Enable-KvPwSafeLogging.ps1', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const block = (name) => ps.match(new RegExp(`\\$${name} = @'\\n([\\s\\S]*?)\\n'@`))[1];
  const v = VAULT.toLowerCase();
  assert.equal(block('KqlReadsFixed').replace('{{VAULT}}', v).replace('{{THRESHOLD}}', '40'), readsQuery(VAULT, { mode: 'fixed', threshold: 40 }));
  assert.equal(block('KqlReadsBaseline').replace('{{VAULT}}', v).replace('{{MINIMUM}}', '25').replace('{{FACTOR}}', '4'), readsQuery(VAULT, { mode: 'baseline', factor: 4, minimum: 25 }));
  assert.equal(block('KqlDenied').replace('{{VAULT}}', v), deniedQuery(VAULT));
  assert.ok(ps.includes(`'${DIAG_NAME}'`));
});

test('review: our setting sends to another workspace – the dry run says so plainly, or adds a second setting', async () => {
  const OTHER = `/subscriptions/${SUB}/resourceGroups/rg-old/providers/Microsoft.OperationalInsights/workspaces/law-old`;
  const res = { [`GET ${VAULT}/providers/Microsoft.Insights/diagnosticSettings`]: { value: [
    { name: DIAG_NAME, properties: { workspaceId: OTHER, logs: [{ category: 'AuditEvent', enabled: true }], metrics: [] } },
    { name: `${DIAG_NAME}-2`, properties: { storageAccountId: 'x' } }] } };
  let plan = await planLogging(fakeAzure(res), VAULT, opts());
  let diag = plan.steps.find((s) => s.id === 'diagnostics');
  assert.equal(diag.kind, 'update');
  assert.match(diag.text, /bisher Workspace „law-old“ → neu „law-keevault“ \(„law-old“ erhält keine Daten mehr\)/);
  assert.deepEqual(diag.redirect, { from: 'law-old', to: 'law-keevault', mode: 'replace' });
  assert.equal(diag.request.path.split('/').pop(), DIAG_NAME);

  plan = await planLogging(fakeAzure(res), VAULT, opts({ diagnostics: 'add' }));
  diag = plan.steps.find((s) => s.id === 'diagnostics');
  assert.equal(diag.kind, 'create');
  assert.equal(diag.request.path.split('/').pop(), `${DIAG_NAME}-3`, 'a free name, the old setting untouched');
  assert.equal(diag.redirect.mode, 'add');
  assert.equal(diag.request.body.properties.workspaceId, WS);
  assert.match(diag.text, /sendet weiter an „law-old“/);

  // Without another workspace nothing changes: no redirect, and "add" is ignored.
  plan = await planLogging(fakeAzure({}), VAULT, opts({ diagnostics: 'add' }));
  diag = plan.steps.find((s) => s.id === 'diagnostics');
  assert.equal(diag.redirect, undefined);
  assert.equal(diag.request.path.split('/').pop(), DIAG_NAME);
  assert.equal(opts({ diagnostics: 'evil' }).diagnostics, 'replace');
});

test('review: infra script keeps action group receivers, -WhatIf leaves the context alone, parameters are checked', async () => {
  const { readFile } = await import('node:fs/promises');
  const ps = (await readFile(new URL('../infra/Enable-KvPwSafeLogging.ps1', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(ps, /Set-AzContext -Subscription \$SubscriptionId -WhatIf:\$false/);
  assert.match(ps, /foreach \(\$p in \$ag\.properties\.PSObject\.Properties\) \{ \$agProps\[\$p\.Name\] = \$p\.Value \}/);
  assert.match(ps, /properties = \$agProps \}/);
  assert.doesNotMatch(ps, /emailReceivers = \$mail \} \}/);
  const pattern = (name) => {
    const m = ps.match(new RegExp(`ValidatePattern\\('([^']+)'\\)\\]\\[string\\] \\$${name}\\b`));
    assert.ok(m, `no ValidatePattern for ${name}`);
    return new RegExp(m[1], 'i');
  };
  const rg = pattern('VaultResourceGroup');
  assert.ok(rg.test('rg-kvpwsafe') && rg.test('a') && !rg.test('rg/x') && !rg.test('rg.') && !rg.test('rg?api-version=1'));
  const loc = pattern('Location');
  assert.ok(loc.test('westeurope') && !loc.test('west europe') && !loc.test('x/../y'));
  const scope = pattern('PolicyScope');
  assert.ok(scope.test(`/subscriptions/${SUB}`) && scope.test(`/subscriptions/${SUB}/resourceGroups/rg-a`) && scope.test('/providers/Microsoft.Management/managementGroups/mg-it'));
  assert.ok(!scope.test(`/subscriptions/${SUB}/providers/Microsoft.Authorization/x`) && !scope.test('https://evil'));
});
