// Compliance with a Log Analytics workspace (#500, on top of #486): fixed KQL queries over the query API (through ARM
// with the existing sign-in, no Graph), read only. They add the real read history to "Person ausgeschieden" and give
// the standard reports: reads per person and entry, unusually many reads, denied accesses, accesses by other apps,
// changes and deletions. Only numbers, ISO dates and validated IDs go into a query, never text from the window.

import { t } from './i18n.js';
import { auditOf, PERSON } from './loganalytics.js';
import { labelOf, samePerson } from './compliance.js';

const DAY = 86_400_000;
export const REPORT_KINDS = ['reads', 'many', 'denied', 'apps', 'changes'];
export const MANY_DEFAULT = 20;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[-\w.()]{1,90}\/providers\/Microsoft\.OperationalInsights\/workspaces\/[a-zA-Z0-9-]{4,63}$/i;

const ms = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(n) && n > 0 ? n : 0;
};


/** Checks a time range { from, to } (ms) → ISO strings; at most two years, `to` not before `from`. */
export function timeRange(from, to, now = Date.now()) {
  const a = ms(from);
  const b = Math.min(ms(to) || now, now);
  if (!a || a >= b || b - a > 731 * DAY) throw new Error(t('Bitte einen Zeitraum von höchstens zwei Jahren wählen.'));
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

const ENTRY = '| extend Entry = tostring(split(id_s, "/")[4])\n';

/**
 * The KQL of a report. kind: coverage | reads | many | denied | apps | changes. range from timeRange(); clientIds:
 * the app IDs of Keevault (GUIDs); threshold: entries per person and hour for "many". The first line names the kind.
 */
export function complianceQuery(kind, vaultId, { range = null, clientIds = [], threshold = MANY_DEFAULT } = {}) {
  const head = `// keevault:${kind}\n${auditOf(vaultId)}`;
  if (kind === 'coverage') return `${head}| summarize First = min(TimeGenerated), Last = max(TimeGenerated), Events = count()`;
  if (!range || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(range.to)) throw new Error('invalid time range');
  const base = `${head}| where TimeGenerated between (datetime(${range.from}) .. datetime(${range.to}))\n`;
  const reads = `${base}| where OperationName == "SecretGet" and toint(httpStatusCode_d) < 300\n| ${PERSON}\n${ENTRY}`;
  if (kind === 'reads') {
    return `${reads}| extend Oid = tostring(column_ifexists("identity_claim_oid_g", ""))\n`
      + '| summarize Reads = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Person, Oid, Entry\n| order by Last desc\n| take 5000';
  }
  if (kind === 'many') {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error(t('Schwelle: 1 bis 100000 Einträge pro Stunde'));
    return `${reads}| summarize Entries = dcount(Entry), Reads = count() by Person, Hour = bin(TimeGenerated, 1h)\n| where Entries > ${n}\n| order by Entries desc\n| take 1000`;
  }
  if (kind === 'denied') {
    return `${base}| where toint(httpStatusCode_d) == 403\n| ${PERSON}\n${ENTRY}| project TimeGenerated, Person, OperationName, Entry, CallerIPAddress\n| order by TimeGenerated desc\n| take 1000`;
  }
  if (kind === 'apps') {
    const ids = clientIds.filter((id) => GUID.test(String(id))).map((id) => `"${String(id).toLowerCase()}"`);
    return `${base}| extend App = tolower(tostring(column_ifexists("identity_claim_appid_g", "")))\n`
      + `| where isnotempty(App)${ids.length ? ` and App !in (${ids.join(', ')})` : ''}\n| ${PERSON}\n`
      + '| summarize Requests = count(), First = min(TimeGenerated), Last = max(TimeGenerated), Operations = make_set(OperationName, 10) by App, Person\n| order by Last desc\n| take 1000';
  }
  if (kind === 'changes') {
    return `${base}| where OperationName in ("SecretSet", "SecretUpdate", "SecretDelete", "SecretPurge", "SecretRecover", "SecretRestore") and toint(httpStatusCode_d) < 300\n`
      + `| ${PERSON}\n${ENTRY}| project TimeGenerated, Person, OperationName, Entry\n| order by TimeGenerated desc\n| take 1000`;
  }
  throw new Error(`unknown report ${kind}`);
}

/** The request for the query API over ARM (the existing sign-in, no Graph). */
export function queryRequest(workspaceId, query, range = null) {
  if (!WORKSPACE_ID.test(String(workspaceId))) throw new Error('invalid workspace id');
  return { path: `${workspaceId}/api/query`, apiVersion: '2017-01-01-preview',
    body: { query, ...(range ? { timespan: `${range.from}/${range.to}` } : { timespan: 'P2Y' }) } };
}

/** Rows of the first table of a query answer as objects. */
export function queryRows(result) {
  const table = result?.tables?.[0];
  if (!table) return [];
  const names = (table.columns || []).map((c) => c.name);
  return (table.rows || []).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

/** Read history of one person from the "reads" rows → Map entry id → { count, first, last }. */
export function readsOf(rows, member) {
  const out = new Map();
  for (const r of rows) {
    if (!samePerson(member, r.Person) && !samePerson(member, r.Oid)) continue;
    const had = out.get(r.Entry);
    out.set(r.Entry, had
      ? { count: had.count + Number(r.Reads || 0), first: Math.min(had.first, ms(r.First)), last: Math.max(had.last, ms(r.Last)) }
      : { count: Number(r.Reads || 0), first: ms(r.First), last: ms(r.Last) });
  }
  return out;
}

/**
 * Report rows with the entry's title instead of the technical name `pws-…`: `labels` maps the IDs the admin may see to
 * a row from entryRow(); others' private entries and protected vaults stay masked, unknown names (deleted) too.
 */
export function withEntryLabels(rows, labels) {
  return rows.map((r) => {
    if (!('Entry' in r)) return { ...r };
    const known = labels.get(r.Entry);
    const { Entry, ...rest } = r;
    if (!Entry) return { ...rest, entry: '' };
    return { ...rest, entry: known ? labelOf(known) : labelOf({ masked: 'unknown' }), key: known && !known.masked ? known.key : '' };
  });
}
