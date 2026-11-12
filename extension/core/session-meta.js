// Metadata secret of a Key Vault container (pws-container): a versioned object { format, v, id, name, … } that
// later versions extend. Writing is read, merge, write, so fields this version does not know stay as they are.
import { t } from './i18n.js';
import { rememberSettings } from './vault-settings.js';

/**
 * Key Vault secrets have no ETag: the write is checked by reading it back; if another writer got in between,
 * the patch is merged onto its state and written again (at most three times).
 */
export async function writeMeta(session, client, patch, { secret, format, type }) {
  let next = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await session.readContainerMeta(client).catch(() => null))
      || { format, v: 1, id: crypto.randomUUID(), created: new Date().toISOString() };
    // #480: a function builds the patch from the state just read (nested values like "settings" merge on every attempt).
    const p = typeof patch === 'function' ? patch(current) : patch;
    next = { ...current, ...p, updated: new Date().toISOString() };
    await client.setSecret(secret, JSON.stringify(next), { contentType: type, tags: { kvpwsafe: 'container' } });
    const back = await session.readContainerMeta(client).catch(() => null);
    if (!back || Object.entries(current).every(([k, v]) => k in p || k === 'updated' || JSON.stringify(back[k]) === JSON.stringify(v))) break;
  }
  return next;
}

/** Longest vault display name taken from the metadata secret. */
export const VAULT_NAME_MAX = 100;

// Control characters (C0, DEL, C1), line/paragraph separators, bidi marks/overrides/isolates, and every invisible
// character: format characters (Cf: zero widths, soft hyphen, word joiner, BOM, Arabic letter mark …), default-ignorables.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Display name from the vault's metadata or ARM tag: anyone with secret (or tag) write access in Azure can set it (the
 * manager rule only holds inside Keevault), so control, bidi and invisible characters go, the text is NFKC-normalised
 * (full-width and compatibility forms fold to their plain letters), the length is capped; empty → null (fallback).
 */
export function cleanVaultName(name) {
  return cleanText(name, VAULT_NAME_MAX);
}

/** cleanVaultName with another length cap (#480: description, contact, templates); empty → null. */
export function cleanText(name, max) {
  if (typeof name !== 'string') return null;
  const clean = [...name.replace(UNSAFE_NAME_CHARS, '').normalize('NFKC').replace(UNSAFE_NAME_CHARS, '')]
    .slice(0, max).join('').trim();
  return clean || null;
}

/** Comparison key of a display name: NFKC, without invisible characters, case-insensitive. */
const nameKey = (name) => (cleanVaultName(String(name ?? '')) || '').toLowerCase();

/** Display names that more than one vault in the list carries (compared after NFKC, case-insensitively). */
export function sharedNames(list) {
  const count = new Map();
  for (const c of list) {
    const key = nameKey(c.name);
    count.set(key, (count.get(key) || 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
}

/** Host of a Key Vault container, shown next to its name when two vaults share a display name. */
export const vaultHostLabel = (c) => {
  try {
    return c.vaultUrl ? new URL(c.vaultUrl).host : null;
  } catch {
    return null;
  }
};

/**
 * Host to show next to a vault's name, or null: always when the name comes from the vault's metadata or its ARM tag
 * (#485) and differs from the Key Vault's own name (anyone with secret or tag write access sets it, so it may pose as
 * another vault, also with look-alike letters NFKC does not fold), and when another vault in the list carries the same
 * name. shared = sharedNames(all).
 */
export function shownVaultHost(c, shared = new Set()) {
  const host = vaultHostLabel(c);
  if (!host) return null;
  const own = nameKey(host.split('.')[0]);
  const shown = nameKey(c.name);
  const fromVault = shown !== own && [c.metaName, c.tagName].some((n) => !!n && nameKey(n) === shown);
  return fromVault || shared.has(nameKey(c.name)) ? host : null;
}

/** Name for a vault choice in a select (save, move, new, import): "Name (host)" when the host has to show. */
export function vaultChoiceLabel(c, shared = new Set()) {
  const host = shownVaultHost(c, shared);
  return host ? `${c.name} (${host})` : c.name;
}

/** { id, name } of the vaults that pass keep, for a select; hosts as vaultChoiceLabel decides over the whole list. */
export function vaultChoices(all, keep = () => true) {
  const shared = sharedNames(all);
  return all.filter(keep).map((c) => ({ id: c.id, name: vaultChoiceLabel(c, shared) }));
}

/** May the user rename this container for everyone? Key Vault: only managers (role assignments) and admins. */
export const canRename = (c) => c.kind !== 'keyvault' || !!(c.access?.manage || c.access?.admin);

/** Shared display name of a Key Vault container: field "name" of the metadata secret. */
export async function renameInVault(session, containerId, name) {
  const c = await session.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Nur für Tresore in Azure Key Vault'));
  if (!canRename(c)) throw new Error(t('Du brauchst Verwaltungsrechte auf dem Tresor.'));
  const clean = cleanVaultName(name);
  if (!clean) throw new Error(t('Bitte einen Namen eingeben'));
  await session.writeContainerMeta(session.kv(c), { name: clean });
  await rememberMetaName(session, containerId, clean);
}

/** After reading the metadata secret: its name (rememberMetaName) and its vault settings (#480). */
export async function rememberMeta(session, containerId, meta) {
  if (meta?.name) await rememberMetaName(session, containerId, String(meta.name));
  await rememberSettings(session, containerId, meta?.settings);
}

/** Remembers the name from the vault's metadata; it takes precedence over the ARM tag and the local name. */
export async function rememberMetaName(session, containerId, raw) {
  const name = cleanVaultName(raw);
  const stored = (await session.store.get('containers')) || [];
  const own = stored.find((x) => x.id === containerId);
  if (!own || !name || (own.metaName === name && own.name === name)) return;
  own.metaName = name;
  own.name = name;
  await session.store.set('containers', stored);
}
