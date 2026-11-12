// API: compliance view of a Key Vault vault (#500) – only in admin mode and only for its Verwalter. The entries are read
// here and only their metadata goes to the window (core/compliance.js entryRow); other people's "Nur für mich" entries
// stay masked. With a Log Analytics workspace (#486): fixed KQL queries over ARM with the existing sign-in, read only.

import { t } from '../../../extension/core/i18n.js';
import { mapLimit } from '../../../extension/core/util.js';
import { isAzureForbidden, uiMessage } from '../../../extension/core/azure-errors.js';
import { visibleTo } from '../../../extension/core/private.js';
import { loggingStatus } from '../../../extension/core/loganalytics.js';
import { entryRow, removedPrincipals } from '../../../extension/core/compliance.js';
import { entryMetadata } from '../../../extension/core/compliance-entries.js';
import { MANY_DEFAULT, REPORT_KINDS, complianceQuery, queryRequest, queryRows, readsOf, timeRange, withEntryLabels } from '../../../extension/core/compliance-log.js';
import { entraSettings } from '../../auth.js';
import { config, vault } from '../state.js';
import { requireOpen } from '../guards.js';
import { containerResource, send } from '../session.js';
import { viewerId } from '../private.js';

const ACTIVITY_DAYS = 89; // the activity log keeps 90 days

async function requireComplianceAdmin(containerId) {
  requireOpen();
  if (config.get().adminTools !== true) throw new Error(t('Den Bereich „Compliance“ gibt es nur im Admin-Modus.'));
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Compliance gibt es nur für Tresore in Azure Key Vault.'));
  if (!c.access?.admin && !c.access?.manage) throw new Error(t('Den Bereich „Compliance“ sehen nur Verwalter des Tresors.'));
  return { c, azure: vault.azureFor(c), vaultId: await containerResource(containerId) };
}

/** Former members: deleted role assignments on the vault in the activity log (about 90 days, as far as Azure keeps them). */
async function formerMembers(azure, vaultId, current) {
  const sub = vaultId.split('/')[2];
  const group = vaultId.split('/')[4];
  const from = new Date(Date.now() - ACTIVITY_DAYS * 86_400_000).toISOString();
  const filter = encodeURIComponent(`eventTimestamp ge '${from}' and eventTimestamp le '${new Date().toISOString()}' and resourceGroupName eq '${group}'`);
  const events = await azure.armList(`/subscriptions/${sub}/providers/Microsoft.Insights/eventtypes/management/values?$filter=${filter}`, '2015-04-01');
  const known = new Set(current.map((m) => String(m.principalId).toLowerCase()));
  const former = removedPrincipals(events, vaultId).filter((p) => !known.has(p.principalId.toLowerCase()))
    .map((p) => ({ ...p, principalType: '', former: true }));
  if (former.length) await azure.resolvePrincipals(former);
  return former;
}

/** The workspace of the vault's audit log, or an Error with a sentence for the user. */
async function workspaceOf(azure, vaultId) {
  const status = await loggingStatus(azure, vaultId);
  if (status.state !== 'active' || !status.workspaceId) throw new Error(t('Für diesen Tresor ist keine Protokollierung in Log Analytics eingerichtet (Tresor-Einstellungen → Protokollierung).'));
  return status;
}

async function runQuery(azure, ws, query, range) {
  const req = queryRequest(ws.workspaceId, query, range);
  try {
    return queryRows(await azure.arm('POST', req.path, req.apiVersion, req.body));
  } catch (e) {
    if (isAzureForbidden(e)) throw new Error(t('Für die Auswertung fehlt dir die Rolle „Log Analytics Reader“ auf dem Workspace „{name}“.', { name: ws.workspaceName }));
    throw new Error(t('Die Abfrage in Log Analytics ist fehlgeschlagen: {reason}', { reason: uiMessage(e) }));
  }
}

/** How far back the workspace has events of this vault. */
async function coverage(azure, ws, vaultId) {
  const [row] = await runQuery(azure, ws, complianceQuery('coverage', vaultId), null);
  return { first: row?.First || '', last: row?.Last || '', events: Number(row?.Events || 0), since: ws.since || '', workspaceName: ws.workspaceName };
}

/** Titles the admin may see for the vault's technical names (masked otherwise, see core/compliance.js). */
async function labels(c) {
  const viewer = viewerId();
  const out = new Map();
  const summaries = (await vault.allSummaries()).filter((s) => s.containerId === c.id);
  for (const s of summaries) {
    const masked = c.protected && c.locked ? 'protected' : visibleTo(s, viewer, null) ? '' : 'private';
    out.set(s.id, entryRow(s, { masked }));
  }
  return out;
}

export const complianceApi = {
  /** Members (from ARM), former members (activity log) and whether a workspace can be evaluated. */
  async complianceState(containerId) {
    const { c, azure, vaultId } = await requireComplianceAdmin(containerId);
    let members = [];
    let membersError = '';
    try {
      members = (await azure.listMembers(vaultId)).map((m) => ({ principalId: m.principalId, displayName: m.displayName, detail: m.detail || '',
        principalType: m.principalType || '', level: m.level, inherited: m.assignments.every((a) => a.inherited) }));
    } catch (e) {
      membersError = isAzureForbidden(e) ? t('Die Rollenzuweisungen des Tresors darfst du nicht lesen (z. B. Rolle „Leser“).') : uiMessage(e);
    }
    const former = await formerMembers(azure, vaultId, members).catch(() => null);
    const logging = await loggingStatus(azure, vaultId).catch(() => ({ state: 'unknown' }));
    const { clientId, ownApp } = entraSettings(config.get());
    return {
      vault: { id: c.id, name: c.name, protected: !!c.protected, locked: !!c.locked },
      members, membersError,
      former: (former || []).map((m) => ({ principalId: m.principalId, displayName: m.displayName, detail: m.detail || '', removedAt: m.removedAt, removedBy: m.removedBy, former: true })),
      formerKnown: former !== null,
      logging: { state: logging.state, workspaceName: logging.workspaceName || '', since: logging.since || '' },
      ownApp, clientId: ownApp ? clientId : '',
    };
  },

  /**
   * Every entry of the vault as metadata: last real password change, never a secret value. By default from the listing
   * and the version lists only – reading every entry would count in the read alert of #486. `readAll` (asked for
   * explicitly in the window, with that warning) reads the entries for the entries the metadata can only estimate.
   */
  async complianceEntries(containerId, { readAll = false } = {}) {
    const { c } = await requireComplianceAdmin(containerId);
    const viewer = viewerId();
    const progress = (done, total) => send({ type: 'progress', id: 'complianceEntries', done, total });
    const meta = await entryMetadata(vault, c.id, progress);
    if (meta.locked) return { rows: [], skipped: meta.total, total: meta.total, estimated: 0, readAll: false };
    const rows = [];
    let skipped = 0;
    const toRead = [];
    for (const e of meta.entries) {
      if (!e) skipped++;
      else if (readAll && e.estimated) toRead.push(e);
      else rows.push(entryRow({ ...e.summary, hasPassword: e.hasPassword, passwordChanged: e.passwordChanged, created: e.created, estimated: e.estimated },
        { masked: visibleTo(e.summary, viewer, null) ? '' : 'private', oldestVersion: e.oldestVersion }));
    }
    let done = 0;
    await mapLimit(toRead, 6, async (e) => {
      try {
        const item = await vault.readItem(c.id, e.summary.id);
        rows.push(entryRow({ ...item, containerId: c.id, id: e.summary.id, key: e.summary.key }, { masked: visibleTo(item, viewer, null) ? '' : 'private', oldestVersion: e.oldestVersion }));
      } catch {
        skipped++; // locked (protected) vault or a transient error
      }
      progress(++done, toRead.length);
    });
    return { rows, skipped, total: meta.total, estimated: rows.filter((r) => r.estimated).length, readAll: !!readAll };
  },

  /** The read history of one person (Log Analytics): entry id → reads, first and last read. */
  async complianceReads(containerId, { person = {}, from, to } = {}) {
    const { azure, vaultId } = await requireComplianceAdmin(containerId);
    const ws = await workspaceOf(azure, vaultId);
    const range = timeRange(from, to);
    const rows = await runQuery(azure, ws, complianceQuery('reads', vaultId, { range }), range);
    const member = { principalId: String(person.principalId || ''), detail: String(person.detail || '') };
    return { reads: [...readsOf(rows, member)].map(([id, r]) => ({ id, ...r })), coverage: await coverage(azure, ws, vaultId) };
  },

  /** A standard report from Log Analytics, with titles instead of technical names where the admin may see them. */
  async complianceReport(containerId, { kind, from, to, threshold = MANY_DEFAULT } = {}) {
    const { c, azure, vaultId } = await requireComplianceAdmin(containerId);
    if (!REPORT_KINDS.includes(kind)) throw new Error('unknown report');
    const ws = await workspaceOf(azure, vaultId);
    const range = timeRange(from, to);
    const { clientId } = entraSettings(config.get());
    const rows = await runQuery(azure, ws, complianceQuery(kind, vaultId, { range, clientIds: [clientId], threshold }), range);
    return { kind, rows: withEntryLabels(rows, await labels(c)), coverage: await coverage(azure, ws, vaultId), range };
  },
};
