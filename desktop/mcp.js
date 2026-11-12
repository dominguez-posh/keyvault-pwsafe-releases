// AI agents through the Model Context Protocol (MCP). The agent starts a small stdio process (mcpHostScript, run by
// Keevault.exe with ELECTRON_RUN_AS_NODE=1); it relays to the running app over the same named pipe as the browser.
// The app decides everything:
//   - each agent is approved once (by its MCP client name), the feature is off by default and can be blocked by policy
//   - agents only see the released vaults and folders (scope; default: nothing until the user releases something)
//   - searching shows metadata only (title, user, URL, folder) – never secrets
//   - reading passwords/one-time codes needs a confirmation in the app: only once, for this agent session (max
//     8 hours) or for a chosen time (1 h / 4 h, bound to the agent name, so it also covers agents that start a new
//     process per call); locking the app ends all grants
//   - creating/changing entries needs a confirmation every time; deleting is not possible
//   - every call is logged without secret values

import { generatePassword } from '../extension/core/generator.js';
import { readVaultSettings, requireFields } from '../extension/core/vault-settings.js';
import { getAssertion } from '../extension/core/webauthn.js';
import { totpCode } from '../extension/core/totp.js';
import { normalizeItem, normalizeFolder } from '../extension/core/model.js';
import { normalizeUrl } from '../extension/core/match.js';
import { t } from '../extension/core/i18n.js';

export const SESSION_MS = 8 * 60 * 60_000;
const SEARCH_LIMIT = 50;

const str = { type: 'string' };
export const MCP_TOOLS = [
  {
    name: 'list_vaults',
    title: 'Tresore auflisten',
    description: 'Lists the Keevault vaults (Azure Key Vault or file) the signed-in user can see, with id, name and whether the vault is writable or locked.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_entries',
    title: 'Einträge suchen',
    description: 'Searches entries by title, user name, URL/host or folder. Returns metadata only (no passwords): vaultId, entryId, title, username, hosts, folder, type, hasTotp. Use get_entry for secret values.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text; empty lists all entries (up to the limit).' },
        vaultId: { type: 'string', description: 'Only this vault (id from list_vaults).' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT, description: `Maximum results (default 25, at most ${SEARCH_LIMIT}).` },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_entry',
    title: 'Eintrag mit Passwort lesen',
    description: 'Returns one entry including password, notes and custom fields. The user has to allow reading secrets in the Keevault app (once or for this agent session) – wait for it.',
    inputSchema: { type: 'object', properties: { vaultId: str, entryId: str }, required: ['vaultId', 'entryId'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_totp',
    title: 'Einmalcode abrufen',
    description: 'Returns the current one-time code (TOTP) of an entry and how many seconds it stays valid. Needs the same permission as get_entry.',
    inputSchema: { type: 'object', properties: { vaultId: str, entryId: str }, required: ['vaultId', 'entryId'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_entry',
    title: 'Eintrag anlegen',
    description: 'Creates a login entry. Set generatePassword to let Keevault create a strong password (it is stored, not returned). The user confirms every change in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultId: str,
        title: str,
        username: str,
        url: str,
        password: { type: 'string', description: 'Omit together with generatePassword=true to have one generated.' },
        generatePassword: { type: 'boolean' },
        passwordLength: { type: 'integer', minimum: 8, maximum: 128 },
        notes: str,
        folder: { type: 'string', description: 'Folder path, e.g. "Server/Linux" (at most 3 levels).' },
      },
      required: ['vaultId', 'title'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_entry',
    title: 'Eintrag ändern',
    description: 'Changes fields of an existing entry (only the given ones). generatePassword=true replaces the password with a new strong one (stored, not returned). The user confirms every change in the app. Entries cannot be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultId: str, entryId: str, title: str, username: str, url: str, password: str,
        generatePassword: { type: 'boolean' }, passwordLength: { type: 'integer', minimum: 8, maximum: 128 },
        notes: str, folder: str,
      },
      required: ['vaultId', 'entryId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'sign_in_with_passkey',
    title: 'Mit Passkey anmelden',
    description: 'Signs one WebAuthn sign-in (navigator.credentials.get) with the passkey stored in an entry and returns the PublicKeyCredential as JSON – for an agent that drives a browser itself. The private key never leaves Keevault. Only for the passkey\'s own site (https origin of its rpId), only sign-ins (no registration). Off by default (Keevault settings → AI agents) and the user confirms every single use in the app and, unless switched off there, types the app PIN for it (the agent never does and cannot).',
    inputSchema: {
      type: 'object',
      properties: {
        vaultId: str,
        entryId: str,
        origin: { type: 'string', description: 'https origin of the page asking, e.g. https://github.com – must be the passkey\'s rpId or a subdomain of it.' },
        challenge: { type: 'string', description: 'The challenge of the request (base64url, as the page passed it to navigator.credentials.get).' },
        rpId: { type: 'string', description: 'rpId of the request (default: the passkey\'s).' },
        credentialId: { type: 'string', description: 'Only this credential (base64url), if the entry holds several passkeys for the site.' },
      },
      required: ['vaultId', 'entryId', 'origin', 'challenge'],
    },
    // Signs for the user and may store the passkey's counter: a client must not treat it as harmless reading.
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'request_microsoft_login',
    title: 'Microsoft-Anmeldung anfordern',
    description: 'Asks the user for a Microsoft sign-in: Keevault comes to the front, the user approves and picks the Microsoft account; the tool gets that account\'s user name, password and current one-time code (if any). Nothing is returned without the user\'s choice. Off by default (Keevault settings → AI agents).',
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What the sign-in is for – shown to the user (e.g. "Graph report for contoso.com").' },
        tenant: { type: 'string', description: 'Accounts of this domain are offered first, e.g. contoso.com (optional). The user may still pick an account of another domain – check the returned user name.' },
      },
    },
    // Hands out a sign-in for use elsewhere: not a harmless read either.
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'generate_password',
    title: 'Passwort erzeugen',
    description: 'Generates a strong random password without storing it.',
    inputSchema: { type: 'object', properties: { length: { type: 'integer', minimum: 8, maximum: 128 }, symbols: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
];

const fail = (message) => Object.assign(new Error(message), { name: 'McpError' });

// #370: what an agent sends is shown in the confirmation. Invisible and direction characters could make a value look
// like another one, and very long values could push the buttons away.
// #381: also the other space characters (Zs: no-break, em, ideographic space …); only the plain space stays.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu;
const SHOWN_LENGTH = 200;
export const shown = (value) => {
  const text = String(value ?? '').replace(INVISIBLE, '�');
  return text.length > SHOWN_LENGTH ? `${text.slice(0, SHOWN_LENGTH)}…` : text;
};
/**
 * #381: the rule of a new approval. One that follows a time-limited approval keeps its limit (days, from the
 * settings) instead of becoming unlimited; an older rule without days gets the shortest one (1 day).
 */
export function renewedAgentRule(previous, write, now = Date.now()) {
  const days = Number(previous?.days) > 0 ? Number(previous.days) : (previous?.until ? 1 : 0);
  return { write, days, until: days ? new Date(now + days * 86_400_000).toISOString() : null };
}
const fieldValue = (item, field) => (field === 'url' ? (item?.urls || []).join(', ') : item?.[field] ?? '');

const MAX_HOST_LENGTH = 253; // longest name DNS allows

/**
 * #370: the host an address really leads to, as the browser parses it: never cut, non-ASCII names as punycode (xn--…).
 * Refused: user data (https://name@other-host/ reads like "name", a long one pushes the host out of the display), and
 * anything without a host the user could check.
 */
function urlTarget(value) {
  let url;
  try {
    url = new URL(normalizeUrl(value));
  } catch {
    throw fail(t('Diese Adresse ist ungültig.'));
  }
  if (url.username || url.password) throw fail(t('Adressen mit Benutzerdaten (name@…) sind nicht erlaubt.'));
  if (!url.hostname || url.hostname.length > MAX_HOST_LENGTH) throw fail(t('Diese Adresse ist ungültig.'));
  return url.hostname;
}

/** The values the user decides on: old and new for a change, the new ones for a new entry (its title is the headline). */
function visibleChanges(before, patch) {
  const changes = [];
  for (const field of ['title', 'username', 'url', 'folder']) {
    if (!((field === 'url' ? 'urls' : field) in patch)) continue;
    const to = fieldValue(patch, field);
    const host = field === 'url' && to ? { host: urlTarget(to) } : {};
    if (!before) {
      if (field !== 'title' && to) changes.push({ field, to: shown(to), ...host });
    } else if (fieldValue(before, field) !== to) {
      changes.push({ field, from: shown(fieldValue(before, field)), to: shown(to), ...host });
    }
  }
  return changes;
}

/**
 * scope: { all: true } or { all: false, scopes: [{ vaultId, folder }] } – folder '' = whole vault, otherwise the
 * folder with its subfolders.
 */
export function scopeAllows(scope, vaultId, folder) {
  if (!scope || scope.all) return true;
  const f = normalizeFolder(folder);
  return (scope.scopes || []).some((s) => s.vaultId === vaultId && (!s.folder || f === s.folder || f.startsWith(`${s.folder}/`)));
}

const vaultInScope = (scope, vaultId) => !scope || scope.all || (scope.scopes || []).some((s) => s.vaultId === vaultId);

export class McpService {
  /**
   * vault(): open VaultSession or null (locked); confirmRead({ agent, title, vault }) → 'session' | 'once' | 'deny';
   * confirmWrite({ agent, action, title, vault, fields }) → boolean; audit({ agent, tool, vault, entry, result });
   * scope(): released vaults/folders (see scopeAllows; without it everything is released).
   * trusted(agent, vaultId, entryId) → boolean, trust({ agent, vaultId, entryId, title }): entries the user released
   * for an agent with "never ask again" (stored by the app, revoked from the entry's context menu).
   * waitUnlock() → boolean: the app is locked – it comes to the front with its unlock screen; true once unlocked.
   * admitted(agent) → boolean: checked on every call (#369), so revoking reaches agents that are already connected.
   * policy(agent) → { write }: an agent writes only with write === true.
   */
  constructor({ vault, confirmRead, confirmWrite, audit, admitted = () => false, scope = () => ({ all: true }), policy = () => ({ write: false }), trusted = () => false, trust = () => {}, waitUnlock = async () => false,
    features = () => ({}), confirmPasskey = async () => false, chooseMicrosoft = async () => null }) {
    // features(): { passkeys, microsoft } – both off unless turned on in the settings (#308, #315).
    // confirmPasskey({ agent, title, username, vault, rpId, origin }) → boolean, asked for every single use. The app (#439) also
    // asks for the PIN there and throws instead (no PIN set): true means confirmed with the PIN, nothing is signed otherwise.
    // chooseMicrosoft({ agent, purpose, accounts: [{ key, title, username, vault }] }) → key of the chosen account or null.
    Object.assign(this, { vault, confirmRead, confirmWrite, audit, admitted, scope, policy, trusted, trust, waitUnlock, features, confirmPasskey, chooseMicrosoft });
    this.clients = new Set();
    this.grants = new WeakMap();
    // Timed grants by agent name ("for 1 hour"): survive a restart of the agent process, end when the app locks.
    this.timed = new Map();
  }

  connect(client) {
    this.clients.add(client);
    client.socket?.on?.('close', () => this.clients.delete(client));
  }

  /** Locking the app or revoking an agent ends its permission to read secrets. */
  revoke(agent = null) {
    for (const c of this.clients) if (!agent || c.agent === agent) this.grants.delete(c);
    if (agent) this.timed.delete(agent);
    else this.timed.clear();
  }

  /** Agents that may read secrets right now, with the end of the grant (longest per agent). */
  activeSessions() {
    const now = Date.now();
    const best = new Map();
    for (const c of this.clients) {
      const until = this.grants.get(c)?.until || 0;
      if (until > now && until > (best.get(c.agent) || 0)) best.set(c.agent, until);
    }
    for (const [agent, until] of this.timed) if (until > now && until > (best.get(agent) || 0)) best.set(agent, until);
    return [...best].map(([agent, until]) => ({ agent, until: new Date(until).toISOString() }));
  }

  async session() {
    const v = this.vault() || ((await this.waitUnlock()) ? this.vault() : null);
    if (!v) throw fail(t('Keevault ist gesperrt – bitte in der App entsperren und erneut versuchen.'));
    return v;
  }

  async container(vaultId) {
    const c = (await (await this.session()).containers()).find((x) => x.id === vaultId);
    if (!c || !vaultInScope(this.scope(), c.id)) throw fail(t('Dieser Tresor ist für KI-Agenten nicht freigegeben.'));
    if (c.locked) throw fail(t('Der Tresor ist gesperrt – bitte in der App entsperren.'));
    return c;
  }

  /** Locked while the user was being asked: what was read before stays here, whatever the answer was (#374). */
  stillOpen() {
    if (!this.vault()) throw fail(t('Keevault ist gesperrt – bitte in der App entsperren und erneut versuchen.'));
  }

  requireScope(vaultId, folder) {
    if (!scopeAllows(this.scope(), vaultId, folder)) throw fail(t('Dieser Ordner ist für KI-Agenten nicht freigegeben.'));
  }

  /**
   * confirmRead answers: 'once' | 'session' (this agent process, max 8 h) | 'minutes:<n>' (this agent name for n
   * minutes, max 8 h – also across restarts of the agent process) | 'always' (this agent and this entry until the
   * user revokes it) | anything else = denied.
   */
  async requireRead(client, item, container) {
    const now = Date.now();
    if ((this.grants.get(client)?.until || 0) > now || (this.timed.get(client.agent) || 0) > now) return;
    if (this.trusted(client.agent, container.id, item.id)) return;
    const answer = await this.confirmRead({ agent: client.agent, title: item.title, vault: container.name });
    this.stillOpen();
    const minutes = /^minutes:(\d+)$/.exec(String(answer))?.[1];
    if (answer === 'always') this.trust({ agent: client.agent, vaultId: container.id, entryId: item.id, title: item.title });
    else if (answer === 'session') this.grants.set(client, { until: now + SESSION_MS });
    else if (minutes) this.timed.set(client.agent, now + Math.min(Number(minutes) * 60_000, SESSION_MS));
    else if (answer !== 'once') throw fail(t('Vom Benutzer abgelehnt'));
  }

  async call(client, tool, args = {}) {
    const entry = { agent: client.agent, tool, vault: args.vaultId || '', entry: args.entryId || args.title || '' };
    try {
      if (!this.admitted(client.agent)) {
        // #381: an approval that ran out (or was withdrawn) also ends its read grants; a new approval starts without them.
        this.revoke(client.agent);
        throw fail(t('Dieser Agent ist nicht mehr zugelassen. Starte ihn neu und erlaube ihn in Keevault.'));
      }
      const result = await this.run(client, tool, args || {}, entry);
      this.audit?.({ ...entry, result: 'ok' });
      return result;
    } catch (e) {
      this.audit?.({ ...entry, result: e.message });
      throw e;
    }
  }

  /** entry: the line of the audit log; what only shows up on the way goes into it (origin, chosen account). */
  async run(client, tool, a, entry = {}) {
    switch (tool) {
      case 'list_vaults': {
        const scope = this.scope();
        return (await (await this.session()).containers()).filter((c) => vaultInScope(scope, c.id)).map((c) => {
          const folders = scope.all ? [] : scope.scopes.filter((s) => s.vaultId === c.id).map((s) => s.folder);
          return {
            id: c.id, name: c.name, kind: c.kind, locked: !!c.locked, writable: c.access?.write !== false && !c.error, error: c.error?.message || undefined,
            // Released area: the whole vault, or only these folders (with subfolders).
            ...(scope.all || folders.includes('') ? { access: 'whole vault' } : { access: 'folders', folders }),
          };
        });
      }

      case 'search_entries': {
        const v = await this.session();
        const names = new Map((await v.containers()).map((c) => [c.id, c.name]));
        const q = String(a.query || '').trim().toLowerCase();
        const limit = Math.min(SEARCH_LIMIT, Math.max(1, Number(a.limit) || 25));
        const scope = this.scope();
        const hits = (await v.summaries())
          .filter((s) => scopeAllows(scope, s.containerId, s.folder))
          .filter((s) => !a.vaultId || s.containerId === a.vaultId)
          .filter((s) => !q || [s.title, s.username, s.folder, ...(s.hosts || [])].some((x) => String(x || '').toLowerCase().includes(q)))
          .sort((x, y) => x.title.localeCompare(y.title));
        return {
          total: hits.length,
          entries: hits.slice(0, limit).map((s) => ({
            vaultId: s.containerId, vault: names.get(s.containerId) || '', entryId: s.id, title: s.title, username: s.username, hosts: s.hosts, folder: s.folder, type: s.type, hasTotp: !!s.hasTotp,
          })),
        };
      }

      case 'get_entry':
      case 'get_totp': {
        const c = await this.container(a.vaultId);
        const item = await (await this.session()).getItem(c.id, a.entryId, { fresh: true });
        this.requireScope(c.id, item.folder);
        await this.requireRead(client, item, c);
        if (tool === 'get_totp') {
          if (!item.totp) throw fail(t('Kein Einmalcode (TOTP) hinterlegt'));
          const { code, remaining } = await totpCode(item.totp);
          return { code, validForSeconds: remaining };
        }
        // Never private key material: passkeys and certificate files stay in the vault. #469: no TOTP secret either
        // (only whether one is set) – get_totp gives the current code.
        return {
          vaultId: c.id, entryId: item.id, type: item.type, title: item.title, username: item.username, password: item.password,
          urls: item.urls, notes: item.notes, folder: item.folder, hasTotp: !!item.totp,
          fields: item.fields.map((f) => (f.type === 'totp' ? { name: f.name, type: 'totp', hasTotp: !!f.value } : { name: f.name, value: f.value })),
          ...(item.type === 'card' ? { card: item.card } : {}),
          ...(item.type === 'certificate' ? { certificate: { subject: item.cert?.subject, notAfter: item.cert?.notAfter, note: 'certificate file not exported' } } : {}),
          passkeys: item.passkeys.length,
          // Signs in with another entry (domain or Microsoft login): only the reference – reading that entry is a
          // request of its own (own confirmation, own "never ask again").
          ...(item.loginLink ? { signInFrom: { vaultId: item.loginLink.split('/')[0], entryId: item.loginLink.split('/')[1], note: 'user name and password come from this entry – read it with get_entry' } } : {}),
        };
      }

      case 'create_entry':
      case 'update_entry': {
        if (this.policy(client.agent)?.write !== true) throw fail(t('Dieser Agent darf nur lesen (Einstellungen → KI-Agenten).'));
        if (typeof a.url === 'string' && a.url.trim()) urlTarget(a.url);
        const c = await this.container(a.vaultId);
        if (c.access?.write === false) throw fail(t('Kein Schreibrecht in diesem Tresor'));
        const v = await this.session();
        const before = tool === 'update_entry' ? await v.getItem(c.id, a.entryId, { fresh: true }) : null;
        if (before) this.requireScope(c.id, before.folder);
        const patch = {};
        for (const k of ['title', 'username', 'notes', 'folder']) if (typeof a[k] === 'string') patch[k] = a[k];
        // Only one folder released in this vault: new entries go there unless the agent names a folder.
        const scope = this.scope();
        const released = scope.all ? [] : scope.scopes.filter((s) => s.vaultId === c.id).map((s) => s.folder);
        if (!before && patch.folder === undefined && released.length === 1 && released[0]) patch.folder = released[0];
        // Neither create outside the released area nor move an entry out of it.
        this.requireScope(c.id, patch.folder ?? before?.folder ?? '');
        if (typeof a.url === 'string') patch.urls = a.url ? [a.url] : [];
        if (a.generatePassword) patch.password = generatePassword({ length: Number(a.passwordLength) || 24 });
        else if (typeof a.password === 'string') patch.password = a.password;
        const changed = Object.keys(patch).map((k) => (k === 'urls' ? 'url' : k));
        if (before && !changed.length) throw fail(t('Keine Änderung angegeben'));
        requireFields(normalizeItem({ ...(before || { type: 'login' }), ...patch }), await readVaultSettings(v, c)); // #480, before asking
        const ok = await this.confirmWrite({
          // #370: a change names the entry as it is now, the new title is one of the changes.
          agent: client.agent, action: before ? 'update' : 'create', title: shown(before?.title || patch.title || ''), vault: c.name,
          fields: changed.map((k) => (k === 'password' && a.generatePassword ? 'password (neu erzeugt)' : k)),
          changes: visibleChanges(before, patch),
        });
        this.stillOpen();
        if (!ok) throw fail(t('Vom Benutzer abgelehnt'));
        const item = normalizeItem({ ...(before || { type: 'login' }), ...patch });
        const saved = await v.saveItem(c.id, item, before ? { expectedVersion: before.version } : {});
        return { vaultId: c.id, entryId: saved.id, title: saved.title, changed, passwordGenerated: !!a.generatePassword };
      }

      case 'sign_in_with_passkey': {
        // #308: the assertion for one sign-in, never the key. Only the passkey's own site over https, every use confirmed.
        if (!this.features().passkeys) throw fail(t('Passkeys für KI-Agenten sind ausgeschaltet (Keevault → Einstellungen → KI-Agenten).'));
        const c = await this.container(a.vaultId);
        const v = await this.session();
        const item = await v.getItem(c.id, a.entryId, { fresh: true });
        this.requireScope(c.id, item.folder);
        let origin;
        try { origin = new URL(String(a.origin || '')); } catch { throw fail(t('Ungültige Herkunft (origin)')); }
        entry.origin = origin.origin;
        const rpId = String(a.rpId || '').toLowerCase();
        const want = String(a.credentialId || '');
        const passkey = (item.passkeys || []).find((p) => (!rpId || p.rpId === rpId) && (!want || p.credentialId === want));
        if (!passkey) throw fail(t('Kein passender Passkey in diesem Eintrag'));
        const host = origin.hostname.toLowerCase();
        if (origin.protocol !== 'https:' || origin.port || (host !== passkey.rpId && !host.endsWith(`.${passkey.rpId}`))) {
          throw fail(t('Der Passkey gilt nur für {rpId} (https) – nicht für {origin}.', { rpId: passkey.rpId, origin: origin.origin }));
        }
        const challenge = String(a.challenge || '');
        // Microsoft sends a signed token as challenge (about 1,300 characters, #321) – 4096 leaves room, still bounded.
        if (!/^[A-Za-z0-9_-]{22,4096}={0,2}$/.test(challenge)) throw fail(t('Ungültige Challenge (base64url, mindestens 16 Byte)'));
        // The account the sign-in is for (#331): the passkey's own user name, else the entry's.
        const ok = await this.confirmPasskey({ agent: client.agent, title: item.title, username: passkey.userName || item.username || '', vault: c.name, rpId: passkey.rpId, origin: origin.origin });
        this.stillOpen();
        if (!ok) throw fail(t('Vom Benutzer abgelehnt'));
        const { response, signCount } = await getAssertion({ origin: origin.origin, rpId: passkey.rpId, challenge, passkey });
        // A counting passkey keeps counting (synced ones stay at 0).
        if (signCount > 0 && c.access?.write !== false) {
          await v.saveItem(c.id, { ...item, passkeys: item.passkeys.map((p) => (p === passkey ? { ...p, signCount } : p)) }, { expectedVersion: item.version }).catch(() => {});
        }
        return { credential: response, rpId: passkey.rpId, origin: origin.origin };
      }

      case 'request_microsoft_login': {
        // #315: the user approves and picks the account in Keevault; without a choice nothing is returned.
        if (!this.features().microsoft) throw fail(t('Microsoft-Anmeldungen für Tools sind ausgeschaltet (Keevault → Einstellungen → KI-Agenten).'));
        const v = await this.session();
        const names = new Map((await v.containers()).map((c) => [c.id, c.name]));
        const tenant = String(a.tenant || '').trim().toLowerCase().replace(/^@/, '');
        const scope = this.scope();
        const accounts = (await v.summaries())
          .filter((s) => s.type === 'login' && (s.msAdmin || (s.hosts || []).some((h) => /(^|\.)(microsoftonline|microsoft|office|live|azure)\.(com|net)$/i.test(h))))
          .filter((s) => scopeAllows(scope, s.containerId, s.folder))
          // #333: the tenant only sorts – the user decides which account signs in, also one of another tenant
          .map((s) => ({ s, match: !tenant || String(s.username || '').toLowerCase().endsWith(`@${tenant}`) }))
          .sort((x, y) => Number(y.match) - Number(x.match) || Number(!!y.s.msAdmin) - Number(!!x.s.msAdmin) || x.s.title.localeCompare(y.s.title))
          .map(({ s, match }) => ({ key: `${s.containerId}/${s.id}`, title: s.title, username: s.username, vault: names.get(s.containerId) || '', ...(match ? {} : { otherTenant: true }) }));
        if (!accounts.length) throw fail(t('Kein Microsoft-Login in den für Agenten freigegebenen Tresoren'));
        const key = await this.chooseMicrosoft({ agent: client.agent, purpose: shown(a.purpose), accounts });
        this.stillOpen();
        const chosen = accounts.find((x) => x.key === key);
        if (!chosen) throw fail(t('Vom Benutzer abgelehnt'));
        const [vaultId, entryId] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
        Object.assign(entry, { vault: vaultId, entry: entryId, account: chosen.username });
        const item = await v.getItem(vaultId, entryId, { fresh: true });
        const otp = item.totp ? await totpCode(item.totp) : null;
        return { vaultId, entryId, title: item.title, username: item.username, password: item.password,
          ...(otp ? { totp: otp.code, totpValidForSeconds: otp.remaining } : {}), passkey: !!item.passkeys?.length };
      }

      case 'generate_password':
        return { password: generatePassword({ length: Number(a.length) || 24, symbols: a.symbols !== false }) };

      default:
        throw fail(`Unknown tool ${tool}`);
    }
  }
}

/** Client configuration snippets for the settings dialog and the docs. */
export function mcpClientConfig({ command, script }) {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  return {
    command, args: [script], env,
    claudeDesktop: JSON.stringify({ mcpServers: { keevault: { command, args: [script], env } } }, null, 2),
    claudeCode: `claude mcp add keevault -e ELECTRON_RUN_AS_NODE=1 -- "${command}" "${script}"`,
    vscode: JSON.stringify({ servers: { keevault: { type: 'stdio', command, args: [script], env } } }, null, 2),
  };
}

// ---------------------------------------------------------------- stdio host (runs in the agent's process tree)

export const mcpHostScript = (pipe, version) => MCP_HOST
  .replace('__PIPE__', JSON.stringify(pipe))
  .replace('__VERSION__', JSON.stringify(version))
  .replace('__TOOLS__', JSON.stringify(MCP_TOOLS));

const MCP_HOST = `// Keevault MCP server (generated). JSON-RPC over stdio for the agent, newline JSON over the named pipe to the app.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; delete process.env.SSLKEYLOGFILE; // #517: no TLS switches from the environment
const net = require('net');
const PIPE = __PIPE__;
const VERSION = __VERSION__;
const TOOLS = __TOOLS__;
const OFFLINE = 'Keevault is not running. Start the Keevault app (and unlock it), then try again.';
let agent = 'MCP client';
let socket = null;
let connecting = null;
let hello = null;
let seq = 0;
let lines = '';
let input = '';
const pending = new Map();

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');

function connect() {
  if (socket) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    s.setEncoding('utf8');
    s.on('connect', () => { socket = s; connecting = null; resolve(s); });
    s.on('data', (d) => {
      lines += d;
      let i;
      while ((i = lines.indexOf('\\n')) >= 0) {
        const line = lines.slice(0, i);
        lines = lines.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p(m); }
      }
    });
    const lost = () => {
      socket = null; connecting = null; hello = null; lines = '';
      for (const p of pending.values()) p({ ok: false, error: { message: OFFLINE } });
      pending.clear();
      reject(new Error(OFFLINE));
    };
    s.on('error', lost);
    s.on('close', lost);
  });
  return connecting;
}

async function request(cmd, args) {
  const s = await connect();
  const id = ++seq;
  const reply = await new Promise((resolve) => { pending.set(id, resolve); s.write(JSON.stringify({ ...args, id, cmd }) + '\\n'); });
  if (!reply.ok) throw new Error((reply.error && reply.error.message) || 'Error');
  return reply.result;
}

async function app(cmd, args) {
  // The first hello may wait for the approval of this agent in the app.
  if (!hello) hello = request('hello', { origin: 'mcp:' + agent }).catch((e) => { hello = null; throw e; });
  await hello;
  return request(cmd, args);
}

async function handle(msg) {
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      agent = String((msg.params && msg.params.clientInfo && msg.params.clientInfo.name) || agent).slice(0, 80);
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keevault', title: 'Keevault', version: VERSION },
        instructions: 'Keevault password manager (Azure Key Vault). search_entries shows metadata only; get_entry/get_totp need the user to allow reading secrets in the Keevault app; create_entry/update_entry need a confirmation there. Entries cannot be deleted. Never echo passwords back to the user unless asked.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      try {
        const result = await app('mcp:call', { tool: name, args: (msg.params && msg.params.arguments) || {} });
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let i;
  while ((i = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, i).trim();
    input = input.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (msg && msg.method) handle(msg).catch((e) => msg.id !== undefined && out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
`;
