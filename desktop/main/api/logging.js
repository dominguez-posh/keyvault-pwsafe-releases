// API: logging of a Key Vault into Log Analytics (#486) – status, dry run, setup. Only in admin mode and only for
// whoever administers the vault (Verwalten or Key Vault Administrator). The setup writes only the plan of the last
// dry run with the same options; the window can't hand in requests of its own.

import { t } from '../../../extension/core/i18n.js';
import { LOGGING_DEFAULTS, RETENTION_CHOICES, applyLogging, listWorkspaces, loggingStatus, normalizeLoggingOptions, planLogging } from '../../../extension/core/loganalytics.js';
import { config, vault } from '../state.js';
import { requireOpen } from '../guards.js';
import { containerResource } from '../session.js';

const PLAN_TTL = 10 * 60_000;
let lastPlan = null; // { containerId, key, plan, at }

async function requireLoggingAdmin(containerId) {
  requireOpen();
  if (config.get().adminTools !== true) throw new Error(t('Die Protokollierung richtest du im Admin-Modus ein.'));
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Protokollierung gibt es nur für Tresore in Azure Key Vault.'));
  if (!c.access?.admin && !c.access?.manage) throw new Error(t('Die Protokollierung richten nur Verwalter des Tresors ein.'));
  return { azure: vault.azureFor(c), vaultId: await containerResource(containerId) };
}

/** For the plan text and the stored plan: the options as checked, in a fixed order. */
const keyOf = (o) => JSON.stringify([o.workspace, o.retentionDays, o.email, o.reads, o.denied, o.diagnostics]);

export const loggingApi = {
  /** Status for the vault settings plus the suggestions of the setup dialog. */
  async loggingState(containerId) {
    const { azure, vaultId } = await requireLoggingAdmin(containerId);
    const [status, vaultRes, workspaces] = await Promise.all([
      loggingStatus(azure, vaultId),
      azure.arm('GET', vaultId, '2023-07-01').catch(() => null),
      listWorkspaces(azure).catch(() => []),
    ]);
    return {
      status,
      workspaces,
      defaults: { ...LOGGING_DEFAULTS, subscriptionId: vaultId.split('/')[2], location: vaultRes?.location || 'germanywestcentral' },
      retentionChoices: RETENTION_CHOICES,
    };
  },
  /** Dry run: what would be created or changed, and which rights are missing. Nothing is written. */
  async loggingPlan(containerId, options) {
    const { azure, vaultId } = await requireLoggingAdmin(containerId);
    const o = normalizeLoggingOptions(options, vaultId);
    const plan = await planLogging(azure, vaultId, o);
    lastPlan = { containerId, key: keyOf(o), plan, at: Date.now() };
    return {
      blocked: plan.blocked,
      workspaceName: plan.workspaceName,
      steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, text: s.text, missing: s.missing || '', query: s.query || '', ...(s.redirect ? { redirect: s.redirect } : {}) })),
    };
  },
  /** Writes the plan of the last dry run – only with the same options and not older than ten minutes. */
  async loggingApply(containerId, options) {
    const { azure, vaultId } = await requireLoggingAdmin(containerId);
    const o = normalizeLoggingOptions(options, vaultId);
    const p = lastPlan;
    if (!p || p.containerId !== containerId || p.key !== keyOf(o) || p.plan.vaultId !== vaultId || Date.now() - p.at > PLAN_TTL) {
      throw new Error(t('Bitte zuerst den Probelauf mit diesen Angaben starten.'));
    }
    lastPlan = null;
    const r = await applyLogging(azure, p.plan);
    return { done: r.done.length, status: await loggingStatus(azure, vaultId).catch(() => ({ state: 'unknown' })) };
  },
};
