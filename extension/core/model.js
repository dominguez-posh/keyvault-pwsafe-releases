// Vault item model. One item = one Key Vault secret: the JSON document is the secret value, a few
// fields are mirrored into tags so that lists load without reading any secret value.

import { truncate, utf8 } from './util.js';
import { hostFromUrl, normalizeUrl } from './match.js';
import { t } from './i18n.js';
import { isImageDataUrl, ICON_MAX_CHARS } from './image.js';

export const CONTENT_TYPE = 'application/vnd.kvpwsafe.item+json; v=1';
export const ITEM_TAG = 'kvpwsafe';
export const ITEM_PREFIX = 'pws-';
// Key Vault allows 25 KB per secret value; keep headroom.
export const MAX_ITEM_BYTES = 24 * 1024;
export const ITEM_TYPES = { login: 'Login', note: 'Sichere Notiz', card: 'Kreditkarte', certificate: 'Zertifikat', server: 'Asset' };
// Kinds of a device entry (type "server", admin tools): they decide which connections the entry offers – Windows
// RDP, Linux SSH, Azure VM Bastion, VMware vSphere client, Hyper-V Windows Admin Center (both as "management page").
export const DEVICE_KINDS = { windows: 'Windows-Server', linux: 'Linux-Server', azurevm: 'Azure-VM', vmware: 'VMware-VM', hyperv: 'Hyper-V-VM', other: 'Sonstiges Asset' };
// VMs and other devices run Windows (RDP) or Linux (SSH); Windows and Linux servers say it with their kind.
export const deviceOs = (s) => (s.kind === 'linux' ? 'linux' : s.kind === 'windows' ? 'windows' : s.os === 'linux' ? 'linux' : 'windows');
export const defaultPort = (os) => (os === 'linux' ? 22 : 3389);

// Microsoft logo (four squares, 64 px PNG) for the entry templates below.
const MICROSOFT_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAeUlEQVR42u3QwQmAMBBE0a3FiuzIZtKENhWwgclJSAV78X2Y88CrkvT1nke6tv9eT6VrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIqjHTtq3cla4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDpjy2f2ivpvesFLQAAAABJRU5ErkJggg==';
// Sign-in addresses of a Microsoft work account: autofill, the extension's Microsoft sign-in and passkeys
// (rpId login.microsoft.com) find the entry through them.
export const MICROSOFT_LOGIN_URLS = ['https://login.microsoftonline.com', 'https://login.microsoft.com'];
export const isMicrosoftLogin = (item) => item.type === 'login'
  && (!!item.msAdmin || item.urls.some((u) => /(^|.)(microsoftonline|microsoft|office|azure).com$/.test(hostFromUrl(u) || '')));

// Sophos logo (blue rounded square with a white ring, 64 px PNG) for the Sophos login template.
const SOPHOS_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA8klEQVR42u2b0QqAIAxF/dd+rr8seoqoIGm7c+4EvubOKdDp1tqyts6xDT76eCYA/idkYvBvIorAv0soBP8soRj8XUJB+KsEBNSEPyUgAAGxAo4nWoAMtPeRxDYiuFTEyOASERnAXUVkgzeXkBHeVIISPvqdLgK8g3SXMHRwinm8AlMvrXIBURsX83kRkAjeZX7LANRZZIiA8OzNOo6MX980FgQgAAEIyLYCmMbDH4AABCAAAeQCZIOcB3AihABOhbkX4GaIu0Fuh6kPoEKEGqF6VWItev8emFdQKUqtMAJomEAATVO0zdE4SesszdNV2+d3Q9AN7Fe8JZIAAAAASUVORK5CYII=';
// Sophos login: a login flavour (own 'New' entry, logo, portal buttons). With MFA (a TOTP set) the Sophos portals
// want the password and the one-time code typed together into the password field – see cs:fill (browser only).
export const isSophosLogin = (item) => item.type === 'login' && !!item.sophos;

/**
 * #487: the admin flags (Microsoft admin account, Sophos login) change only in the desktop's admin mode. Outside it a
 * save keeps the stored values (a new entry gets none); a Sophos login keeps its portals when none come along.
 */
export function keepAdminFlags(next, stored) {
  const login = next?.type === 'login';
  const sophos = login && !!stored?.sophos;
  const portals = sophos ? (next.portals?.length ? next.portals : stored.portals || []) : [];
  return { ...next, msAdmin: login && !!stored?.msAdmin, sophos, portals };
}

/**
 * #487 (Lucas, 2026-11-10): the type "Server/Gerät" (RDP, TeamViewer, Bastion) is created and edited only in admin mode.
 * Outside it a stored server keeps its type, connection data and account (favourite, folder, title may change); a new
 * server entry, or another entry turned into one, is refused.
 */
export function keepServer(next, stored) {
  if (!next) return next;
  if (stored?.type === 'server') return { ...next, type: 'server', server: stored.server, username: stored.username, password: stored.password };
  if (next.type === 'server') throw new Error(t('Server und Geräte legst du nur im Admin-Modus an oder änderst sie dort.'));
  return next;
}
/**
 * A login linked to another login (loginLink): user name and password from the linked entry, the one-time code from
 * the entry itself if it has one (e.g. a Sophos portal's own MFA), else from the linked one. Only within the same
 * vault and one level deep. getItem(containerId, id) reads the linked entry. Returns the item with these values and
 * linked = { key, title, username, msAdmin, microsoft, passkey } – or { key, missing: true } when it is not available.
 */
export async function resolveLogin(item, getItem) {
  if (item?.type !== 'login' || !item.loginLink) return item;
  const [containerId, id] = item.loginLink.split('/');
  let source = null;
  if (containerId === item.containerId && id !== item.id) {
    try {
      const l = await getItem(containerId, id);
      if (l?.type === 'login') source = l;
    } catch {
      // deleted or no access: shown as "not available"
    }
  }
  if (!source) return { ...item, username: '', password: '', linked: { key: item.loginLink, missing: true } };
  return {
    ...item,
    username: source.username,
    password: source.password,
    totp: item.totp || source.totp,
    linked: { key: item.loginLink, title: source.title, username: source.username, msAdmin: !!source.msAdmin, microsoft: isMicrosoftLogin(source), passkey: !!source.passkeys?.length },
  };
}

/** Password as the Sophos portal expects it on autofill: password immediately followed by the current TOTP (MFA). */
export const sophosFillPassword = (item, code) => (item.sophos && item.totp && code ? item.password + code : item.password);

/**
 * Sign-in name in FQDN form ("user@contoso.local") for an Active Directory login: from "user", "CONTOSO\\user" or
 * "user@…" plus the entry's field "Domäne (FQDN)" (also the older "Domäne (DNS)"); unchanged without such a field.
 */
export function fqdnUserName(item) {
  const user = String(item?.username || '').trim();
  if (!user || user.includes('@')) return user;
  const field = (item.fields || []).find((f) => /^(Domäne|Domain) \((FQDN|DNS)\)$/i.test(String(f.name || '').trim()) && String(f.value || '').trim());
  if (!field) return user;
  const name = user.includes('\\') ? user.slice(user.lastIndexOf('\\') + 1) : user;
  return `${name}@${String(field.value).trim()}`;
}

/** Login templates of the "New" menu: fields, addresses and logo preset (field names in the user's language). */
export function entryTemplate(name, { msAdmin = false } = {}) {
  if (name === 'microsoft') {
    return {
      type: 'login', title: 'Microsoft', icon: MICROSOFT_LOGO, msAdmin,
      urls: [...MICROSOFT_LOGIN_URLS, 'https://portal.azure.com', 'https://admin.microsoft.com'],
      fields: [{ name: t('Mandanten-ID'), value: '' }, { name: t('Primäre Domäne'), value: '' }],
    };
  }
  if (name === 'sophos') {
    return {
      type: 'login', title: 'Sophos', icon: SOPHOS_LOGO, sophos: true, urls: [],
      portals: [{ label: t('VPN-Portal'), url: '' }, { label: t('Admin-Portal'), url: '' }, { label: t('User-Portal'), url: '' }],
    };
  }
  if (name === 'ad') {
    return {
      type: 'login', title: 'Active Directory', icon: MICROSOFT_LOGO, urls: [],
      fields: [{ name: t('Domäne (NT)'), value: '' }, { name: t('Domäne (FQDN)'), value: '' }, { name: t('Domänencontroller'), value: '' }],
    };
  }
  return null;
}
// Certificate files live inside the item (base64), so they must fit into one secret together with the rest.
export const CERT_MAX_BYTES = 16 * 1024;

export class ItemTooLargeError extends Error {
  constructor(size) {
    super(t('Eintrag ist zu groß ({size} KB, maximal {max} KB). Notizen kürzen.', { size: Math.ceil(size / 1024), max: MAX_ITEM_BYTES / 1024 }));
    this.name = 'ItemTooLargeError';
  }
}

export const newItemId = () => ITEM_PREFIX + crypto.randomUUID().replace(/-/g, '');

// The vault's own secrets share the prefix with the entries (#484): never an entry ID, whatever path asks.
const INTERNAL_SECRETS = new Set(['pws-container', 'pws-keyring', 'pws-policy', 'pws-folders', 'pws-logo', 'pws-index']);
export const isInternalSecretName = (id) => INTERNAL_SECRETS.has(id) || /^pws-index-\d+$/.test(id);

/** Entry ID as the entry API takes it: the entry format (prefix, Key Vault name characters), no internal secret. → id */
export function requireItemId(id) {
  if (typeof id !== 'string' || !id.startsWith(ITEM_PREFIX) || !/^[0-9A-Za-z-]{5,127}$/.test(id) || isInternalSecretName(id.toLowerCase())) {
    throw new Error(t('Ungültige Eintrags-ID'));
  }
  return id;
}

/**
 * Additional fields: { name, value, hidden, type }. type decides input and display; a file keeps its content as
 * base64 in value plus fileName/mime/size. Files are small on purpose: the whole entry has to fit into one Key Vault
 * secret (protected vaults encrypt it, which adds about a third) – FIELD_FILE_MAX_BYTES per file.
 */
export const FIELD_TYPES = {
  text: 'Text', hidden: 'Verborgen', multiline: 'Mehrzeilig', url: 'Adresse (URL)', email: 'E-Mail', phone: 'Telefon',
  number: 'Zahl / PIN', date: 'Datum', totp: 'Einmalcode (TOTP)', file: 'Datei',
};
export const FIELD_FILE_MAX_BYTES = 8 * 1024;
export function normalizeField(f) {
  const type = Object.hasOwn(FIELD_TYPES, f.type) ? f.type : f.hidden ? 'hidden' : 'text';
  const out = { name: str(f.name), value: str(f.value), hidden: type === 'hidden' || (!!f.hidden && type !== 'file'), type };
  if (type === 'file') {
    // Valid base64 within the size limit, otherwise the attachment is dropped (never a broken entry).
    const size = Math.floor((out.value.length * 3) / 4);
    if (!/^[A-Za-z0-9+/]*=*$/.test(out.value) || size > FIELD_FILE_MAX_BYTES + 3) return null;
    out.fileName = str(f.fileName).slice(0, 120) || 'datei.txt';
    out.mime = /^[\w.+-]+\/[\w.+-]+$/.test(str(f.mime)) ? str(f.mime) : 'application/octet-stream';
    out.size = Number(f.size) || size;
  }
  return out;
}

export function isItemSecret(secret) {
  return secret?.tags?.[ITEM_TAG] === 'item' || String(secret?.contentType || '').startsWith('application/vnd.kvpwsafe.item+json');
}

const str = (v) => (v == null ? '' : String(v));

function normalizePasskey(p) {
  return {
    credentialId: str(p.credentialId),
    rpId: str(p.rpId).toLowerCase(),
    rpName: str(p.rpName),
    userHandle: str(p.userHandle),
    userName: str(p.userName),
    userDisplayName: str(p.userDisplayName),
    algorithm: Number(p.algorithm ?? -7),
    privateKey: str(p.privateKey),
    publicKey: str(p.publicKey),
    signCount: Number(p.signCount) || 0,
    discoverable: p.discoverable !== false,
    created: str(p.created) || new Date().toISOString(),
  };
}

/** "Kunden / Contoso/" → "Kunden/Contoso" (folders are paths separated by "/"). */
export function normalizeFolder(path) {
  return String(path || '').split('/').map((p) => p.trim()).filter(Boolean).join('/');
}

// At most three folder levels ("Kunden/Contoso/VPN") – deeper structures get confusing.
export const MAX_FOLDER_DEPTH = 3;
export const folderDepth = (path) => (normalizeFolder(path) ? normalizeFolder(path).split('/').length : 0);
/** Imports: deeper levels go into the name of the last allowed one ("A/B/C/D" → "A/B/C – D", #327) – nothing merges. */
export const limitFolderDepth = (path) => {
  const parts = normalizeFolder(path).split('/').filter(Boolean);
  return parts.length <= MAX_FOLDER_DEPTH ? parts.join('/') : [...parts.slice(0, MAX_FOLDER_DEPTH - 1), parts.slice(MAX_FOLDER_DEPTH - 1).join(' – ')].join('/');
};

export class FolderTooDeepError extends Error {
  constructor(path) {
    super(t('Höchstens {max} Ordnerebenen sind möglich („{path}“ hat {depth}).', { max: MAX_FOLDER_DEPTH, path, depth: folderDepth(path) }));
    this.name = 'FolderTooDeepError';
  }
}

export function requireFolderDepth(path) {
  if (folderDepth(path) > MAX_FOLDER_DEPTH) throw new FolderTooDeepError(normalizeFolder(path));
}

export function normalizeItem(input = {}) {
  const type = ITEM_TYPES[input.type] ? input.type : 'login';
  const urls = (Array.isArray(input.urls) ? input.urls : str(input.urls).split(/\r?\n/))
    .map(normalizeUrl)
    .filter(Boolean);
  return {
    id: input.id || '',
    type,
    title: str(input.title).trim() || (urls[0] ? hostFromUrl(urls[0]) || '' : '') || t('Ohne Titel'),
    username: str(input.username),
    password: str(input.password),
    urls: [...new Set(urls)],
    totp: str(input.totp).trim(),
    notes: str(input.notes),
    fields: (input.fields || [])
      .filter((f) => f && (f.name || f.value))
      .map(normalizeField)
      .filter(Boolean),
    passkeys: (input.passkeys || []).map(normalizePasskey),
    folder: normalizeFolder(input.folder),
    favorite: !!input.favorite,
    // Expiry date (YYYY-MM-DD) for certificates, service accounts, customer access – reminders in the app.
    expires: /^\d{4}-\d{2}-\d{2}$/.test(str(input.expires).trim()) ? str(input.expires).trim() : '',
    passwordChanged: str(input.passwordChanged),
    icon: isImageDataUrl(input.icon, ICON_MAX_CHARS) ? input.icon : '',
    card: normalizeCard(input.card),
    cert: normalizeCert(input.cert),
    server: normalizeServer(input.server),
    // Login used for Microsoft admin centers and Bastion (admin tools pick these accounts).
    msAdmin: !!input.msAdmin,
    // Sophos login flavour and its named portals (VPN/Admin/User portal, each a free URL) – see isSophosLogin.
    sophos: !!input.sophos,
    // Sign-in from another login of the same vault (domain login, Microsoft login): user name and password are read
    // from there when used – see resolveLogin. Only a reference is stored, never a copy of the secret.
    loginLink: input.type === 'login' || input.type == null ? linkKey(input.loginLink) : '',
    portals: normalizePortals(input.portals),
    created: input.created || '',
    createdBy: input.createdBy || '',
    // "Nur für mich" (#476, core/private.js): Entra object ID of the owner and their name; '' = visible to everyone.
    privateOwner: str(input.privateOwner).trim().slice(0, 64),
    privateOwnerName: input.privateOwner ? str(input.privateOwnerName).trim().slice(0, 128) : '',
  };
}

/** Named portals of a Sophos login: up to 12 rows, each { label, url }; rows without a URL are dropped. */
function normalizePortals(list) {
  return (Array.isArray(list) ? list : []).map((p) => ({ label: str(p?.label).trim().slice(0, 80), url: normalizeUrl(str(p?.url)) || '' }))
    .filter((p) => p.url).slice(0, 12);
}

function normalizeCard(c = {}) {
  return {
    holder: str(c?.holder).trim(),
    number: str(c?.number).replace(/\D/g, ''),
    expiry: str(c?.expiry).trim(),
    cvc: str(c?.cvc).trim(),
    pin: str(c?.pin).trim(),
  };
}

function normalizeCert(c = {}) {
  const data = /^[A-Za-z0-9+/=]*$/.test(str(c?.data)) ? str(c?.data) : '';
  return { fileName: str(c?.fileName).trim(), data, size: data ? Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : 0 };
}

/** Entry key "containerId/itemId" of a linked entry, or ''. */
const linkKey = (v) => (/^[^/\s]+\/[^/\s]+$/.test(str(v).trim()) ? str(v).trim() : '');

/**
 * Server / resource: where it is and how to connect. Credentials are either the entry's own user name and password
 * or a link to another entry (only its key is stored, never a copy of the secret).
 *   rdp: host + port, account = rdpLink or own; teamviewer: ID, password = tvLink or tvPassword;
 *   bastion: link (portal or shareable link), Microsoft sign-in = bastionLoginLink, VM account = bastionVmLink or RDP's.
 */
function normalizeServer(s = {}) {
  const port = Number.parseInt(s?.port, 10);
  // "server" (0.9.2) was the RDP server – now "windows".
  const kind = Object.hasOwn(DEVICE_KINDS, s?.kind) ? s.kind : 'windows';
  const os = deviceOs({ kind, os: s?.os });
  return {
    kind,
    os,
    host: str(s?.host).trim(),
    port: port > 0 && port < 65536 ? port : defaultPort(os),
    // Management page in the browser: vSphere client / vCenter, Windows Admin Center, the device's web interface.
    mgmtUrl: normalizeUrl(str(s?.mgmtUrl)) || '',
    rdpLink: linkKey(s?.rdpLink),
    tvId: str(s?.tvId).replace(/\s+/g, ''),
    tvPassword: str(s?.tvPassword),
    tvLink: linkKey(s?.tvLink),
    bastionUrl: normalizeUrl(str(s?.bastionUrl)) || '',
    bastionLoginLink: linkKey(s?.bastionLoginLink),
    bastionVmLink: linkKey(s?.bastionVmLink),
    // Microsoft tenant of the VM (domain like contoso.com or the tenant ID): the portal opens in that directory (#30).
    bastionTenant: normalizeTenant(s?.bastionTenant),
  };
}

/** "contoso.com", "contoso.onmicrosoft.com" or a tenant ID (GUID) – anything else is dropped. */
export function normalizeTenant(value) {
  const v = str(value).trim().replace(/^@/, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : '';
}

/**
 * Bastion link in the VM's tenant: Azure portal links get "#@tenant" (replacing another one), so the portal signs in
 * to that directory; shareable links (bastion.azure.com) stay as they are.
 */
export function bastionUrlInTenant(url, tenant) {
  const t = normalizeTenant(tenant);
  if (!t || !/^https:\/\/portal\.azure\.com\//i.test(url || '')) return url || '';
  const u = String(url);
  const hash = u.indexOf('#');
  if (hash < 0) return `${u.replace(/\/?$/, '/')}#@${t}`;
  const frag = u.slice(hash + 1).replace(/^@[^/]*/, '');
  return `${u.slice(0, hash)}#@${t}${frag.startsWith('/') || !frag ? frag : `/${frag}`}`;
}

/** Connection methods a server entry offers (also mirrored into its tags for the server list). */
export function serverMethods(item) {
  const s = item.server || {};
  return [s.host ? (deviceOs(s) === 'linux' ? 'ssh' : 'rdp') : '', s.tvId ? 'teamviewer' : '', s.bastionUrl ? 'bastion' : '', s.mgmtUrl ? 'mgmt' : ''].filter(Boolean);
}

/** Card number in groups of four for display ("4111 1111 1111 1111"). */
export const formatCardNumber = (number) => str(number).replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

/** "•••• 1234" – the only part of a card number that appears in lists. */
export const cardLast4 = (number) => {
  const digits = str(number).replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '';
};

export const itemUrls = (item) => [...(item.urls || []), ...((item.portals || []).map((p) => p.url))];

export function itemHosts(item) {
  return [...new Set(itemUrls(item).map(hostFromUrl).filter(Boolean))];
}

export function itemRpIds(item) {
  return [...new Set((item.passkeys || []).map((p) => p.rpId).filter(Boolean))];
}

/**
 * Date of the last real password change (#500), whoever saves (window, extension, MCP, restore of a version): a new
 * password stamps `now`, an unchanged one keeps the stored date. Edits of the title or notes never count. `stored` is
 * the entry as saved ({ password, passwordChanged }), null for a new entry; a password of null means it could not be
 * read. A date sent along in `input` is never taken over (review 0.9.33: it would make an old password look fresh),
 * and a stored date in the future or before 2000 is dropped.
 */
export function stampPasswordChange(input, stored, now = new Date().toISOString()) {
  const password = String(input?.password ?? '');
  if (!stored) return password ? now : '';
  if (stored.password != null && password !== String(stored.password)) return now;
  return plausibleChange(stored.passwordChanged, now);
}

const EARLIEST_CHANGE = Date.parse('2000-01-01T00:00:00Z');
const CLOCK_SKEW = 5 * 60_000;

function plausibleChange(value, now) {
  const at = Date.parse(String(value || ''));
  if (!Number.isFinite(at) || at < EARLIEST_CHANGE || at > Date.parse(now) + CLOCK_SKEW) return '';
  return new Date(at).toISOString();
}

/** Serializes an item into the secret value, content type and tags. */
/** existing: the entry is already stored – the actor is then never written as its creator (#482). */
export function serializeItem(input, actor = '', { existing = false } = {}) {
  const item = normalizeItem(input);
  const now = new Date().toISOString();
  const doc = {
    v: 1,
    type: item.type,
    title: item.title,
    username: item.username,
    password: item.password,
    urls: item.urls,
    totp: item.totp,
    notes: item.notes,
    fields: item.fields,
    passkeys: item.passkeys,
    card: item.type === 'card' ? item.card : undefined,
    cert: item.type === 'certificate' && item.cert.data ? { fileName: item.cert.fileName, data: item.cert.data } : undefined,
    server: item.type === 'server' ? item.server : undefined,
    msAdmin: item.type === 'login' && item.msAdmin ? true : undefined,
    sophos: item.type === 'login' && item.sophos ? true : undefined,
    portals: item.type === 'login' && item.portals.length ? item.portals : undefined,
    loginLink: item.type === 'login' && item.loginLink ? item.loginLink : undefined,
    folder: item.folder,
    favorite: item.favorite,
    expires: item.expires || undefined,
    passwordChanged: item.passwordChanged || undefined,
    icon: item.icon || undefined,
    privateOwner: item.privateOwner || undefined,
    privateOwnerName: item.privateOwner && item.privateOwnerName ? item.privateOwnerName : undefined,
    created: item.created || now,
    createdBy: existing ? item.createdBy || undefined : item.createdBy || actor,
    updated: now,
    updatedBy: actor,
  };
  const value = JSON.stringify(doc);
  const size = utf8(value).length;
  if (size > MAX_ITEM_BYTES) throw new ItemTooLargeError(size);

  const tags = {
    [ITEM_TAG]: 'item',
    t: item.type,
    n: truncate(item.title, 256),
  };
  // Lists show the user name – for cards the last four digits, for certificates the file name.
  const sub = item.type === 'card' ? cardLast4(item.card.number) || item.card.holder : item.type === 'certificate' ? item.cert.fileName
    : item.type === 'server' ? item.server.host || (item.server.tvId && `TeamViewer ${item.server.tvId}`) : item.username;
  if (sub) tags.u = truncate(sub, 256);
  const hosts = itemHosts(item);
  if (hosts.length) tags.h = truncate(hosts.join(' '), 256);
  const rpIds = itemRpIds(item);
  if (rpIds.length) tags.rp = truncate(rpIds.join(' '), 256);
  if (item.folder) tags.f = truncate(item.folder, 256);
  if (item.favorite) tags.fav = '1';
  if (item.totp) tags.otp = '1';
  if (item.icon) tags.ic = '1';
  if (item.expires) tags.exp = item.expires;
  if (item.type === 'login' && item.msAdmin) tags.adm = '1';
  if (item.type === 'login' && item.sophos) tags.sop = '1';
  if (item.type === 'login' && item.loginLink) tags.ln = '1';
  if (item.type === 'server' && serverMethods(item).length) tags.sv = serverMethods(item).join(' ');
  // One tag "objectId name" (Key Vault allows 15 tags per secret); sealed in protected vaults like the title.
  if (item.privateOwner) tags.po = truncate([item.privateOwner, item.privateOwnerName].filter(Boolean).join(' '), 150);
  // #500 review: when the password last changed, as metadata – the compliance view reads it from the listing instead of
  // every secret value (each read counts in the read alert of #486). Seconds; "c…" = from the creation. Left out when
  // the 15 tags of Key Vault are used up (the compliance view then estimates from the versions).
  const changedAt = Date.parse(doc.passwordChanged || '') || Date.parse(doc.created || '');
  if (item.password && changedAt && Object.keys(tags).length < 15) tags.pc = `${doc.passwordChanged ? '' : 'c'}${Math.floor(changedAt / 1000)}`;
  return { value, contentType: CONTENT_TYPE, tags, doc };
}

/** The pc tag (see serializeItem) → { at: ms, source: 'password'|'created' } or null. */
export function passwordChangedTag(tags) {
  const m = /^(c?)(\d{9,11})$/.exec(String(tags?.pc || ''));
  return m ? { at: Number(m[2]) * 1000, source: m[1] ? 'created' : 'password' } : null;
}

const split = (v) => (v ? String(v).split(' ').filter(Boolean) : []);

/** Builds the list entry from a secret list item (tags only, no value). */
export function summaryFromSecret(secret, containerId) {
  const t = secret.tags || {};
  return {
    key: `${containerId}/${secret.name}`,
    id: secret.name,
    containerId,
    type: t.t || 'login',
    title: t.n || secret.name,
    username: t.u || '',
    hosts: split(t.h),
    rpIds: split(t.rp),
    folder: t.f || '',
    favorite: t.fav === '1',
    hasTotp: t.otp === '1',
    hasIcon: t.ic === '1',
    expires: /^\d{4}-\d{2}-\d{2}$/.test(t.exp || '') ? t.exp : '',
    msAdmin: t.adm === '1',
    sophos: t.sop === '1',
    loginLinked: t.ln === '1',
    methods: split(t.sv),
    privateOwner: t.po ? String(t.po).split(' ')[0] : '',
    privateOwnerName: t.po ? String(t.po).split(' ').slice(1).join(' ') : '',
    updated: (secret.attributes?.updated || 0) * 1000,
  };
}

/** Parses a full secret bundle into an item. */
export function parseItem(bundle, containerId) {
  let doc;
  try {
    doc = JSON.parse(bundle.value);
  } catch {
    // A plain secret without our format: show it as a note so nothing is lost.
    doc = { type: 'note', title: bundle.name, notes: String(bundle.value ?? '') };
  }
  const item = normalizeItem(doc);
  return {
    ...item,
    id: bundle.name,
    key: `${containerId}/${bundle.name}`,
    containerId,
    version: bundle.version,
    updated: doc.updated || new Date((bundle.attributes?.updated || 0) * 1000).toISOString(),
    updatedBy: doc.updatedBy || '',
  };
}

export function summaryFromItem(item, containerId) {
  const { tags } = serializeItem(item);
  // Local containers: the icon comes along directly (Key Vault lists only tags, icons are loaded on demand).
  return { ...summaryFromSecret({ name: item.id, tags, attributes: { updated: Date.now() / 1000 } }, containerId), icon: normalizeItem(item).icon };
}
