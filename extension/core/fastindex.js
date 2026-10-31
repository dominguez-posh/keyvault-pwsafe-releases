// Fast index of a Key Vault container: the list entries (title, user, hosts, folder, flags – never a secret
// value) stored in a few secrets, "pws-index" (header) plus "pws-index-NN" (shards). Unlocking then reads a
// handful of secrets instead of listing thousands at 25 per page; a secret itself is opened only to view or
// change an entry. The listing still runs in the background to reconcile drift (another client, an old
// version), and every change rewrites the index. Protected containers seal the shards with the container key.

import { sha256, toHex } from './util.js';

export const INDEX_SECRET = 'pws-index';
export const INDEX_TYPE = 'application/vnd.kvpwsafe.index+json; v=1';
export const INDEX_TAG = 'index';
// Key Vault allows 25 KB per secret value; keep room for sealing overhead.
export const SHARD_CHARS = 18_000;

export const shardName = (i) => `${INDEX_SECRET}-${String(i).padStart(2, '0')}`;
export const isIndexSecret = (name) => name === INDEX_SECRET || /^pws-index-\d{2,}$/.test(String(name));

const flags = (s) => (s.favorite ? 1 : 0) | (s.hasTotp ? 2 : 0) | (s.hasIcon ? 4 : 0) | (s.unprotected ? 8 : 0);

/** Summary → compact row (positions matter: see unpack). */
export const pack = (s) => [s.id, s.type, s.title, s.username || '', s.hosts.join(' '), s.rpIds.join(' '), s.folder || '', flags(s), s.expires || '', Math.round((s.updated || 0) / 1000)];

export const unpack = (containerId, a) => ({
  key: `${containerId}/${a[0]}`,
  id: a[0],
  containerId,
  type: a[1] || 'login',
  title: a[2] || a[0],
  username: a[3] || '',
  hosts: a[4] ? String(a[4]).split(' ') : [],
  rpIds: a[5] ? String(a[5]).split(' ') : [],
  folder: a[6] || '',
  favorite: !!(a[7] & 1),
  hasTotp: !!(a[7] & 2),
  hasIcon: !!(a[7] & 4),
  unprotected: !!(a[7] & 8),
  expires: a[8] || '',
  updated: (a[9] || 0) * 1000,
});

async function deflate(text) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(text));
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Summaries → { header, shards }: shards are chunks of the base64 of the deflated JSON, the header names them
 * and carries a hash so a reader notices a half-written index and falls back to the listing.
 */
export async function encodeIndex(summaries, { gen = Date.now(), by = '', isProtected = false } = {}) {
  // Sorted by id: every app produces the same text (and hash) for the same content, whatever its list order.
  const sorted = [...summaries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = toBase64(await deflate(JSON.stringify(sorted.map(pack))));
  const shards = [];
  for (let i = 0; i < text.length; i += SHARD_CHARS) shards.push(text.slice(i, i + SHARD_CHARS));
  if (!shards.length) shards.push('');
  const header = { v: 1, gen, at: new Date(gen).toISOString(), by, count: summaries.length, shards: shards.length, hash: toHex(await sha256(text)), protected: isProtected };
  return { header, shards };
}

/** { header, shards } → summaries; throws when the parts do not fit together (reader then lists instead). */
export async function decodeIndex(containerId, header, shards) {
  if (header?.v !== 1 || !Array.isArray(shards) || shards.length !== header.shards) throw new Error('index: header and shards do not match');
  const text = shards.join('');
  if (toHex(await sha256(text)) !== header.hash) throw new Error('index: hash mismatch');
  const rows = text ? JSON.parse(await inflate(fromBase64(text))) : [];
  return rows.map((a) => unpack(containerId, a));
}

/** Same entries, same state? (what the listing found vs. what the index says) */
export function sameSummaries(a, b) {
  if (a.length !== b.length) return false;
  const key = (s) => JSON.stringify(pack(s));
  const set = new Set(a.map(key));
  return b.every((s) => set.has(key(s)));
}
