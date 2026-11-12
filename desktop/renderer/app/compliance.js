// Compliance (#500): for the Verwalter of a Key Vault vault in admin mode – "Person ausgeschieden", "Passwörter älter
// als X Monate" and, with a Log Analytics workspace (#486), the standard reports. Entry in the vault menu and in the
// main menu (tools). The main process checks admin mode and the role again (api/compliance.js) and sends metadata only.

import { h, icon, modal, setChildren } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { AGE_CHOICES, dayStart, leaverRows, normalizeMonths, olderThan } from '../../../extension/core/compliance.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { field, notice, tabbed, LEVEL_LABEL } from './helpers.js';
import { adminMode } from './modes.js';
import { reportCtx } from './health.js';
import { healthDialog } from '../reports.js';
import { coverageLine, exportButton, reportPage, table, today } from './compliance-reports.js';

const DAY = 86_400_000;
const STATUS_BADGE = { changed: ['ok', 'seitdem geändert'], unchanged: ['warn', 'noch nicht geändert'], notread: ['', 'laut Protokoll nicht gelesen'] };

/** Verwalter of a Key Vault vault (Verwalten or Key Vault Administrator) – the main process checks the same. */
export const mayComplianceOn = (c) => adminMode() && c?.kind === 'keyvault' && !c.personal && !c.error && !!(c.access?.admin || c.access?.manage);
const managedVaults = () => (st.containers || []).filter(mayComplianceOn);

/** Vault menu: "Compliance" (admin mode, Verwalter only). */
export function complianceAction(c) {
  return mayComplianceOn(c) ? { action: 'compliance', icon: 'shield', label: t('Compliance'), onClick: () => complianceDialog(c) } : null;
}

/** Main menu (tools): "Compliance" when the person administers at least one Key Vault vault. */
export function complianceMenuOffered() {
  return managedVaults().length > 0;
}

export function openCompliance() {
  const vaults = managedVaults();
  if (vaults.length === 1) return complianceDialog(vaults[0]);
  const { close } = modal(t('Compliance'), h('div', { class: 'compliance-pick' },
    h('p', {}, t('Für welchen Tresor?')),
    ...vaults.map((c) => h('button', { type: 'button', class: 'option-card', dataset: { vault: c.id }, onclick: () => {
      close();
      complianceDialog(c);
    } }, icon('shield', 20), h('div', {}, h('b', {}, c.name))))), [{ label: t('Abbrechen') }]);
}

const privacyNote = () => h('p', { class: 'muted small compliance-privacy' },
  t('Datenschutz: Diese Ansicht zeigt, wer auf welche Einträge zugreifen konnte und – mit Protokollierung – wer was wann gelesen hat. Das sind personenbezogene Daten: nur für den Zweck nutzen (z. B. Passwörter nach dem Ausscheiden ändern), Exporte geschützt ablegen und danach löschen. Keevault zeigt und exportiert nie Passwörter oder andere geheime Werte.'));

export async function complianceDialog(c, { readAll = false } = {}) {
  const body = h('div', { class: 'compliance' }, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Einträge und Rollen werden geladen …')));
  const { dialog, close } = modal(t('Compliance: {name}', { name: c.name }), body, [{ label: t('Schließen') }]);
  dialog.classList.add('report-modal', 'compliance-modal');
  let state;
  let entries;
  try {
    [state, entries] = await Promise.all([call('complianceState', c.id), call('complianceEntries', c.id, { readAll })]);
  } catch (e) {
    setChildren(body, notice(e.message, 'warn'));
    return;
  }
  const logged = state.logging.state === 'active';
  const pages = [
    { label: t('Person ausgeschieden'), icon: 'users', content: [leaverPage(c, state, entries, logged, close)] },
    { label: t('Alte Passwörter'), icon: 'clock', content: [agePage(c, entries, close)] },
    { label: t('Protokoll-Auswertung'), icon: 'search', content: [reportPage(c, state, logged, close)] },
  ];
  setChildren(body,
    entries.skipped ? notice(t('{n} Einträge konnten nicht gelesen werden (gesperrter geschützter Tresor oder Netzwerkfehler) und fehlen in den Listen.', { n: entries.skipped }), 'warn') : null,
    entries.estimated ? estimatedNote(c, entries.estimated, close) : null,
    tabbed('compliance', pages), privacyNote());
}

/** Entries saved before the metadata existed: estimated; reading them all is offered, never done on its own. */
function estimatedNote(c, n, close) {
  return h('div', { class: 'compliance-estimated' },
    notice(t('Bei {n} Einträgen ist die letzte Passwortänderung nicht als Metadaten gespeichert (vor dieser Version angelegt oder geändert). Die Listen nehmen dafür die älteste Version an.', { n }), 'info'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small compliance-readall', onclick: () => {
      close();
      complianceDialog(c, { readAll: true });
    } }, t('Genau ermitteln – liest alle diese Einträge, kann eine Warnung auslösen'))));
}

// ---------------------------------------------------------------- "Person ausgeschieden"

function leaverPage(c, state, entries, logged, close) {
  const people = [...state.members.map((m) => ({ ...m, key: `m:${m.principalId}` })), ...state.former.map((m) => ({ ...m, key: `f:${m.principalId}` }))];
  const label = (m) => {
    const who = m.detail && m.detail !== m.displayName ? `${m.displayName} (${m.detail})` : m.displayName || m.principalId;
    if (m.former) return t('{who} – ehemals, entfernt am {date}', { who, date: new Date(m.removedAt).toLocaleDateString() });
    return `${who} – ${t(LEVEL_LABEL[m.level] || m.level || '')}${m.inherited ? ` (${t('vererbt')})` : ''}`;
  };
  const person = h('select', { class: 'compliance-person' }, h('option', { value: '' }, t('Person oder Gruppe wählen …')),
    ...people.map((m) => h('option', { value: m.key }, label(m))),
    logged ? h('option', { value: 'other' }, t('Andere Person (UPN oder Objekt-ID) …')) : null);
  const other = h('input', { class: 'compliance-other', hidden: true, spellcheck: 'false', placeholder: 'name@contoso.com', 'aria-label': t('UPN oder Objekt-ID') });
  person.addEventListener('change', () => { other.hidden = person.value !== 'other'; });
  const left = h('input', { type: 'date', class: 'compliance-left', value: today(), max: today() });
  const out = h('div', { class: 'compliance-result' });

  const show = async () => {
    const typed = other.value.trim();
    const m = person.value === 'other' ? { principalId: typed, detail: typed, displayName: typed } : people.find((p) => p.key === person.value);
    if (!m || !m.principalId) {
      setChildren(out, notice(t('Bitte eine Person wählen.'), 'warn'));
      return;
    }
    const since = dayStart(left.value) ?? Date.now();
    if (m.level === 'none') {
      setChildren(out, notice(t('{name} hat auf diesem Tresor keine Datenrolle und konnte keine Einträge lesen.', { name: m.displayName }), 'ok'));
      return;
    }
    // With a workspace: the real read history of the person (Log Analytics knows single people, not groups).
    let reads = null;
    let coverage = null;
    const notes = [];
    if (logged && m.principalType !== 'Group') {
      setChildren(out, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Lese-Historie wird aus Log Analytics geladen …')));
      try {
        const r = await call('complianceReads', c.id, { person: { principalId: m.principalId, detail: m.detail }, from: Date.now() - 730 * DAY, to: Date.now() });
        reads = new Map(r.reads.map((x) => [x.id, x]));
        coverage = r.coverage;
      } catch (e) {
        notes.push(notice(e.message, 'warn'));
      }
    }
    if (!reads) {
      notes.push(notice(t('Seit wann diese Person lesen konnte, weiß Keevault ohne Protokollierung nicht. Die Liste zeigt alle Einträge, die die Rolle heute erlaubt, und ob das Passwort nach dem gewählten Tag geändert wurde.'), 'info'));
      if (logged && m.principalType === 'Group') notes.push(h('p', { class: 'muted small' }, t('Für Gruppen gibt es keine Lese-Historie – das Protokoll nennt einzelne Personen.')));
    }
    const rows = leaverRows(entries.rows, { since, reads });
    const open = rows.filter((r) => r.status === 'unchanged').length;
    const kind = reads ? 'leaverlog' : 'leaver';
    setChildren(out, ...notes, coverage ? coverageLine(coverage) : null,
      h('p', { class: 'compliance-summary' }, reads
        ? t('{read} von {total} Einträgen laut Protokoll gelesen, davon {open} seit dem letzten Abruf nicht geändert.', { read: rows.filter((r) => r.status !== 'notread').length, total: rows.length, open })
        : t('{total} Einträge, davon {open} seit dem {date} nicht geändert.', { total: rows.length, open, date: new Date(since).toLocaleDateString() })),
      rows.length ? table(kind, rows, close, (r, n) => (n === 3 ? h('span', { class: `badge ${STATUS_BADGE[r.status][0]}` }, t(STATUS_BADGE[r.status][1])) : null)) : null,
      rows.length ? h('div', { class: 'actions' }, exportButton(kind, rows, 'Keevault-Compliance-Ausgeschieden',
        t('Tresor {vault} · Person {person} · ausgeschieden {date} · erstellt {now}', { vault: c.name, person: m.detail || m.displayName, date: left.value, now: new Date().toLocaleString() }))) : null);
  };
  return h('div', { class: 'compliance-leaver' },
    h('p', { class: 'muted small' }, t('Arbeitsliste nach dem Ausscheiden oder einem verlorenen Gerät: Welche Einträge konnte die Person lesen, und wurde das Passwort seitdem geändert? Rollen aus Azure; frühere Mitglieder, soweit das Aktivitätsprotokoll sie noch kennt (etwa 90 Tage).')),
    state.membersError ? notice(state.membersError, 'warn') : null,
    state.formerKnown ? null : h('p', { class: 'muted small' }, t('Frühere Mitglieder sind nicht bekannt (Aktivitätsprotokoll nicht lesbar).')),
    h('div', { class: 'grid2' }, field(t('Person'), person), field(t('Ausgeschieden am'), left)), other,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary small compliance-show', onclick: show }, t('Anzeigen'))),
    out);
}

// ---------------------------------------------------------------- "Passwörter älter als X Monate"

function agePage(c, entries, close) {
  let months = 12;
  const out = h('div', { class: 'compliance-result' });
  const free = h('input', { type: 'number', min: '1', max: '240', class: 'compliance-months', value: String(months), 'aria-label': t('Monate') });
  const seg = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': t('Älter als') });
  const draw = () => {
    seg.replaceChildren(...AGE_CHOICES.map((n) => h('button', { type: 'button', role: 'radio', class: n === months ? 'on' : '', 'aria-checked': String(n === months), dataset: { months: String(n) },
      onclick: () => { months = n; free.value = String(n); draw(); } }, t('{n} Monate', { n }))));
    let rows;
    try {
      rows = olderThan(entries.rows, months);
    } catch (e) {
      setChildren(out, notice(e.message, 'warn'));
      return;
    }
    const checked = entries.rows.filter((r) => r.hasPassword).length;
    setChildren(out,
      h('p', { class: 'compliance-summary' }, t('{n} von {checked} Passwörtern seit über {months} Monaten nicht geändert.', { n: rows.length, checked, months })),
      rows.length ? table('old', rows, close) : h('p', { class: 'notice ok' }, t('Keine Passwörter älter als {months} Monate.', { months })),
      h('div', { class: 'actions' },
        rows.length ? exportButton('old', rows, 'Keevault-Compliance-Passwortalter', t('Tresor {vault} · Passwörter älter als {months} Monate · erstellt {now}', { vault: c.name, months, now: new Date().toLocaleString() })) : null,
        h('button', { type: 'button', class: 'btn small', onclick: () => { close(); healthDialog(reportCtx(c.id)); } }, icon('shield', 14), t('Passwort-Check öffnen'))));
  };
  free.addEventListener('input', () => {
    const n = normalizeMonths(free.value);
    if (n) {
      months = n;
      draw();
    }
  });
  draw();
  return h('div', { class: 'compliance-age' },
    h('p', { class: 'muted small' }, t('Es zählt nur eine echte Passwortänderung, nicht das Bearbeiten von Titel oder Notizen. Ohne erfasste Änderung gilt das Anlagedatum.')),
    h('div', { class: 'inline' }, seg, field(t('oder Monate'), free)), out);
}
