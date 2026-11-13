// #480: vault settings of a Key Vault container – field "settings" of the metadata secret pws-container (session-meta.js):
//   { v: 1, look: { color, icon, description, folderOrder }, contact: { name, email },
//     rules: { generator, required, maxAgeMonths, templates }, protect: { pinCopy, pinExport, noExport, private } }
// Only a Verwalter changes them in Keevault, but anyone with secret write access in Azure can write the secret directly:
// every value is validated and cleaned on reading, anything unknown or invalid is ignored (the default applies).
// Unknown groups and unknown fields inside a group stay in the secret when Keevault writes (later versions add some).
// The protection defaults are app rules enforced by Keevault (desktop/main/vault-rules.js), not a security boundary
// against someone who reads the vault in Azure directly (docs/ENTSCHEIDUNGEN.md).

import { t } from './i18n.js';
import { ITEM_TYPES, normalizeFolder } from './model.js';
import { FOLDER_ICONS } from './folder-icons.js';
import { cleanText } from './session-meta.js';

export const SETTINGS_VERSION = 1;

// Group 1 – appearance. Colours are names; each maps to a token of the product styles (app.css, --vault-<name>).
export const VAULT_COLORS = ['blue', 'violet', 'green', 'grey'];
export const VAULT_COLOR_LABELS = { blue: 'Blau', violet: 'Violett', green: 'Grün', grey: 'Grau' };
export const VAULT_ICONS = ['vault', ...FOLDER_ICONS.filter((i) => i !== 'folder')];
export const DESCRIPTION_MAX = 200;
const FOLDER_ORDER_MAX = 200;

// Group 2 – contact person: a name and a mail address or UPN, shown as text (a link only as mailto:).
const CONTACT_NAME_MAX = 100;
const EMAIL_MAX = 254;
// No ? & = % (review 0.9.33): they would let the address carry mailto: header fields such as bcc, subject or body.
const EMAIL = /^[A-Za-z0-9.!#$*+/^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Group 3 – rules and templates.
export const GENERATOR_MIN = 12; // no weaker default than this, whoever wrote the secret
export const GENERATOR_MAX = 64; // the generator's length slider ends there
const GENERATOR_CLASSES = ['lower', 'upper', 'digits', 'symbols'];
export const MAX_AGE_MONTHS = 120;
/** Fields that can be required per entry type (label in REQUIRED_LABELS). */
export const REQUIRED_FIELDS = {
  login: ['username', 'password', 'urls', 'totp', 'notes', 'folder', 'expires'],
  note: ['notes', 'folder', 'expires'],
  card: ['card.holder', 'card.number', 'card.expiry', 'notes', 'folder'],
  certificate: ['cert', 'password', 'expires', 'notes', 'folder'],
  server: ['server.host', 'notes', 'folder'],
};
export const REQUIRED_LABELS = {
  username: 'Benutzername', password: 'Passwort', urls: 'Website', totp: 'Einmalcode (TOTP)', notes: 'Notizen', folder: 'Ordner',
  expires: 'Ablaufdatum', 'card.holder': 'Karteninhaber', 'card.number': 'Kartennummer', 'card.expiry': 'Gültig bis',
  cert: 'Zertifikatsdatei', 'server.host': 'Host',
};
export const TEMPLATES_MAX = 20;
const TEMPLATE_FIELDS_MAX = 30;
const TEMPLATE_URLS_MAX = 10;
// Field types whose value is never kept in a template (#480 "keine Secrets in Vorlagen"); file fields are dropped whole.
const SECRET_FIELD_TYPES = new Set('hidden totp'.split(' '));
const TEMPLATE_FIELD_TYPES = new Set(['text', 'hidden', 'multiline', 'url', 'email', 'phone', 'number', 'date', 'totp']);


const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const text = (v, max) => cleanText(v, max) || '';
const intIn = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

/** A mail address or UPN as shown and used for mailto:, or '' when it is not one. */
export function cleanEmail(value) {
  const v = cleanText(value, EMAIL_MAX + 1) || '';
  return v.length <= EMAIL_MAX && EMAIL.test(v) ? v : '';
}

/** mailto: link to a clean address only, each part encoded – no header field (bcc, subject, body) can get in. */
export function mailtoOf(value) {
  const email = cleanEmail(value);
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}`;
}

/** Only http(s) addresses in templates (a template is offered to everyone in the vault). */
function cleanUrl(value) {
  const v = cleanText(value, 2000);
  if (!v) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname ? u.href : '';
  } catch {
    return '';
  }
}

export function cleanLook(raw) {
  const r = obj(raw) || {};
  const order = Array.isArray(r.folderOrder) ? r.folderOrder : [];
  return {
    color: VAULT_COLORS.includes(r.color) ? r.color : '',
    icon: VAULT_ICONS.includes(r.icon) ? r.icon : '',
    description: text(r.description, DESCRIPTION_MAX),
    folderOrder: [...new Set(order.filter((f) => typeof f === 'string').map((f) => normalizeFolder(text(f, 300))).filter(Boolean))].slice(0, FOLDER_ORDER_MAX),
  };
}

export function cleanContact(raw) {
  const r = obj(raw) || {};
  return { name: text(r.name, CONTACT_NAME_MAX), email: cleanEmail(r.email) };
}

/** Generator defaults of the vault, or null (the personal defaults apply). */
export function cleanGenerator(raw) {
  const r = obj(raw);
  if (!r) return null;
  const length = intIn(r.length, GENERATOR_MIN, GENERATOR_MAX);
  const classes = Object.fromEntries(GENERATOR_CLASSES.map((k) => [k, r[k] === true]));
  if (!length || !GENERATOR_CLASSES.some((k) => classes[k])) return null;
  return { length, ...classes };
}

export function cleanRequired(raw) {
  const r = obj(raw) || {};
  const out = {};
  for (const [type, allowed] of Object.entries(REQUIRED_FIELDS)) {
    const list = Array.isArray(r[type]) ? [...new Set(r[type].filter((f) => allowed.includes(f)))] : [];
    if (list.length) out[type] = list;
  }
  return out;
}

/** One shared template: name, entry type, preset values; no secret value survives (password, TOTP, hidden fields, files, card data). */
export function cleanTemplate(raw) {
  const r = obj(raw);
  const name = r && text(r.name, 80);
  if (!name || !Object.hasOwn(ITEM_TYPES, r.type)) return null;
  const fields = (Array.isArray(r.fields) ? r.fields : []).map(obj).filter((f) => f && f.type !== 'file') // files never
    .map((f) => {
      const type = TEMPLATE_FIELD_TYPES.has(f.type) ? f.type : f.hidden ? 'hidden' : 'text';
      const fieldName = text(f.name, 80);
      return fieldName ? { name: fieldName, type, value: SECRET_FIELD_TYPES.has(type) ? '' : text(f.value, 1000), hidden: type === 'hidden' } : null;
    })
    .filter(Boolean).slice(0, TEMPLATE_FIELDS_MAX);
  return {
    id: /^[A-Za-z0-9-]{1,40}$/.test(String(r.id || '')) ? r.id : '',
    name,
    type: r.type,
    title: text(r.title, 200),
    username: r.type === 'login' || r.type === 'server' ? text(r.username, 200) : '',
    urls: (Array.isArray(r.urls) ? r.urls : []).map(cleanUrl).filter(Boolean).slice(0, TEMPLATE_URLS_MAX),
    notes: text(r.notes, 2000),
    folder: normalizeFolder(text(r.folder, 300)),
    fields,
  };
}

export function cleanRules(raw) {
  const r = obj(raw) || {};
  const templates = (Array.isArray(r.templates) ? r.templates : []).map(cleanTemplate).filter(Boolean).slice(0, TEMPLATES_MAX);
  templates.forEach((tpl, i) => { if (!tpl.id || templates.findIndex((x) => x.id === tpl.id) !== i) tpl.id = `t${i + 1}`; });
  return {
    generator: cleanGenerator(r.generator),
    required: cleanRequired(r.required),
    maxAgeMonths: intIn(r.maxAgeMonths, 1, MAX_AGE_MONTHS) || 0,
    templates,
  };
}

export function cleanProtect(raw) {
  const r = obj(raw) || {};
  return {
    pinCopy: r.pinCopy === true,
    pinExport: r.pinExport === true,
    noExport: r.noExport === true,
    private: r.private === 'forbid' ? 'forbid' : 'allow',
  };
}

const GROUPS = { look: cleanLook, contact: cleanContact, rules: cleanRules, protect: cleanProtect };

/** The vault settings as Keevault uses them: every group present, every value valid (defaults for the rest). */
export function cleanVaultSettings(raw) {
  const r = obj(raw) || {};
  return Object.fromEntries(Object.entries(GROUPS).map(([group, clean]) => [group, clean(r[group])]));
}

export const defaultVaultSettings = () => cleanVaultSettings(null);

/**
 * The stored settings object with the groups of patch replaced by their cleaned values. Unknown groups and unknown fields
 * inside a changed group stay (a later version may have written them).
 */
export function mergeSettings(stored, patch) {
  const base = obj(stored) || {};
  const out = { ...base, v: Math.max(SETTINGS_VERSION, Number.isInteger(base.v) ? base.v : 0) };
  for (const [group, clean] of Object.entries(GROUPS)) {
    if (!obj(patch) || !(group in patch)) continue;
    out[group] = { ...(obj(base[group]) || {}), ...clean(patch[group]) };
  }
  return out;
}

/** Only a Verwalter (role assignments) or an admin of a Key Vault changes its settings. */
export const canEditSettings = (c) => c?.kind === 'keyvault' && !!(c.access?.manage || c.access?.admin);

const STORE_KEY = 'vaultSettings';
const CACHE_MS = 60_000;

/** The last settings read per vault (cleaned) → { [containerId]: settings }; shown while a vault can't be read (contact). */
export async function storedVaultSettings(session) {
  const map = (await session.store.get(STORE_KEY)) || {};
  return Object.fromEntries(Object.entries(map).map(([id, s]) => [id, cleanVaultSettings(s)]));
}

/** Keeps the settings just read from the vault (rememberMeta in session-meta.js); nothing stored when there are none. */
export async function rememberSettings(session, containerId, raw) {
  const map = (await session.store.get(STORE_KEY)) || {};
  const next = obj(raw) ? cleanVaultSettings(raw) : null;
  if (JSON.stringify(map[containerId] || null) === JSON.stringify(next)) return;
  if (next) map[containerId] = next;
  else delete map[containerId];
  await session.store.set(STORE_KEY, map);
}

/**
 * Settings of a vault (cleaned). Key Vault: from the metadata secret, cached for a minute; when the secret can't be read,
 * the last stored ones. Other vaults: the defaults.
 * strict (#525): for a decision that must not open by failing (export lock) – a read error throws VaultSettingsUnknown
 * instead of answering with stored or default settings, which may be older than a lock set since.
 */
export async function readVaultSettings(session, containerId, { fresh = false, strict = false } = {}) {
  const c = typeof containerId === 'object' ? containerId : await session.container(containerId);
  if (c?.kind !== 'keyvault') return defaultVaultSettings();
  containerId = c.id;
  const cache = (session.vaultSettingsCache ||= new Map());
  const hit = cache.get(containerId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let meta;
  try {
    meta = await session.readContainerMeta(session.kv(c));
  } catch (cause) {
    if (strict) {
      throw Object.assign(new Error(t('Die Vorgaben des Tresors „{name}“ lassen sich gerade nicht lesen (keine Verbindung?). Solange bleiben Export und Verschieben in den persönlichen Tresor gesperrt – bitte erneut versuchen.', { name: c.name || containerId })), { name: 'VaultSettingsUnknown', cause });
    }
    return (await storedVaultSettings(session).catch(() => ({})))[containerId] || defaultVaultSettings();
  }
  await rememberSettings(session, containerId, meta?.settings);
  const value = cleanVaultSettings(meta?.settings);
  cache.set(containerId, { at: Date.now(), value });
  return value;
}

/** Changes groups of a vault's settings – Verwalter only, checked here (main process and session), not only in the window. */
export async function writeVaultSettings(session, containerId, patch) {
  const c = await session.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Nur für Tresore in Azure Key Vault'));
  if (!canEditSettings(c)) throw new Error(t('Du brauchst Verwaltungsrechte auf dem Tresor.'));
  if (!obj(patch) || !Object.keys(GROUPS).some((g) => g in patch)) throw new Error(t('Nichts zu speichern'));
  const email = obj(patch.contact)?.email;
  if (typeof email === 'string' && email.trim() && !cleanEmail(email)) throw new Error(t('Bitte eine gültige E-Mail-Adresse oder einen UPN eingeben'));
  const meta = await session.writeContainerMeta(session.kv(c), (current) => ({ settings: mergeSettings(current.settings, patch) }));
  session.vaultSettingsCache?.delete(containerId);
  await rememberSettings(session, containerId, meta?.settings);
  return cleanVaultSettings(meta?.settings);
}

// ---------------------------------------------------------------- rules applied to entries (group 3)

const has = (v) => (Array.isArray(v) ? v.some((x) => String(x || '').trim()) : !!String(v ?? '').trim());
const fieldValue = (item, key) => key.split('.').reduce((o, k) => o?.[k], item);
const filled = (item, key) => (key === 'cert' ? has(item.cert?.data) : has(fieldValue(item, key)));

/** Required fields the entry leaves empty, as keys of REQUIRED_FIELDS (the vault's rules for its type). */
export function missingRequired(item, settings) {
  const wanted = settings?.rules?.required?.[item?.type] || [];
  return wanted.filter((key) => !filled(item, key));
}

/** Throws with the names of the missing required fields (main process on every save). */
export function requireFields(item, settings) {
  const missing = missingRequired(item, settings);
  if (missing.length) {
    throw Object.assign(new Error(t('Pflichtfelder dieses Tresors fehlen: {fields}', { fields: missing.map((k) => t(REQUIRED_LABELS[k])).join(', ') })), { name: 'RequiredFields' });
  }
}

/**
 * Age of the password in whole months when the vault's notice applies, else 0. changedAt: when the password last changed
 * (the entry's passwordChanged, or the oldest version in the history – metadata only, no older value is read).
 */
export function passwordAgeNotice(changedAt, settings, now = Date.now()) {
  const months = settings?.rules?.maxAgeMonths || 0;
  const at = Date.parse(changedAt || '');
  if (!months || !Number.isFinite(at)) return 0;
  const age = Math.floor((now - at) / (30.44 * 24 * 3600 * 1000));
  return age >= months ? age : 0;
}

/** An entry as a template of the vault: preset values only, no secrets (cleanTemplate drops them). */
export function templateFromItem(item, name) {
  return cleanTemplate({ ...item, name, id: '', fields: item.fields || [] });
}

/** A template as the start of a new entry (the editor's preset values). */
export function itemFromTemplate(tpl) {
  return {
    type: tpl.type, title: tpl.title, username: tpl.username, urls: [...tpl.urls], notes: tpl.notes, folder: tpl.folder,
    fields: tpl.fields.map((f) => ({ ...f })),
  };
}

/** Vault folders in the order the vault sets: those in folderOrder first, in that order, then the rest alphabetically. */
export function orderFolders(paths, settings) {
  const order = settings?.look?.folderOrder || [];
  const rank = (p) => { const i = order.indexOf(p); return i < 0 ? Infinity : i; };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
