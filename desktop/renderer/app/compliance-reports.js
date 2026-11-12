// Compliance (#500) with a Log Analytics workspace (#486): the tab "Protokoll-Auswertung" with the standard reports, and
// the parts the compliance view shares – the table and the CSV export (the same fixed columns, never a secret value).

import { h, icon, toast, setChildren, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { complianceCsv, dayStart, tableOf } from '../../../extension/core/compliance.js';
import { MANY_DEFAULT, REPORT_KINDS } from '../../../extension/core/compliance-log.js';
import { call } from './ipc.js';
import { field, notice } from './helpers.js';
import { reportCtx } from './health.js';

const DAY = 86_400_000;
export const today = () => new Date().toISOString().slice(0, 10);
const dayBefore = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const REPORT_LABELS = { reads: 'Abrufe je Person und Eintrag', many: 'Ungewöhnlich viele Abrufe', denied: 'Abgelehnte Zugriffe', apps: 'Zugriffe anderer Apps', changes: 'Änderungen und Löschungen' };

/** Table from the shared columns (the same as the CSV), with "Öffnen" for entries the admin may see. */
export function table(kind, rows, close, decorate = null) {
  const { headers, rows: cells } = tableOf(kind, rows);
  return h('div', { class: 'table' }, h('table', { class: `compliance-table compliance-${kind}` },
    h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, x)), h('th', {}))),
    h('tbody', {}, ...rows.map((r, i) => h('tr', { dataset: { status: r.status || '', masked: r.masked || '' } },
      ...cells[i].map((v, n) => h('td', {}, decorate?.(r, n) || v)),
      h('td', { class: 'row-actions' }, r.key ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        close();
        reportCtx(r.containerId).openItem({ containerId: r.containerId || r.key.split('/')[0], key: r.key, folder: r.folder });
      } }, t('Öffnen')) : null))))));
}

export function exportButton(kind, rows, name, meta) {
  return h('button', { type: 'button', class: 'btn small compliance-export', dataset: { kind }, onclick: async () => {
    try {
      if (await call('saveTextFile', { name: `${name}-${today()}.csv`, text: complianceCsv(kind, rows, meta) })) toast(t('CSV gespeichert'));
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('download', 14), t('CSV exportieren'));
}

/** How far back the workspace has events of the vault. */
export function coverageLine(cov) {
  return h('p', { class: 'muted small compliance-coverage' }, cov.first
    ? t('Daten im Workspace „{ws}“ reichen zurück bis {first} ({events} Ereignisse). Zugriffe davor sind nicht erfasst.', { ws: cov.workspaceName, first: formatDateTime(cov.first), events: cov.events })
    : t('Im Workspace „{ws}“ gibt es noch keine Ereignisse dieses Tresors (Daten kommen mit einigen Minuten Verzögerung an).', { ws: cov.workspaceName }));
}

/** Tab "Protokoll-Auswertung": fixed reports over a chosen time range, titles only where the admin may see them. */
export function reportPage(c, state, logged, close) {
  if (!logged) {
    return h('div', { class: 'compliance-reports', dataset: { logged: '0' } }, notice(t('Für diesen Tresor ist keine Protokollierung eingerichtet. Mit einem Log-Analytics-Workspace zeigt Keevault hier, wer was wann gelesen hat, abgelehnte Zugriffe, Zugriffe anderer Apps und Änderungen (Tresor-Einstellungen → Protokollierung).'), 'info'));
  }
  const kind = h('select', { class: 'compliance-kind' }, ...REPORT_KINDS.map((k) => h('option', { value: k }, t(REPORT_LABELS[k]))));
  const from = h('input', { type: 'date', class: 'compliance-from', value: dayBefore(30), max: today() });
  const to = h('input', { type: 'date', class: 'compliance-to', value: today(), max: today() });
  const threshold = h('input', { type: 'number', min: '1', max: '100000', class: 'compliance-threshold', value: String(MANY_DEFAULT) });
  const thresholdField = field(t('Mehr als … verschiedene Einträge pro Stunde'), threshold);
  const out = h('div', { class: 'compliance-result' });
  const sync = () => { thresholdField.hidden = kind.value !== 'many'; };
  kind.addEventListener('change', sync);
  sync();
  const run = async () => {
    setChildren(out, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Abfrage läuft …')));
    let r;
    try {
      r = await call('complianceReport', c.id, { kind: kind.value, from: dayStart(from.value), to: (dayStart(to.value) ?? Date.now()) + DAY - 1, threshold: Number(threshold.value) });
    } catch (e) {
      setChildren(out, notice(e.message, 'warn'));
      return;
    }
    setChildren(out, coverageLine(r.coverage),
      r.kind === 'apps' && !state.ownApp ? h('p', { class: 'muted small' }, t('Keevault nutzt hier die gemeinsame Standard-App. Zugriffe anderer Werkzeuge mit derselben App-ID (z. B. Azure CLI) erscheinen deshalb nicht in dieser Liste.')) : null,
      h('p', { class: 'compliance-summary' }, t('{n} Zeilen', { n: r.rows.length })),
      r.rows.length ? table(r.kind, r.rows, close) : h('p', { class: 'notice ok' }, t('Keine Einträge im gewählten Zeitraum.')),
      r.rows.length ? h('div', { class: 'actions' }, exportButton(r.kind, r.rows, `Keevault-Compliance-${r.kind}`,
        t('Tresor {vault} · {report} · {from} bis {to} · erstellt {now}', { vault: c.name, report: t(REPORT_LABELS[r.kind]), from: from.value, to: to.value, now: new Date().toLocaleString() }))) : null);
  };
  return h('div', { class: 'compliance-reports', dataset: { logged: '1' } },
    h('p', { class: 'muted small' }, t('Feste Abfragen im Workspace „{ws}“, nur lesend. Dafür brauchst du die Rolle „Log Analytics Reader“. Titel siehst du nur für Einträge, die du sehen darfst; private Einträge anderer und gesperrte geschützte Tresore bleiben verborgen.', { ws: state.logging.workspaceName })),
    h('div', { class: 'grid2' }, field(t('Bericht'), kind), thresholdField),
    h('div', { class: 'grid2' }, field(t('Von'), from), field(t('Bis'), to)),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary small compliance-run', onclick: run }, t('Abfragen'))),
    out);
}
