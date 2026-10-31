// Entry links for collaboration: "Copy link" gives a web address that works in Teams, mail and chat
// (https://keevault.de/open#v=<vault host>&i=<entry id>). Vault and entry travel only in the fragment, so the
// website never receives them; its page hands them to the installed app as kvpwsafe://item?v=…&i=…. A link grants
// no access: only people with rights on the vault see the entry.

export const ITEM_LINK_BASE = 'https://keevault.de/open';

// Azure Key Vault hosts in the public and sovereign clouds.
const VAULT_HOST = /^[a-z0-9-]{3,24}\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)$/;
const ENTRY_ID = /^pws-[a-z0-9-]{1,120}$/i; // Key Vault secret names: letters, digits, dashes

/** Web link to one entry of a Key Vault container ({ vaultUrl, name }) – null for local file vaults. */
export function buildItemLink(container, id) {
  let host = '';
  try {
    host = new URL(container?.vaultUrl || '').host.toLowerCase();
  } catch {
    return null;
  }
  if (!VAULT_HOST.test(host) || !ENTRY_ID.test(id || '')) return null;
  const p = new URLSearchParams({ v: host, i: id });
  if (container.name) p.set('n', container.name);
  return `${ITEM_LINK_BASE}#${p}`;
}

/** The app link the website hands over (same parameters). */
export function appLinkFromFragment(fragment) {
  const parsed = parseItemLink(`${ITEM_LINK_BASE}#${String(fragment || '').replace(/^#/, '')}`);
  if (!parsed) return null;
  const p = new URLSearchParams({ v: parsed.host, i: parsed.id });
  if (parsed.name) p.set('n', parsed.name);
  return `kvpwsafe://item?${p}`;
}

/** Accepts the web link and kvpwsafe://item?… → { host, vaultUrl, id, name } or null (anything else). */
export function parseItemLink(text) {
  const s = String(text || '').trim();
  const m = s.match(/keevault\.de\/(?:en\/)?open(?:\.html)?#(\S+)/i) || s.match(/kvpwsafe:\/\/item\/?\?(\S+)/i);
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const host = (p.get('v') || '').toLowerCase();
  const id = p.get('i') || '';
  if (!VAULT_HOST.test(host) || !ENTRY_ID.test(id)) return null;
  return { host, vaultUrl: `https://${host}/`, id, name: (p.get('n') || '').slice(0, 120) };
}
