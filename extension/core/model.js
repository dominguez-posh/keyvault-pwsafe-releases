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
export const ITEM_TYPES = { login: 'Login', note: 'Sichere Notiz' };

export class ItemTooLargeError extends Error {
  constructor(size) {
    super(t('Eintrag ist zu groß ({size} KB, maximal {max} KB). Notizen kürzen.', { size: Math.ceil(size / 1024), max: MAX_ITEM_BYTES / 1024 }));
    this.name = 'ItemTooLargeError';
  }
}

export const newItemId = () => ITEM_PREFIX + crypto.randomUUID().replace(/-/g, '');

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
      .map((f) => ({ name: str(f.name), value: str(f.value), hidden: !!f.hidden })),
    passkeys: (input.passkeys || []).map(normalizePasskey),
    folder: normalizeFolder(input.folder),
    favorite: !!input.favorite,
    icon: isImageDataUrl(input.icon, ICON_MAX_CHARS) ? input.icon : '',
    created: input.created || '',
    createdBy: input.createdBy || '',
  };
}

export function itemHosts(item) {
  return [...new Set((item.urls || []).map(hostFromUrl).filter(Boolean))];
}

export function itemRpIds(item) {
  return [...new Set((item.passkeys || []).map((p) => p.rpId).filter(Boolean))];
}

/** Serializes an item into the secret value, content type and tags. */
export function serializeItem(input, actor = '') {
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
    folder: item.folder,
    favorite: item.favorite,
    icon: item.icon || undefined,
    created: item.created || now,
    createdBy: item.createdBy || actor,
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
  if (item.username) tags.u = truncate(item.username, 256);
  const hosts = itemHosts(item);
  if (hosts.length) tags.h = truncate(hosts.join(' '), 256);
  const rpIds = itemRpIds(item);
  if (rpIds.length) tags.rp = truncate(rpIds.join(' '), 256);
  if (item.folder) tags.f = truncate(item.folder, 256);
  if (item.favorite) tags.fav = '1';
  if (item.totp) tags.otp = '1';
  if (item.icon) tags.ic = '1';
  return { value, contentType: CONTENT_TYPE, tags, doc };
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
