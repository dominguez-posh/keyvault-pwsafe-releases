// Version history at the foot of an entry's detail view (#450): "Last edited <date>" unfolds into a timeline with the
// versions in between and "Added <date>". Reading only; the caller decides what a click on a version does.

import { h, icon, formatDateTime, setChildren } from './dom.js';
import { t } from './i18n.js';

/** Versions shown before "Show earlier versions". */
const FIRST_SHOWN = 3;
/** Two timestamps this close are the same moment (creation = first version). */
const SAME_MOMENT_MS = 5000;

/**
 * The timeline rows from the version list (newest first) and the entry: the current version, the versions in between
 * and the start ("Added"). Pure, for the unit test.
 * @returns {Array<{ kind: 'current'|'version'|'added', version?: object, date: number|string }>}
 */
export function timelineRows(versions, item) {
  const list = Array.isArray(versions) ? versions : [];
  const created = item?.created ? Date.parse(item.created) : NaN;
  const rows = [{ kind: 'current', version: list[0], date: list[0]?.updated || item?.updated }];
  const older = list.slice(1);
  const oldest = older.at(-1);
  // The oldest version is the creation itself: it becomes the "Added" row and stays clickable.
  const startIsVersion = oldest && (Number.isNaN(created) || Math.abs(oldest.updated - created) <= SAME_MOMENT_MS);
  for (const v of startIsVersion ? older.slice(0, -1) : older) rows.push({ kind: 'version', version: v, date: v.updated });
  if (startIsVersion) rows.push({ kind: 'added', version: oldest, date: created || oldest.updated });
  else if (item?.created) rows.push({ kind: 'added', date: item.created });
  return rows;
}

/**
 * @param {object} item
 * @param {{ load: () => Promise<Array<{ version: string, updated: number, enabled: boolean, updatedBy?: string }>>,
 *           open: (version: object) => void }} history
 */
export function historySection(item, history) {
  const label = item.updatedBy
    ? t('Zuletzt bearbeitet {date} von {user}', { date: formatDateTime(item.updated), user: item.updatedBy })
    : t('Zuletzt bearbeitet {date}', { date: formatDateTime(item.updated) });
  const body = h('div', { class: 'version-timeline', hidden: true, dataset: { versionTimeline: '1' } });
  const toggle = h('button', { type: 'button', class: 'version-toggle muted', 'aria-expanded': 'false' },
    h('span', { class: 'version-toggle-text' }, label), icon('chevronDown', 14));
  let loaded = false;
  toggle.addEventListener('click', async () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open || loaded) return;
    loaded = true;
    setChildren(body, h('p', { class: 'muted small' }, t('Wird geladen …')));
    try {
      renderTimeline(body, timelineRows(await history.load(), item), history);
    } catch {
      loaded = false;
      setChildren(body, h('p', { class: 'muted small' }, t('Der Verlauf konnte nicht geladen werden.')));
    }
  });
  return h('div', { class: 'meta version-history' }, toggle, body);
}

function renderTimeline(body, rows, history) {
  const last = rows.length - 1;
  const nodes = rows.map((row, i) => {
    const li = timelineRow(row, history);
    // Beyond the first few versions: folded away until "Show earlier versions" (never the current one or the start).
    if (i > FIRST_SHOWN && i < last) li.hidden = true;
    return li;
  });
  const folded = nodes.filter((li) => li.hidden);
  if (folded.length) {
    const more = h('li', { class: 'timeline-more' }, h('button', { type: 'button', class: 'btn small version-more', onclick: () => {
      for (const li of folded) li.hidden = false;
      more.remove();
    } }, t('Vorherige Versionen anzeigen')));
    nodes.splice(last, 0, more);
  }
  setChildren(body, h('ul', { class: 'timeline' }, ...nodes));
}

function timelineRow(row, history) {
  const v = row.version;
  const when = typeof row.date === 'number' ? formatDateTime(row.date) : formatDateTime(Date.parse(row.date) || row.date);
  const title = row.kind === 'added' ? t('Hinzugefügt {date}', { date: when }) : when;
  const current = row.kind === 'current';
  const unreadable = v && v.enabled === false && !current;
  const dot = h('span', { class: 'timeline-dot', 'aria-hidden': 'true' });
  const text = [
    h('span', { class: 'timeline-title' }, title, current ? h('span', { class: 'badge accent' }, t('aktuell')) : null),
    v?.updatedBy ? h('span', { class: 'timeline-sub muted small' }, v.updatedBy) : null,
    unreadable ? h('span', { class: 'timeline-sub muted small' },
      t('Nicht mehr lesbar: Ein Schlüsselwechsel hat diese Version gesperrt. Sie bleibt nur für das Protokoll erhalten.')) : null,
  ];
  // Current version: nothing to open (it is the one on screen). Readable older ones open read-only.
  if (!v || current || unreadable) return h('li', { class: `timeline-row ${unreadable ? 'unreadable' : ''}`, dataset: { kind: row.kind } }, dot, h('div', { class: 'timeline-text' }, ...text));
  return h('li', { class: 'timeline-row', dataset: { kind: row.kind } }, dot,
    h('button', { type: 'button', class: 'timeline-text timeline-open', title: t('Anzeigen'), onclick: () => history.open(v) }, ...text));
}
