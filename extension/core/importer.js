// Import from other password managers:
//   Bitwarden       JSON (unencrypted, incl. passkeys, cards/identities as notes) and CSV
//   1Password       1PUX (ZIP with export.data) and CSV
//   KeePass         XML (KeePass 2.x / KeePassXC, incl. KeePassXC passkeys) and CSV (KeePass 2.x, KeePassXC)
//   Browsers        Edge/Chrome and Firefox CSV
//   Generic CSV     columns are mapped by name and can be adjusted (see import-sample.js)
//   Keevault JSON export

import { b64uEncode, b64uDecode, fromHex, fromUtf8, utf8 } from './util.js';
import { normalizeItem } from './model.js';
import { hostFromUrl } from './match.js';
import { parseXml, child, children, textOf } from './xml.js';
import { isZip, readZip } from './zip.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------- CSV

// Delimiter from the header line: comma, or semicolon/tab (Excel with German locale).
function detectDelimiter(s) {
  const header = s.slice(0, s.search(/\r?\n|$/)).replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map((d) => [d, header.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const delimiter = detectDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Target fields for CSV columns. */
export const CSV_TARGETS = ['title', 'username', 'password', 'url', 'totp', 'notes', 'folder', 'favorite', 'type', 'field', 'ignore'];
export const CSV_TARGET_LABELS = {
  title: 'Titel', username: 'Benutzername', password: 'Passwort', url: 'Website', totp: 'Einmalcode (TOTP)', notes: 'Notizen',
  folder: 'Ordner', favorite: 'Favorit', type: 'Typ', field: 'Zusatzfeld', ignore: 'Nicht importieren',
};

const COLUMN_NAMES = {
  title: ['title', 'name', 'account', 'titel', 'eintrag', 'bezeichnung'],
  username: ['login_username', 'username', 'user name', 'login name', 'login', 'user', 'email', 'e-mail', 'benutzername', 'benutzer'],
  password: ['login_password', 'password', 'passwort', 'kennwort'],
  url: ['login_uri', 'url', 'urls', 'uri', 'website', 'web site', 'origin_url', 'adresse'],
  totp: ['login_totp', 'totp', 'otpauth', 'otp', 'one-time password', 'einmalcode'],
  notes: ['notes', 'note', 'comments', 'comment', 'extra', 'notizen', 'notiz', 'bemerkung'],
  folder: ['folder', 'group', 'collection', 'tags', 'ordner', 'gruppe'],
  favorite: ['favorite', 'fav', 'favorit'],
  type: ['type', 'typ'],
};
const IGNORED = new Set(['icon', 'last modified', 'created', 'modified', 'guid', 'uuid', 'id', 'httprealm', 'formactionorigin',
  'timecreated', 'timelastused', 'timepasswordchanged', 'reprompt', 'archived', 'fields', 'login_fido2credentials']);

const CSV_FLAVORS = [
  { format: 'bitwarden-csv', label: 'Bitwarden (CSV)', test: (h) => h.includes('login_password') },
  { format: 'keepassxc-csv', label: 'KeePassXC (CSV)', test: (h) => h.includes('group') && h.includes('title') && h.includes('username') },
  { format: 'keepass-csv', label: 'KeePass (CSV)', test: (h) => h.includes('account') && h.includes('login name') },
  { format: '1password-csv', label: '1Password (CSV)', test: (h) => h.includes('otpauth') || (h.includes('archived') && h.includes('title')) },
  { format: 'firefox-csv', label: 'Firefox (CSV)', test: (h) => h.includes('httprealm') || h.includes('formactionorigin') },
  { format: 'browser-csv', label: 'Edge/Chrome (CSV)', test: (h) => h.join(',') === 'name,url,username,password,note' || h.join(',') === 'name,url,username,password' },
];

export function autoMapping(columns, rows) {
  const used = new Set();
  return columns.map((col, i) => {
    const h = col.trim().toLowerCase();
    if (h === 'fields') return 'bwfields';
    for (const [target, names] of Object.entries(COLUMN_NAMES)) {
      if (!used.has(target) && names.includes(h)) {
        used.add(target);
        return target;
      }
    }
    if (IGNORED.has(h) || !rows.some((r) => (r[i] || '').trim())) return 'ignore';
    return 'field';
  });
}

const truthy = (v) => ['1', 'true', 'yes', 'ja', 'x', 'y'].includes(String(v).trim().toLowerCase());

/** Builds items from CSV rows with a column mapping (array of targets per column). */
export function applyCsvMapping(columns, rows, mapping) {
  return rows.filter((row) => mapping.some((m, i) => m !== 'ignore' && (row[i] || '').trim())).map((row) => {
    const get = (target) => mapping.map((m, i) => (m === target ? (row[i] || '').trim() : '')).filter(Boolean);
    const one = (target) => get(target)[0] || '';
    const fields = [];
    mapping.forEach((m, i) => {
      const value = row[i] || '';
      if (m === 'field' && value.trim()) fields.push({ name: columns[i], value, hidden: /pin|secret|geheim|passw|kennw|code/i.test(columns[i]) });
      if (m === 'bwfields' && value.trim()) {
        for (const line of value.split(/\r?\n/)) {
          const idx = line.indexOf(': ');
          if (idx > 0) fields.push({ name: line.slice(0, idx), value: line.slice(idx + 2), hidden: false });
        }
      }
    });
    const urls = get('url').flatMap((u) => u.split(/[\s,|]+/)).filter((u) => u.includes('.') || u.includes('://'));
    const typeValue = one('type').toLowerCase();
    const username = one('username');
    const password = mapping.map((m, i) => (m === 'password' ? row[i] || '' : '')).find(Boolean) || '';
    const notes = mapping.map((m, i) => (m === 'notes' ? row[i] || '' : '')).filter(Boolean).join('\n');
    const isNote = ['note', 'securenote', 'secure note', 'notiz', '2'].includes(typeValue) || (!username && !password && !urls.length && notes);
    return normalizeItem({
      type: isNote ? 'note' : 'login',
      title: one('title') || (urls[0] ? hostFromUrl(urls[0]) : ''),
      username,
      password,
      urls,
      totp: one('totp'),
      notes,
      folder: one('folder').replace(/^Root\/?/i, ''),
      favorite: truthy(one('favorite')),
      fields,
    });
  });
}

function fromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(t('Die CSV-Datei enthält keine Einträge'));
  const columns = rows[0].map((c) => c.trim());
  const body = rows.slice(1);
  const header = columns.map((c) => c.toLowerCase());
  const flavor = CSV_FLAVORS.find((f) => f.test(header)) || { format: 'generic-csv', label: t('CSV (allgemein)') };
  const mapping = autoMapping(columns, body);
  if (!mapping.includes('password') && !mapping.includes('notes') && !mapping.includes('title')) {
    throw new Error(t('CSV-Spalten nicht erkannt – bitte die Kopfzeile prüfen (siehe Beispieldatei)'));
  }
  return { format: flavor.format, label: flavor.label, items: applyCsvMapping(columns, body, mapping), csv: { columns, rows: body, mapping } };
}

// ---------------------------------------------------------------- Bitwarden JSON

// Bitwarden stores passkey IDs as GUID strings or "b64.<base64url>".
function bitwardenCredentialId(id) {
  const s = String(id || '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return b64uEncode(fromHex(s));
  if (s.startsWith('b64.')) return b64uEncode(b64uDecode(s.slice(4)));
  return b64uEncode(b64uDecode(s));
}

function detailFields(obj, labels) {
  return Object.entries(labels).filter(([k]) => obj?.[k]).map(([k, [name, hidden]]) => ({ name: t(name), value: String(obj[k]), hidden }));
}

function fromBitwardenJson(data) {
  if (data.encrypted) throw new Error(t('Verschlüsselte Bitwarden-Exporte werden nicht unterstützt – bitte als „.json“ ohne Passwortschutz exportieren'));
  const folders = new Map((data.folders || []).map((f) => [f.id, f.name]));
  const collections = new Map((data.collections || []).map((c) => [c.id, c.name]));
  const items = [];
  for (const it of data.items || []) {
    if (it.deletedDate) continue;
    const login = it.login || {};
    const passkeys = (login.fido2Credentials || [])
      .filter((c) => c.keyAlgorithm === 'ECDSA' && (c.keyCurve || 'P-256') === 'P-256' && c.keyValue)
      .map((c) => ({
        credentialId: bitwardenCredentialId(c.credentialId),
        rpId: c.rpId,
        rpName: c.rpName || c.rpId,
        userHandle: c.userHandle ? b64uEncode(b64uDecode(c.userHandle)) : '',
        userName: c.userName || '',
        userDisplayName: c.userDisplayName || '',
        algorithm: -7,
        privateKey: b64uEncode(b64uDecode(c.keyValue)),
        signCount: Number(c.counter) || 0,
        discoverable: String(c.discoverable) !== 'false',
        created: c.creationDate || '',
      }));
    const fields = (it.fields || []).filter((f) => f.type !== 3).map((f) => ({ name: f.name, value: f.value ?? '', hidden: f.type === 1 }));
    if (it.type === 3) {
      fields.push(...detailFields(it.card, {
        cardholderName: ['Karteninhaber', false], brand: ['Marke', false], number: ['Kartennummer', true],
        expMonth: ['Ablaufmonat', false], expYear: ['Ablaufjahr', false], code: ['Prüfnummer', true],
      }));
    }
    if (it.type === 4) {
      fields.push(...detailFields(it.identity, {
        title: ['Anrede', false], firstName: ['Vorname', false], lastName: ['Nachname', false], email: ['E-Mail', false],
        phone: ['Telefon', false], company: ['Firma', false], address1: ['Adresse', false], postalCode: ['PLZ', false],
        city: ['Ort', false], country: ['Land', false], ssn: ['Sozialversicherungsnummer', true], passportNumber: ['Passnummer', true],
        licenseNumber: ['Führerscheinnummer', true], username: ['Benutzername', false],
      }));
    }
    items.push(normalizeItem({
      type: it.type === 1 ? 'login' : 'note',
      title: it.name,
      username: login.username || '',
      password: login.password || '',
      urls: (login.uris || []).map((u) => u.uri).filter(Boolean),
      totp: login.totp || '',
      notes: it.notes || '',
      fields,
      passkeys,
      folder: folders.get(it.folderId) || collections.get(it.collectionIds?.[0]) || '',
      favorite: !!it.favorite,
    }));
  }
  return { format: 'bitwarden-json', label: 'Bitwarden (JSON)', items };
}

// ---------------------------------------------------------------- KeePass XML

function pemToB64u(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return b64uEncode(b64uDecode(body));
}

function keepassTotp(strings) {
  if (strings.otp) return strings.otp;
  const secret = strings['TimeOtp-Secret-Base32'];
  if (!secret) return '';
  const p = new URLSearchParams({ secret: secret.replace(/\s/g, '') });
  if (strings['TimeOtp-Length']) p.set('digits', strings['TimeOtp-Length']);
  if (strings['TimeOtp-Period']) p.set('period', strings['TimeOtp-Period']);
  if (strings['TimeOtp-Algorithm']) p.set('algorithm', strings['TimeOtp-Algorithm'].replace('HMAC-', ''));
  return `otpauth://totp/${encodeURIComponent(strings.Title || 'KeePass')}?${p}`;
}

const KEEPASS_STANDARD = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes', 'otp', 'TimeOtp-Secret-Base32', 'TimeOtp-Length',
  'TimeOtp-Period', 'TimeOtp-Algorithm', 'KPEX_PASSKEY_CREDENTIAL_ID', 'KPEX_PASSKEY_PRIVATE_KEY_PEM', 'KPEX_PASSKEY_RELYING_PARTY',
  'KPEX_PASSKEY_USERNAME', 'KPEX_PASSKEY_USER_HANDLE', 'KPEX_PASSKEY_FLAG_BE', 'KPEX_PASSKEY_FLAG_BS']);

function fromKeepassXml(text) {
  const doc = parseXml(text);
  const file = child(doc, 'KeePassFile');
  if (!file) throw new Error(t('XML-Format nicht erkannt (KeePass-XML erwartet)'));
  const recycleBin = textOf(child(file, 'Meta'), 'RecycleBinUUID');
  const items = [];
  const walk = (group, path) => {
    if (recycleBin && textOf(group, 'UUID') === recycleBin) return;
    for (const entry of children(group, 'Entry')) {
      const strings = {};
      const protectedKeys = new Set();
      for (const s of children(entry, 'String')) {
        const key = textOf(s, 'Key');
        const value = child(s, 'Value');
        strings[key] = value?.text ?? '';
        if (value?.attrs.Protected === 'True') protectedKeys.add(key);
      }
      const urls = [strings.URL, ...Object.entries(strings).filter(([k]) => /^(KP2A_URL|URL_)/.test(k)).map(([, v]) => v)].filter(Boolean);
      const passkeys = strings.KPEX_PASSKEY_PRIVATE_KEY_PEM ? [{
        credentialId: b64uEncode(b64uDecode(strings.KPEX_PASSKEY_CREDENTIAL_ID || '')),
        rpId: strings.KPEX_PASSKEY_RELYING_PARTY || '',
        userName: strings.KPEX_PASSKEY_USERNAME || '',
        userHandle: strings.KPEX_PASSKEY_USER_HANDLE ? b64uEncode(b64uDecode(strings.KPEX_PASSKEY_USER_HANDLE)) : '',
        privateKey: pemToB64u(strings.KPEX_PASSKEY_PRIVATE_KEY_PEM),
        algorithm: -7,
      }] : [];
      const fields = Object.entries(strings)
        .filter(([k, v]) => !KEEPASS_STANDARD.has(k) && !/^(KP2A_URL|URL_)/.test(k) && v)
        .map(([k, v]) => ({ name: k, value: v, hidden: protectedKeys.has(k) }));
      const hasLogin = strings.UserName || strings.Password || urls.length || passkeys.length;
      items.push(normalizeItem({
        type: hasLogin ? 'login' : 'note',
        title: strings.Title,
        username: strings.UserName || '',
        password: strings.Password || '',
        urls,
        totp: keepassTotp(strings),
        notes: strings.Notes || '',
        fields,
        passkeys,
        folder: path.join('/'),
      }));
    }
    for (const sub of children(group, 'Group')) walk(sub, [...path, textOf(sub, 'Name')]);
  };
  const rootGroup = child(child(file, 'Root'), 'Group');
  if (rootGroup) walk(rootGroup, []);
  return { format: 'keepass-xml', label: 'KeePass (XML)', items };
}

// ---------------------------------------------------------------- 1Password 1PUX

function onePasswordValue(value) {
  if (!value || typeof value !== 'object') return { text: '', hidden: false };
  const [kind, v] = Object.entries(value)[0] || [];
  if (v == null) return { text: '', hidden: false };
  const hidden = ['concealed', 'creditCardNumber', 'sshKey'].includes(kind);
  if (kind === 'email') return { text: v.email_address || v.emailAddress || '', hidden };
  if (kind === 'sshKey') return { text: v.privateKey || '', hidden };
  if (kind === 'address') return { text: [v.street, v.zip, v.city, v.state, v.country].filter(Boolean).join(', '), hidden };
  if (kind === 'date') return { text: new Date(v * 1000).toISOString().slice(0, 10), hidden };
  if (typeof v === 'object') return { text: JSON.stringify(v), hidden };
  return { text: String(v), hidden, kind };
}

function from1pux(data) {
  const items = [];
  for (const account of data.accounts || []) {
    for (const vault of account.vaults || []) {
      for (const entry of vault.items || []) {
        const it = entry.item || entry;
        if (it.state && it.state !== 'active') continue;
        const d = it.details || {};
        const o = it.overview || {};
        const loginFields = d.loginFields || [];
        const username = loginFields.find((f) => f.designation === 'username')?.value || '';
        const password = loginFields.find((f) => f.designation === 'password')?.value || d.password || '';
        let totp = '';
        const fields = [];
        for (const section of d.sections || []) {
          for (const f of section.fields || []) {
            const v = onePasswordValue(f.value);
            if (v.kind === 'totp' && !totp) {
              totp = v.text;
              continue;
            }
            if (v.text) fields.push({ name: f.title || f.id || section.title || 'Feld', value: v.text, hidden: v.hidden });
          }
        }
        const urls = [...(o.urls || []).map((u) => u.url), o.url].filter(Boolean);
        const isLogin = ['001', '005'].includes(it.categoryUuid) || username || password;
        items.push(normalizeItem({
          type: isLogin ? 'login' : 'note',
          title: o.title,
          username,
          password,
          urls,
          totp,
          notes: d.notesPlain || '',
          fields,
          folder: o.tags?.[0] || vault.attrs?.name || '',
          favorite: (it.favIndex || 0) > 0,
        }));
      }
    }
  }
  return { format: '1password-1pux', label: '1Password (1PUX)', items };
}

// ---------------------------------------------------------------- entry point

/**
 * Parses an export file: { name, bytes } (Uint8Array) or { name, text }.
 * Returns { format, label, items, csv? } – csv = { columns, rows, mapping } for adjusting the column mapping.
 */
export async function parseImport(file) {
  const bytes = file.bytes || utf8(file.text || '');
  if (isZip(bytes)) {
    const files = await readZip(bytes);
    const data = files.get('export.data');
    if (!data) throw new Error(t('ZIP-Datei nicht erkannt (1Password-1PUX erwartet)'));
    return from1pux(JSON.parse(fromUtf8(data)));
  }
  const text = (file.text ?? fromUtf8(bytes)).replace(/^﻿/, '').trim();
  if (!text) throw new Error(t('Die Datei ist leer'));
  if (text.startsWith('<')) return fromKeepassXml(text);
  if (text.startsWith('{') || text.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(t('Die JSON-Datei ist fehlerhaft'));
    }
    if (data.format === 'kvpwsafe' && Array.isArray(data.items)) {
      return { format: 'kvpwsafe-json', label: 'Keevault (JSON)', items: data.items.map((i) => normalizeItem({ ...i, id: '' })) };
    }
    if (Array.isArray(data.accounts)) return from1pux(data);
    if (Array.isArray(data.items) || data.encrypted) return fromBitwardenJson(data);
    throw new Error(t('JSON-Format nicht erkannt'));
  }
  return fromCsv(text);
}

/** Key for duplicate detection: title + username + first website. */
export function duplicateKey(item) {
  const host = (item.hosts?.[0]) || (item.urls?.[0] ? hostFromUrl(item.urls[0]) : '') || '';
  return `${String(item.title).trim().toLowerCase()}\u0000${String(item.username || '').trim().toLowerCase()}\u0000${host}`;
}
