// Logging of a Key Vault into Log Analytics (#486): status in the vault settings and the setup dialog with a dry run.
// Only in admin mode for whoever administers the vault; the main process checks both again (api/logging.js).

import { h, toast, modal, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { field, notice } from './helpers.js';

const KIND_LABELS = { create: 'anlegen', update: 'ändern', keep: 'bleibt', register: 'registrieren' };

function statusNotice(status) {
  const when = (v) => (v ? formatDateTime(v) : '');
  if (status.state === 'active') {
    return h('div', { class: 'logging-status', 'data-state': 'active' },
      notice(status.since
        ? t('Protokollierung aktiv seit {date} (Workspace „{workspace}“).', { date: when(status.since), workspace: status.workspaceName })
        : t('Protokollierung aktiv (Workspace „{workspace}“).', { workspace: status.workspaceName }), 'ok'),
      status.changedAt ? h('p', { class: 'muted small' }, t('Diagnoseeinstellung zuletzt geändert {date} von {user}', { date: when(status.changedAt), user: status.changedBy || '?' })) : null);
  }
  if (status.state === 'changed') {
    return h('div', { class: 'logging-status', 'data-state': 'changed' }, notice(t('Protokollierung geändert: Die Diagnoseeinstellung „{name}“ schickt das Audit-Protokoll nicht mehr an einen Workspace (geändert {date} von {user}). Bitte neu einrichten.',
      { name: status.setting, date: when(status.changedAt || status.since), user: status.changedBy || '?' }), 'warn'));
  }
  if (status.state === 'missing') {
    return h('div', { class: 'logging-status', 'data-state': 'missing' }, notice(t('Protokollierung fehlt: Zugriffe auf diesen Tresor werden nicht in Log Analytics aufgezeichnet. Empfohlen ist ein Workspace pro Tenant bzw. Kunde.'), 'warn'));
  }
  return h('div', { class: 'logging-status', 'data-state': 'unknown' }, notice(status.reason || t('Der Stand der Protokollierung ist nicht bekannt.'), 'warn'));
}

/** Section "Protokollierung" of the vault settings: status, and the setup for whoever may. */
export function loggingSection(c) {
  const slot = h('div', {}, h('p', { class: 'muted small' }, t('Stand wird geladen …')));
  const section = h('section', { class: 'logging-section' }, h('h4', {}, t('Protokollierung')), slot);
  const load = () => call('loggingState', c.id).then((state) => {
    slot.replaceChildren(statusNotice(state.status), h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small logging-setup', onclick: () => loggingDialog(c, state, load) },
        state.status.state === 'active' ? t('Protokollierung anpassen …') : t('Protokollierung einrichten …'))));
  }, (e) => slot.replaceChildren(h('div', { class: 'logging-status', 'data-state': 'error' }, notice(e.message, 'warn'))));
  load();
  return section;
}

function stepList(plan) {
  return h('div', { class: 'logging-plan' },
    h('p', {}, plan.blocked ? t('Probelauf: Es fehlen Rechte, deshalb wird nichts angelegt.') : t('Probelauf: Diese Schritte würden ausgeführt. Noch ist nichts geändert.')),
    h('ol', { class: 'logging-steps' }, ...plan.steps.map((s) => h('li', { 'data-kind': s.kind, 'data-step': s.id },
      h('span', { class: `badge${s.kind === 'keep' ? '' : ' info'}` }, t(KIND_LABELS[s.kind] || s.kind)), ' ', s.text,
      s.missing ? notice(s.missing, 'warn') : null,
      s.query ? h('details', {}, h('summary', {}, t('Abfrage (KQL)')), h('pre', { class: 'logging-kql' }, s.query)) : null))));
}

export async function loggingDialog(c, state, onDone) {
  const d = state.defaults;
  const hasExisting = state.workspaces.length > 0;
  const mode = h('select', { class: 'logging-mode' },
    h('option', { value: 'new' }, t('Neuen Workspace anlegen')),
    hasExisting ? h('option', { value: 'existing' }, t('Vorhandenen Workspace wählen')) : null);
  const existing = h('select', { class: 'logging-existing' }, ...state.workspaces.map((w) => h('option', { value: w.id }, `${w.name} (${w.resourceGroup}, ${w.location})`)));
  const group = h('input', { class: 'logging-group', value: d.resourceGroup, spellcheck: 'false' });
  const name = h('input', { class: 'logging-name', value: d.workspaceName, spellcheck: 'false' });
  const region = h('select', { class: 'logging-region' }, h('option', { value: d.location }, d.location));
  call('locations', d.subscriptionId, c.tenantId).then((list) => {
    if (!list?.length) return;
    region.replaceChildren(...list.map((l) => h('option', { value: l.name, selected: l.name === d.location }, l.displayName)));
  }, () => {});
  const retention = h('select', { class: 'logging-retention' }, ...state.retentionChoices.map((n) => h('option', { value: String(n), selected: n === d.retentionDays }, t('{n} Tage', { n }))));
  const email = h('input', { type: 'email', class: 'logging-email', placeholder: 'it-security@contoso.com', spellcheck: 'false' });
  const readsMode = h('select', { class: 'logging-reads-mode' },
    h('option', { value: 'baseline' }, t('Vielfaches der üblichen Abrufe der Person')),
    h('option', { value: 'fixed' }, t('Feste Schwelle')));
  const factor = h('input', { type: 'number', min: '2', max: '50', value: String(d.reads.factor), class: 'logging-factor' });
  const minimum = h('input', { type: 'number', min: '1', max: '100000', value: String(d.reads.minimum), class: 'logging-minimum' });
  const threshold = h('input', { type: 'number', min: '1', max: '100000', value: String(d.reads.threshold), class: 'logging-threshold' });
  const denied = h('input', { type: 'checkbox', class: 'logging-denied' });
  // Shown once a dry run finds our diagnostic setting sending to another workspace: switch it, or add a second one.
  const diagMode = h('select', { class: 'logging-diag-mode' },
    h('option', { value: 'replace' }, t('Vorhandene Diagnoseeinstellung umstellen (bisheriger Workspace erhält keine Daten mehr)')),
    h('option', { value: 'add' }, t('Zusätzliche Diagnoseeinstellung anlegen (bisheriger Workspace erhält weiter Daten)')));
  const diagBox = h('div', { class: 'logging-diag', hidden: true }, field(t('Vorhandene Diagnoseeinstellung'), diagMode));
  const newBox = h('div', { class: 'grid2' }, field(t('Ressourcengruppe'), group, t('Vorschlag: eine eigene Gruppe, auf die Tresor-Admins keine Schreibrechte haben.')), field(t('Workspace-Name'), name), field(t('Region'), region));
  const existingBox = h('div', {}, field(t('Workspace'), existing));
  const baselineBox = h('div', { class: 'grid2' }, field(t('Vielfaches'), factor), field(t('Mindestens (Einträge pro Stunde)'), minimum));
  const fixedBox = h('div', {}, field(t('Mehr als (verschiedene Einträge pro Stunde)'), threshold));
  const result = h('div', { class: 'logging-result' });

  const options = () => ({
    workspace: mode.value === 'existing' ? { mode: 'existing', id: existing.value } : { mode: 'new', subscriptionId: d.subscriptionId, resourceGroup: group.value, name: name.value, location: region.value },
    retentionDays: Number(retention.value),
    email: email.value,
    reads: readsMode.value === 'fixed' ? { mode: 'fixed', threshold: Number(threshold.value) } : { mode: 'baseline', factor: Number(factor.value), minimum: Number(minimum.value) },
    denied: denied.checked,
    diagnostics: diagMode.value,
  });
  let applyBtn = null;
  let planned = false;
  const sync = () => {
    newBox.hidden = mode.value === 'existing';
    existingBox.hidden = mode.value !== 'existing';
    baselineBox.hidden = readsMode.value === 'fixed';
    fixedBox.hidden = readsMode.value !== 'fixed';
  };
  const invalidate = () => {
    planned = false;
    if (applyBtn) applyBtn.disabled = true;
    result.replaceChildren();
    sync();
  };
  sync();

  const body = h('div', { class: 'logging-dialog' },
    h('p', {}, t('Das Audit-Protokoll des Key Vaults geht in einen Log-Analytics-Workspace. Empfohlen: ein gemeinsamer Workspace pro Tenant bzw. Kunde, getrennt mit eigenen Rechten.')),
    field(t('Workspace'), mode), newBox, existingBox,
    field(t('Aufbewahrung'), retention, t('Kosten: Azure berechnet die aufgenommene Datenmenge (pro GB) und die Aufbewahrung über die freien Tage hinaus, dazu jede Warnregel monatlich. Key-Vault-Protokolle sind klein; aktuelle Preise im Azure-Preisrechner.')),
    field(t('E-Mail für Warnungen'), email),
    field(t('Warnung bei ungewöhnlich vielen Abrufen pro Person'), readsMode), baselineBox, fixedBox,
    h('label', { class: 'inline' }, denied, t('Zweite Warnregel: abgelehnte Zugriffe und Löschungen (meldet auch normales Löschen)')),
    h('p', { class: 'muted small' }, t('Immer dabei: Diagnoseeinstellung (AuditEvent, AllMetrics) und eine Warnung, wenn jemand sie ändert oder löscht. Grenzen: Das Protokoll zeigt den Zugriff auf Key Vault, nicht was jemand danach mit dem Wert macht; Daten kommen mit einigen Minuten Verzug an; Zugriffe vor der Einrichtung fehlen.')),
    diagBox, result);
  for (const el of [mode, existing, group, name, region, retention, email, readsMode, factor, minimum, threshold, denied, diagMode]) {
    el.addEventListener('input', invalidate);
    el.addEventListener('change', invalidate);
  }

  const { dialog } = modal(t('Protokollierung – {name}', { name: c.name }), body, [
    { label: t('Abbrechen') },
    { label: t('Probelauf'), onClick: async () => {
      result.replaceChildren(h('p', { class: 'muted small' }, t('Probelauf läuft …')));
      try {
        const plan = await call('loggingPlan', c.id, options());
        result.replaceChildren(stepList(plan));
        if (plan.steps.some((s) => s.redirect)) diagBox.hidden = false;
        planned = !plan.blocked;
        applyBtn.disabled = !planned;
      } catch (e) {
        result.replaceChildren(notice(e.message, 'warn'));
      }
      return false;
    } },
    { label: t('Einrichten'), primary: true, onClick: async () => {
      if (!planned) throw new Error(t('Bitte zuerst den Probelauf mit diesen Angaben starten.'));
      result.append(h('p', { class: 'muted small' }, t('Wird eingerichtet …')));
      // The main process forgets the dry run when it writes: after a failure the next try starts with a new one.
      planned = false;
      const r = await call('loggingApply', c.id, options());
      toast(t('Protokollierung eingerichtet ({count} Schritte)', { count: r.done }));
      onDone?.();
      return true;
    } },
  ]);
  const buttons = dialog.querySelectorAll('.modal-footer .btn');
  buttons[1].classList.add('logging-dryrun');
  applyBtn = buttons[2];
  applyBtn.classList.add('logging-apply');
  applyBtn.disabled = true;
}
