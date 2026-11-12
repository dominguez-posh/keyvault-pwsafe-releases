// Log Analytics for a Key Vault container (#486): the audit log of the vault goes into a Log Analytics workspace,
// with alert rules on top. Only ARM REST over the existing sign-in (AzureClient.arm), no Graph.
//
// planLogging() is the dry run: it reads what exists, checks the rights and returns the steps that would be written,
// each with its fixed request (method, path, api-version, body). applyLogging() writes exactly these steps; the caller
// keeps the plan between the two calls, so nothing the window sends can change a request. loggingStatus() tells
// whether the vault's audit log reaches a workspace. infra/Enable-KvPwSafeLogging.ps1 builds the same requests.

import { t } from './i18n.js';
import { allowed } from './azure.js';
import { isAzureForbidden, uiMessage } from './azure-errors.js';
import { sleep } from './util.js';

export const API = {
  groups: '2021-04-01',
  providers: '2021-04-01',
  permissions: '2022-04-01',
  workspaces: '2022-10-01',
  diagnostics: '2021-05-01-preview',
  actionGroups: '2023-01-01',
  queryRules: '2023-12-01',
  activityAlerts: '2020-10-01',
};

// Technical name of the diagnostic setting: the same as infra/New-KvPwSafeContainer.ps1 has always used, so a vault set
// up by the script is recognised (technical identifiers keep the old name, see CLAUDE.md).
export const DIAG_NAME = 'kvpwsafe-audit';
export const ACTION_GROUP = 'keevault-alerts';
export const LOGGING_DEFAULTS = {
  resourceGroup: 'rg-keevault-logs',
  workspaceName: 'law-keevault',
  retentionDays: 90,
  reads: { mode: 'baseline', threshold: 50, factor: 3, minimum: 20 },
  denied: false,
};
export const RETENTION_CHOICES = [30, 90, 180, 365, 730];

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VAULT_ID = new RegExp(`^/subscriptions/${GUID}/resourceGroups/[-\\w.()]{1,90}/providers/Microsoft\\.KeyVault/vaults/[a-zA-Z0-9-]{3,24}$`, 'i');
const WORKSPACE_ID = new RegExp(`^/subscriptions/${GUID}/resourceGroups/[-\\w.()]{1,90}/providers/Microsoft\\.OperationalInsights/workspaces/[a-zA-Z0-9-]{4,63}$`, 'i');
const SUBSCRIPTION = new RegExp(`^${GUID}$`, 'i');

// Built-in role that brings the missing right, named in the hint (#479: a clear notice, never the raw Azure error).
const ROLE_FOR = {
  'Microsoft.Resources/subscriptions/resourceGroups/write': 'Contributor',
  'Microsoft.OperationalInsights/register/action': 'Contributor',
  'Microsoft.Insights/register/action': 'Contributor',
  'Microsoft.OperationalInsights/workspaces/write': 'Log Analytics Contributor',
  'Microsoft.Insights/diagnosticSettings/write': 'Monitoring Contributor',
  'Microsoft.Insights/actionGroups/write': 'Monitoring Contributor',
  'Microsoft.Insights/scheduledQueryRules/write': 'Monitoring Contributor',
  'Microsoft.Insights/activityLogAlerts/write': 'Monitoring Contributor',
};

const subscriptionOf = (id) => String(id).split('/')[2];
const groupOf = (id) => String(id).split('/')[4];
const lastPart = (id) => String(id).split('/').pop();
const intIn = (v, lo, hi, fallback) => {
  const n = Number(v ?? fallback);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** Checks and completes the options from the window. Throws an Error with a text for the user. */
export function normalizeLoggingOptions(raw, vaultId) {
  if (!VAULT_ID.test(String(vaultId))) throw new Error(t('Der Key Vault ist in Azure Resource Manager nicht sichtbar (Rolle „Leser“ auf dem Key Vault fehlt).'));
  const o = raw || {};
  const w = o.workspace || {};
  let workspace;
  if (w.mode === 'existing') {
    if (!WORKSPACE_ID.test(String(w.id || ''))) throw new Error(t('Bitte einen vorhandenen Workspace wählen.'));
    workspace = { mode: 'existing', id: String(w.id) };
  } else {
    const subscriptionId = String(w.subscriptionId || subscriptionOf(vaultId));
    const resourceGroup = String(w.resourceGroup || '').trim();
    const name = String(w.name || '').trim();
    const location = String(w.location || '').trim().toLowerCase();
    if (!SUBSCRIPTION.test(subscriptionId)) throw new Error(t('Bitte ein Abonnement wählen.'));
    if (!/^[-\w.()]{1,90}$/.test(resourceGroup) || resourceGroup.endsWith('.')) throw new Error(t('Ressourcengruppe: 1–90 Zeichen, Buchstaben, Ziffern, - _ . ( )'));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$/.test(name)) throw new Error(t('Workspace-Name: 4–63 Zeichen, Buchstaben, Ziffern und Bindestriche'));
    if (!/^[a-z0-9]{2,40}$/.test(location)) throw new Error(t('Bitte eine Region wählen.'));
    workspace = { mode: 'new', subscriptionId, resourceGroup, name, location };
  }
  const retentionDays = intIn(o.retentionDays, 30, 730, LOGGING_DEFAULTS.retentionDays);
  if (retentionDays === null) throw new Error(t('Aufbewahrung: 30 bis 730 Tage'));
  const email = String(o.email || '').trim();
  if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(email) || email.length > 254) throw new Error(t('Bitte eine gültige E-Mail-Adresse für die Warnungen angeben.'));
  const r = o.reads || {};
  const mode = r.mode === 'fixed' ? 'fixed' : 'baseline';
  const reads = { mode };
  if (mode === 'fixed') {
    reads.threshold = intIn(r.threshold, 1, 100000, LOGGING_DEFAULTS.reads.threshold);
    if (reads.threshold === null) throw new Error(t('Schwelle: 1 bis 100000 Einträge pro Stunde'));
  } else {
    reads.factor = intIn(r.factor, 2, 50, LOGGING_DEFAULTS.reads.factor);
    reads.minimum = intIn(r.minimum, 1, 100000, LOGGING_DEFAULTS.reads.minimum);
    if (reads.factor === null || reads.minimum === null) throw new Error(t('Vielfaches: 2 bis 50, Mindestzahl: 1 bis 100000'));
  }
  return { workspace, retentionDays, email, reads, denied: o.denied === true, diagnostics: o.diagnostics === 'add' ? 'add' : 'replace' };
}

// ---------------------------------------------------------------- KQL (fixed queries, only numbers are filled in)

/** The person behind a request: UPN of a user, else object ID, else the app (service principal), else the IP. */
export const PERSON = 'extend Person = coalesce(tostring(column_ifexists("identity_claim_upn_s", "")), '
  + 'tostring(column_ifexists("identity_claim_http_schemas_xmlsoap_org_ws_2005_05_identity_claims_upn_s", "")), '
  + 'tostring(column_ifexists("identity_claim_oid_g", "")), tostring(column_ifexists("identity_claim_appid_g", "")), CallerIPAddress)';

export function auditOf(vaultId) {
  if (!VAULT_ID.test(String(vaultId))) throw new Error('invalid vault id');
  return 'AzureDiagnostics\n'
    + '| where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"\n'
    + `| where _ResourceId =~ "${String(vaultId).toLowerCase()}"\n`;
}

/**
 * Unusually many reads per person in the last hour: number of different entries (secret names) read.
 * fixed: more than `threshold`; baseline: more than `factor` × the person's usual hourly count of the two days before
 * (alert queries see at most two days), and never below `minimum`.
 */
export function readsQuery(vaultId, reads) {
  const base = `${auditOf(vaultId)}| where OperationName == "SecretGet" and toint(httpStatusCode_d) < 300\n| ${PERSON}\n`
    + '| extend Entry = tostring(split(id_s, "/")[4])\n';
  if (reads.mode === 'fixed') {
    return `${base}| where TimeGenerated > ago(1h)\n| summarize Reads = dcount(Entry) by Person\n| where Reads > ${Number(reads.threshold)}`;
  }
  return `let reads = ${base.replace(/\n$/, '')};\n`
    + 'let recent = reads | where TimeGenerated > ago(1h) | summarize Reads = dcount(Entry) by Person;\n'
    + 'let usual = reads | where TimeGenerated <= ago(1h) and TimeGenerated > ago(2d)\n'
    + '    | summarize Entries = dcount(Entry) by Person, bin(TimeGenerated, 1h) | summarize Usual = avg(Entries) by Person;\n'
    + 'recent\n| join kind=leftouter usual on Person\n| extend Usual = coalesce(Usual, 0.0)\n'
    + `| where Reads > max_of(${Number(reads.minimum)}, Usual * ${Number(reads.factor)})\n| project Person, Reads, Usual`;
}

/** Denied accesses (403; 401 is the normal challenge of every Key Vault client) and deletions of entries. */
export function deniedQuery(vaultId) {
  return `${auditOf(vaultId)}| where TimeGenerated > ago(15m)\n`
    + '| where toint(httpStatusCode_d) == 403 or OperationName in ("SecretDelete", "SecretPurge", "VaultDelete")\n'
    + `| ${PERSON}\n| project TimeGenerated, Person, OperationName, ResultSignature, CallerIPAddress`;
}

// ---------------------------------------------------------------- dry run

async function read(azure, path, apiVersion) {
  try {
    return { value: await azure.arm('GET', path, apiVersion) };
  } catch (e) {
    if (e?.status === 404) return { value: null };
    if (isAzureForbidden(e)) return { value: null, forbidden: true };
    throw e;
  }
}

/** Rights at a scope, cached per plan; null when they can't be read (then the write itself decides). */
function rightsReader(azure) {
  const cache = new Map();
  return async (scope) => {
    if (!cache.has(scope)) cache.set(scope, azure.armList(`${scope}/providers/Microsoft.Authorization/permissions`, API.permissions).catch(() => null));
    return cache.get(scope);
  };
}

function missingText(action) {
  return t('Dir fehlt das Recht „{action}“ (z. B. Rolle „{role}“).', { action, role: ROLE_FOR[action] || 'Contributor' });
}

/**
 * The dry run. Returns { steps, blocked, workspaceId, vaultId } – each step { id, kind: create|update|keep|register,
 * text, request? }. Steps that would fail for lack of rights carry `missing` (a sentence for the user).
 */
export async function planLogging(azure, vaultId, options) {
  const o = options;
  const vaultSub = subscriptionOf(vaultId);
  const vaultName = lastPart(vaultId);
  const rights = rightsReader(azure);
  const steps = [];
  const need = async (step, scope, action) => {
    const perms = await rights(scope);
    if (perms && !allowed(perms, action, false)) step.missing = missingText(action);
    steps.push(step);
  };

  // Workspace: where it is (or will be) and its region.
  let ws;
  if (o.workspace.mode === 'existing') {
    const got = await read(azure, o.workspace.id, API.workspaces);
    if (got.forbidden) throw new Error(t('Den gewählten Workspace darfst du nicht lesen (Rolle „Log Analytics Reader“ fehlt).'));
    if (!got.value) throw new Error(t('Den gewählten Workspace gibt es nicht mehr.'));
    ws = { id: got.value.id || o.workspace.id, name: got.value.name || lastPart(o.workspace.id), location: got.value.location,
      retention: got.value.properties?.retentionInDays || 0, existing: true };
  } else {
    const id = `/subscriptions/${o.workspace.subscriptionId}/resourceGroups/${o.workspace.resourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${o.workspace.name}`;
    const got = await read(azure, id, API.workspaces);
    ws = got.value
      ? { id: got.value.id || id, name: o.workspace.name, location: got.value.location, retention: got.value.properties?.retentionInDays || 0, existing: true }
      : { id, name: o.workspace.name, location: o.workspace.location, retention: 0, existing: false };
  }
  const wsSub = subscriptionOf(ws.id);
  const wsGroup = groupOf(ws.id);
  const groupPath = `/subscriptions/${wsSub}/resourceGroups/${wsGroup}`;

  // Resource providers (a fresh subscription has Microsoft.OperationalInsights not registered).
  const providers = [[wsSub, 'Microsoft.OperationalInsights'], [wsSub, 'Microsoft.Insights']];
  if (vaultSub !== wsSub) providers.push([vaultSub, 'Microsoft.Insights']);
  for (const [sub, ns] of providers) {
    const got = await read(azure, `/subscriptions/${sub}/providers/${ns}`, API.providers);
    if (got.value && got.value.registrationState !== 'Registered') {
      await need({ id: `register-${ns}`, kind: 'register', text: t('Ressourcenanbieter „{ns}“ im Abonnement registrieren', { ns }),
        request: { method: 'POST', path: `/subscriptions/${sub}/providers/${ns}/register`, apiVersion: API.providers }, wait: 'provider' },
      `/subscriptions/${sub}`, `${ns}/register/action`);
    }
  }

  // Resource group and workspace.
  let groupExists = true;
  if (!ws.existing) {
    const got = await read(azure, groupPath, API.groups);
    groupExists = !!got.value || !!got.forbidden;
    if (!groupExists) {
      await need({ id: 'group', kind: 'create', text: t('Ressourcengruppe „{name}“ anlegen ({location})', { name: wsGroup, location: ws.location }),
        request: { method: 'PUT', path: groupPath, apiVersion: API.groups, body: { location: ws.location } } },
      `/subscriptions/${wsSub}`, 'Microsoft.Resources/subscriptions/resourceGroups/write');
    }
  }
  const rightsScope = groupExists ? groupPath : `/subscriptions/${wsSub}`;
  if (!ws.existing) {
    await need({ id: 'workspace', kind: 'create', text: t('Log-Analytics-Workspace „{name}“ anlegen, Aufbewahrung {days} Tage', { name: ws.name, days: o.retentionDays }),
      request: { method: 'PUT', path: ws.id, apiVersion: API.workspaces,
        body: { location: ws.location, properties: { sku: { name: 'PerGB2018' }, retentionInDays: o.retentionDays } } }, wait: 'workspace' },
    rightsScope, 'Microsoft.OperationalInsights/workspaces/write');
  } else if (ws.retention < o.retentionDays) {
    await need({ id: 'workspace', kind: 'update', text: t('Aufbewahrung im Workspace „{name}“ von {from} auf {days} Tage verlängern', { name: ws.name, from: ws.retention, days: o.retentionDays }),
      request: { method: 'PATCH', path: ws.id, apiVersion: API.workspaces, body: { properties: { retentionInDays: o.retentionDays } } } },
    rightsScope, 'Microsoft.OperationalInsights/workspaces/write');
  } else {
    steps.push({ id: 'workspace', kind: 'keep', text: t('Workspace „{name}“ bleibt, Aufbewahrung {days} Tage (wird nie verkürzt)', { name: ws.name, days: ws.retention }) });
  }

  // Diagnostic setting on the vault: AuditEvent + AllMetrics to the workspace. An existing setting to the same
  // workspace is reused (Azure refuses the same category twice to one destination); other destinations stay.
  const diagList = await read(azure, `${vaultId}/providers/Microsoft.Insights/diagnosticSettings`, API.diagnostics);
  const settings = diagList.value?.value || [];
  const sameWs = settings.find((s) => String(s.properties?.workspaceId || '').toLowerCase() === ws.id.toLowerCase());
  const named = settings.find((s) => String(s.name).toLowerCase() === DIAG_NAME);
  // Our setting already sends to another workspace: switching it means that workspace gets nothing any more. The dry
  // run says so plainly; instead of switching, the admin can choose an additional setting (o.diagnostics === 'add').
  const elsewhere = !sameWs && named?.properties?.workspaceId ? named.properties.workspaceId : '';
  let current = sameWs || named;
  let diagName = current?.name || DIAG_NAME;
  if (elsewhere && o.diagnostics === 'add') {
    const taken = new Set(settings.map((s) => String(s.name).toLowerCase()));
    let n = 2;
    while (taken.has(`${DIAG_NAME}-${n}`)) n++;
    current = null;
    diagName = `${DIAG_NAME}-${n}`;
  }
  const keep = {};
  for (const k of ['storageAccountId', 'eventHubAuthorizationRuleId', 'eventHubName', 'marketplacePartnerId']) if (current?.properties?.[k]) keep[k] = current.properties[k];
  const otherLogs = (current?.properties?.logs || []).filter((l) => l.category !== 'AuditEvent' && !l.categoryGroup);
  const otherMetrics = (current?.properties?.metrics || []).filter((m) => m.category !== 'AllMetrics');
  const diagText = elsewhere && current
    ? t('Diagnoseeinstellung „{name}“ am Key Vault umstellen: bisher Workspace „{from}“ → neu „{to}“ („{from}“ erhält keine Daten mehr)', { name: diagName, from: lastPart(elsewhere), to: ws.name })
    : elsewhere
      ? t('Zusätzliche Diagnoseeinstellung „{name}“ am Key Vault: AuditEvent und AllMetrics an „{to}“; „{old}“ sendet weiter an „{from}“', { name: diagName, to: ws.name, old: named.name, from: lastPart(elsewhere) })
      : t('Diagnoseeinstellung „{name}“ am Key Vault: AuditEvent und AllMetrics an den Workspace', { name: diagName });
  await need({ id: 'diagnostics', kind: current ? 'update' : 'create', text: diagText,
    ...(elsewhere ? { redirect: { from: lastPart(elsewhere), to: ws.name, mode: current ? 'replace' : 'add' } } : {}),
    request: { method: 'PUT', path: `${vaultId}/providers/Microsoft.Insights/diagnosticSettings/${diagName}`, apiVersion: API.diagnostics,
      body: { properties: { ...keep, workspaceId: ws.id, logs: [...otherLogs, { category: 'AuditEvent', enabled: true }], metrics: [...otherMetrics, { category: 'AllMetrics', enabled: true }] } } } },
  vaultId, 'Microsoft.Insights/diagnosticSettings/write');

  // Action group: e-mail to the given address (existing receivers stay).
  const agId = `${groupPath}/providers/Microsoft.Insights/actionGroups/${ACTION_GROUP}`;
  const ag = ws.existing || groupExists ? await read(azure, agId, API.actionGroups) : { value: null };
  const receivers = ag.value?.properties?.emailReceivers || [];
  const hasMail = receivers.some((r) => String(r.emailAddress).toLowerCase() === o.email.toLowerCase());
  if (hasMail && ag.value?.properties?.enabled !== false) {
    steps.push({ id: 'actiongroup', kind: 'keep', text: t('Aktionsgruppe „{name}“ schickt schon an {email}', { name: ACTION_GROUP, email: o.email }) });
  } else {
    const mail = hasMail ? receivers : [...receivers, { name: `mail-${receivers.length + 1}`, emailAddress: o.email, useCommonAlertSchema: true }];
    await need({ id: 'actiongroup', kind: ag.value ? 'update' : 'create', text: t('Aktionsgruppe „{name}“: E-Mail an {email}', { name: ACTION_GROUP, email: o.email }),
      request: { method: 'PUT', path: agId, apiVersion: API.actionGroups,
        body: { location: 'Global', properties: { ...(ag.value?.properties || {}), groupShortName: 'Keevault', enabled: true, emailReceivers: mail } } } },
    rightsScope, 'Microsoft.Insights/actionGroups/write');
  }

  // Alert rules (log search) in the workspace's resource group.
  const rule = async (id, name, text, description, query, extra) => {
    const path = `${groupPath}/providers/Microsoft.Insights/scheduledQueryRules/${name}`;
    const got = ws.existing || groupExists ? await read(azure, path, API.queryRules) : { value: null };
    await need({ id, kind: got.value ? 'update' : 'create', text, query,
      request: { method: 'PUT', path, apiVersion: API.queryRules, body: {
        location: ws.location, kind: 'LogAlert',
        properties: {
          displayName: name, description, severity: 2, enabled: true, scopes: [ws.id],
          evaluationFrequency: 'PT15M', windowSize: extra.windowSize, ...(extra.override ? { overrideQueryTimeRange: extra.override } : {}),
          criteria: { allOf: [{ query, timeAggregation: 'Count', operator: 'GreaterThan', threshold: 0,
            ...(extra.dimensions ? { dimensions: extra.dimensions } : {}),
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 } }] },
          autoMitigate: false, muteActionsDuration: 'PT1H', actions: { actionGroups: [agId] },
        } } } }, rightsScope, 'Microsoft.Insights/scheduledQueryRules/write');
  };
  const readsText = o.reads.mode === 'fixed'
    ? t('Warnregel: mehr als {n} verschiedene Einträge pro Person und Stunde', { n: o.reads.threshold })
    : t('Warnregel: mehr als das {factor}-Fache der üblichen Abrufe pro Person und Stunde (mindestens {n})', { factor: o.reads.factor, n: o.reads.minimum });
  await rule('reads', `keevault-reads-${vaultName}`, readsText, `Keevault: unusually many reads per person in ${vaultName}`,
    readsQuery(vaultId, o.reads), { windowSize: 'PT1H', override: o.reads.mode === 'fixed' ? null : 'P2D', dimensions: [{ name: 'Person', operator: 'Include', values: ['*'] }] });
  if (o.denied) {
    await rule('denied', `keevault-denied-${vaultName}`, t('Warnregel: abgelehnte Zugriffe und Löschungen'), `Keevault: denied accesses and deletions in ${vaultName}`,
      deniedQuery(vaultId), { windowSize: 'PT15M' });
  }

  // Activity log alert on changing or deleting a diagnostic setting of the vault. It has to live in the vault's
  // subscription: in the workspace's group when that is in the same subscription, else in the vault's group.
  const home = wsSub === vaultSub ? groupPath : `/subscriptions/${vaultSub}/resourceGroups/${groupOf(vaultId)}`;
  const alertPath = `${home}/providers/Microsoft.Insights/activityLogAlerts/keevault-diag-${vaultName}`;
  const alert = ws.existing || groupExists || home !== groupPath ? await read(azure, alertPath, API.activityAlerts) : { value: null };
  await need({ id: 'activity', kind: alert.value ? 'update' : 'create', text: t('Warnung im Aktivitätsprotokoll, wenn jemand die Diagnoseeinstellung ändert oder löscht'),
    request: { method: 'PUT', path: alertPath, apiVersion: API.activityAlerts, body: {
      location: 'Global',
      properties: {
        enabled: true, scopes: [vaultId], description: `Keevault: diagnostic setting of ${vaultName} changed or deleted`,
        condition: { allOf: [{ field: 'category', equals: 'Administrative' }, { anyOf: [
          { field: 'operationName', equals: 'Microsoft.Insights/diagnosticSettings/write' },
          { field: 'operationName', equals: 'Microsoft.Insights/diagnosticSettings/delete' }] }] },
        actions: { actionGroups: [{ actionGroupId: agId }] },
      } } } }, home === groupPath ? rightsScope : home, 'Microsoft.Insights/activityLogAlerts/write');

  return { vaultId, workspaceId: ws.id, workspaceName: ws.name, steps, blocked: steps.some((s) => s.missing) };
}

// ---------------------------------------------------------------- writing

async function waitFor(azure, step) {
  for (let i = 0; i < 30; i++) {
    if (step.wait === 'provider') {
      const p = await azure.arm('GET', step.request.path.replace(/\/register$/, ''), API.providers);
      if (p?.registrationState === 'Registered') return;
    } else {
      const w = await azure.arm('GET', step.request.path, API.workspaces);
      if (w?.properties?.provisioningState === 'Succeeded') return;
      if (w?.properties?.provisioningState === 'Failed') throw new Error(t('Azure meldet den Workspace als fehlgeschlagen.'));
    }
    await sleep(azure.retryDelay ?? 2000);
  }
}

/**
 * Writes the steps of a plan from planLogging (never steps from elsewhere). onStep(step, index) reports progress.
 * A refused step ends with a sentence naming the step and the right; what was written before it stays.
 */
export async function applyLogging(azure, plan, onStep = () => {}) {
  if (plan.blocked) throw new Error(t('Es fehlen Rechte – siehe Probelauf.'));
  const done = [];
  for (const [i, step] of plan.steps.entries()) {
    if (step.kind === 'keep' || !step.request) continue;
    onStep(step, i);
    try {
      const { method, path, apiVersion, body } = step.request;
      await azure.arm(method, path, apiVersion, body);
      if (step.wait) await waitFor(azure, step);
    } catch (e) {
      const reason = isAzureForbidden(e)
        ? t('Dafür fehlt dir das Recht in Azure (z. B. Rolle „{role}“).', { role: roleForStep(step) })
        : uiMessage(e);
      throw new Error(t('Schritt „{step}“ nicht ausgeführt: {reason} Bis dahin erledigt: {done}.', { step: step.text, reason, done: done.length }));
    }
    done.push(step.id);
  }
  return { done };
}

function roleForStep(step) {
  const map = { group: 'Contributor', workspace: 'Log Analytics Contributor' };
  return map[step.id] || (step.kind === 'register' ? 'Contributor' : 'Monitoring Contributor');
}

// ---------------------------------------------------------------- status

const auditOn = (s) => (s.properties?.logs || []).some((l) => l.enabled && (l.category === 'AuditEvent' || /^(audit|allLogs)$/i.test(l.categoryGroup || '')));

/**
 * Does the vault's audit log reach a Log Analytics workspace?
 * { state: active|changed|missing|unknown, since, changedAt, changedBy, workspaceName, setting }
 * changed: our setting is still there but no longer sends the audit log to a workspace.
 */
export async function loggingStatus(azure, vaultId) {
  let list;
  try {
    list = (await azure.arm('GET', `${vaultId}/providers/Microsoft.Insights/diagnosticSettings`, API.diagnostics))?.value || [];
  } catch (e) {
    if (isAzureForbidden(e)) return { state: 'unknown', reason: t('Die Diagnoseeinstellungen des Key Vaults darfst du nicht lesen (z. B. Rolle „Monitoring Reader“).') };
    throw e;
  }
  const facts = (s) => {
    const created = s.systemData?.createdAt || '';
    const modified = s.systemData?.lastModifiedAt || '';
    return { since: created, changedAt: modified && modified !== created ? modified : '', changedBy: modified && modified !== created ? s.systemData?.lastModifiedBy || '' : '',
      setting: s.name, workspaceId: s.properties?.workspaceId || '', workspaceName: s.properties?.workspaceId ? lastPart(s.properties.workspaceId) : '' };
  };
  const good = list.find((s) => s.properties?.workspaceId && auditOn(s));
  if (good) return { state: 'active', ...facts(good) };
  const ours = list.find((s) => String(s.name).toLowerCase() === DIAG_NAME);
  if (ours) return { state: 'changed', ...facts(ours) };
  return { state: 'missing' };
}

/** Log Analytics workspaces the signed-in person can see (Resource Graph), for "use an existing workspace". */
export async function listWorkspaces(azure) {
  const rows = await azure.resourceGraph("resources | where type =~ 'microsoft.operationalinsights/workspaces' "
    + '| project id, name, resourceGroup, subscriptionId, location, retention = toint(properties.retentionInDays) | order by name asc');
  return rows.filter((r) => WORKSPACE_ID.test(r.id)).map((r) => ({ id: r.id, name: r.name, resourceGroup: r.resourceGroup, location: r.location, retention: r.retention || 0 }));
}
