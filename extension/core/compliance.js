// Compliance view for the Verwalter of a Key Vault vault (#500): "Person ausgeschieden" (which entries could a person
// read, and was the password changed since) and "Passwörter älter als X Monate". Pure functions; the desktop main
// process reads the entries and the role assignments (desktop/main/api/compliance.js) and hands only metadata on.
//
// Nothing here carries a secret value: entryRow() picks metadata from an item, and the CSV takes fixed columns only.

import { t } from './i18n.js';

const DAY = 86_400_000;
export const AGE_CHOICES = [3, 6, 12];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- dates

/** Months 1–240, else null (3/6/12 from the choice or a number typed in). */
export function normalizeMonths(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : null;
}

/** The moment `months` calendar months before `now` (the 31st becomes the last day of a shorter month). */
export function monthsBefore(now, months) {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/** 'YYYY-MM-DD' → the start of that day (UTC), or null. */
export function dayStart(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

const ms = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// ---------------------------------------------------------------- entries (metadata only)

/**
 * When the password of an entry last changed. Only a real password change counts (`passwordChanged`, stamped on every
 * save that changes it, core/model.js stampPasswordChange); without one the creation, else the oldest version (#450).
 * Entries without a password (notes, cards): the last change of the entry. `hasPassword` (metadata rows from
 * core/compliance-entries.js, no secret value) stands in for the password itself.
 * → { at: ms (0 = unknown), source: 'password'|'created'|'version'|'updated'|'' }
 */
export function lastPasswordChange(item, oldestVersion = 0) {
  if (!(item?.hasPassword ?? !!item?.password)) return ms(item?.updated) ? { at: ms(item.updated), source: 'updated' } : { at: 0, source: '' };
  if (ms(item.passwordChanged)) return { at: ms(item.passwordChanged), source: 'password' };
  if (ms(item.created)) return { at: ms(item.created), source: 'created' };
  if (ms(oldestVersion)) return { at: ms(oldestVersion), source: 'version' };
  return { at: 0, source: '' };
}

/**
 * The row of an entry: fixed metadata picked from the item – never the password, notes, TOTP, fields or passkeys.
 * masked: '' | 'private' (someone else's "Nur für mich") | 'protected' (protected vault, title sealed).
 */
export function entryRow(item, { masked = '', oldestVersion = 0 } = {}) {
  const change = lastPasswordChange(item, oldestVersion);
  const hide = !!masked;
  return {
    id: String(item.id || ''),
    containerId: String(item.containerId || ''),
    key: hide ? '' : String(item.key || `${item.containerId}/${item.id}`),
    type: String(item.type || 'login'),
    title: hide ? '' : String(item.title || ''),
    username: hide ? '' : String(item.username || ''),
    folder: hide ? '' : String(item.folder || ''),
    masked: hide ? String(masked) : '',
    owner: masked === 'private' ? String(item.privateOwnerName || '') : '',
    hasPassword: !!(item.hasPassword ?? item.password),
    changedAt: change.at,
    source: change.source,
    estimated: !!item.estimated,
  };
}

/** Entries whose password is older than `months` (unknown dates included, at the end), oldest first. */
export function olderThan(rows, months, now = Date.now()) {
  const m = normalizeMonths(months);
  if (!m) throw new Error(t('Bitte eine Zahl von 1 bis 240 Monaten angeben.'));
  const limit = monthsBefore(now, m);
  return rows.filter((r) => r.hasPassword && (!r.changedAt || r.changedAt < limit))
    .map((r) => ({ ...r, ageDays: r.changedAt ? Math.floor((now - r.changedAt) / DAY) : null }))
    .sort((a, b) => (a.changedAt || Infinity) - (b.changedAt || Infinity) || labelOf(a).localeCompare(labelOf(b)));
}

/**
 * "Person ausgeschieden": the entries the person could read with "seitdem geändert" / "noch nicht geändert".
 * since: the day the person left (ms). reads (optional, from Log Analytics): Map entry id → { count, first, last };
 * then the reference is the person's last read of the entry, and an entry never read in the log is "nicht gelesen".
 * → rows with status 'changed' | 'unchanged' | 'notread', not yet changed first.
 */
export function leaverRows(rows, { since = Date.now(), reads = null } = {}) {
  const order = { unchanged: 0, notread: 2, changed: 1 };
  return rows.map((r) => {
    const read = reads ? reads.get(r.id) || null : null;
    const reference = read ? ms(read.last) : since;
    const status = reads && !read ? 'notread' : r.changedAt && r.changedAt > reference ? 'changed' : 'unchanged';
    return { ...r, status, reads: read ? read.count : null, firstRead: read ? ms(read.first) : 0, lastRead: read ? ms(read.last) : 0 };
  }).sort((a, b) => order[a.status] - order[b.status] || (a.changedAt || 0) - (b.changedAt || 0) || labelOf(a).localeCompare(labelOf(b)));
}

/** What a list shows for an entry: its title, or a masked label. */
export function labelOf(row) {
  if (row.masked === 'private') return row.owner ? t('Privater Eintrag von {name}', { name: row.owner }) : t('Privater Eintrag');
  if (row.masked === 'protected') return t('Eintrag in geschütztem Tresor');
  if (row.masked === 'unknown') return t('Gelöschter oder unbekannter Eintrag');
  return row.title || t('(ohne Titel)');
}

// ---------------------------------------------------------------- people

const lower = (v) => String(v || '').trim().toLowerCase();

/** Does a person from the log (UPN, object ID or app ID) belong to this member ({ principalId, detail })? */
export function samePerson(member, logPerson) {
  const p = lower(logPerson);
  return !!p && (p === lower(member.principalId) || (!!member.detail && p === lower(member.detail)));
}

/**
 * Former members from the activity log (as far as Azure keeps it, about 90 days): role assignments on the vault that
 * were deleted. events: the activity log values. → [{ principalId, removedAt, removedBy }], newest first.
 */
export function removedPrincipals(events, vaultId) {
  const scope = lower(vaultId);
  const out = new Map();
  for (const e of events || []) {
    if (lower(e.operationName?.value) !== 'microsoft.authorization/roleassignments/delete') continue;
    if (e.status?.value && lower(e.status.value) !== 'succeeded') continue;
    if (!lower(e.resourceId || e.authorization?.scope).startsWith(scope)) continue;
    let principalId = '';
    for (const raw of [e.properties?.responseBody, e.properties?.requestbody]) {
      try {
        principalId = JSON.parse(raw || '{}')?.properties?.principalId || principalId;
      } catch {
        // not JSON
      }
    }
    if (!GUID.test(principalId)) continue;
    const at = ms(e.eventTimestamp);
    if (!out.has(principalId) || out.get(principalId).removedAt < at) out.set(principalId, { principalId, removedAt: at, removedBy: String(e.caller || '') });
  }
  return [...out.values()].sort((a, b) => b.removedAt - a.removedAt);
}

// ---------------------------------------------------------------- export

/** Fixed columns per list: [header, row → value]. A secret value has no column, so it can't reach the file. */
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const time = (v) => (ms(v) ? new Date(ms(v)).toISOString().replace('T', ' ').slice(0, 16) : '');
const SOURCE = { password: 'Passwortänderung', created: 'Anlage', version: 'älteste Version', updated: 'letzte Änderung', '': 'unbekannt' };
const STATUS = { changed: 'seitdem geändert', unchanged: 'noch nicht geändert', notread: 'laut Protokoll nicht gelesen' };
const COLUMNS = {
  old: [['Eintrag', labelOf], ['Benutzername', (r) => r.username], ['Ordner', (r) => r.folder], ['Passwort geändert', (r) => day(r.changedAt)],
    ['Quelle', (r) => t(SOURCE[r.source] || SOURCE[''])], ['Alter (Tage)', (r) => (r.ageDays ?? '')]],
  leaver: [['Eintrag', labelOf], ['Benutzername', (r) => r.username], ['Ordner', (r) => r.folder], ['Status', (r) => t(STATUS[r.status] || '')],
    ['Passwort geändert', (r) => day(r.changedAt)], ['Quelle', (r) => t(SOURCE[r.source] || SOURCE[''])]],
  // With Log Analytics (core/compliance-log.js): the person's read history and the standard reports.
  leaverlog: [['Eintrag', labelOf], ['Benutzername', (r) => r.username], ['Ordner', (r) => r.folder], ['Status', (r) => t(STATUS[r.status] || '')],
    ['Passwort geändert', (r) => day(r.changedAt)], ['Abrufe', (r) => (r.reads ?? '')], ['Zuletzt gelesen', (r) => time(r.lastRead)]],
  reads: [['Person', (r) => r.Person], ['Eintrag', (r) => r.entry], ['Abrufe', (r) => r.Reads], ['Erster Abruf', (r) => time(r.First)], ['Letzter Abruf', (r) => time(r.Last)]],
  many: [['Person', (r) => r.Person], ['Stunde', (r) => time(r.Hour)], ['Verschiedene Einträge', (r) => r.Entries], ['Abrufe', (r) => r.Reads]],
  denied: [['Zeit', (r) => time(r.TimeGenerated)], ['Person', (r) => r.Person], ['Vorgang', (r) => r.OperationName], ['Eintrag', (r) => r.entry], ['IP-Adresse', (r) => r.CallerIPAddress]],
  apps: [['App-ID', (r) => r.App], ['Person', (r) => r.Person], ['Anfragen', (r) => r.Requests], ['Vorgänge', (r) => [].concat(r.Operations || []).join(', ')],
    ['Erste', (r) => time(r.First)], ['Letzte', (r) => time(r.Last)]],
  changes: [['Zeit', (r) => time(r.TimeGenerated)], ['Person', (r) => r.Person], ['Vorgang', (r) => r.OperationName], ['Eintrag', (r) => r.entry]],
};

/** Header and cells of a list as shown and exported. */
export function tableOf(kind, rows) {
  const cols = COLUMNS[kind];
  if (!cols) throw new Error(`unknown list ${kind}`);
  return { headers: cols.map(([name]) => t(name)), rows: rows.map((r) => cols.map(([, get]) => String(get(r) ?? ''))) };
}

/** A cell for Excel: quoted; a leading = + - @ is defused (no formula from an entry title). */
const cell = (v) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** CSV for Excel (German locale): semicolon, UTF-8 with BOM, a header line with what the file holds. */
export function complianceCsv(kind, rows, meta = '') {
  const table = tableOf(kind, rows);
  const lines = [...(meta ? [[meta]] : []), table.headers, ...table.rows];
  return `\uFEFF${lines.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
