// AI agents through the Model Context Protocol (MCP). The agent starts a small stdio process (mcpHostScript, run by
// Keevault.exe with ELECTRON_RUN_AS_NODE=1); it relays to the running app over the same named pipe as the browser.
// The app decides everything:
//   - each agent is approved once (by its MCP client name), the feature is off by default and can be blocked by policy
//   - agents only see the released vaults and folders (scope; default: nothing until the user releases something)
//   - searching shows metadata only (title, user, URL, folder) – never secrets
//   - reading passwords/one-time codes needs a confirmation in the app, valid for this agent session (max 8 hours)
//     or only once; locking the app ends all sessions
//   - creating/changing entries needs a confirmation every time; deleting is not possible
//   - every call is logged without secret values

import { generatePassword } from '../extension/core/generator.js';
import { totpCode } from '../extension/core/totp.js';
import { normalizeItem, normalizeFolder } from '../extension/core/model.js';
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
    name: 'generate_password',
    title: 'Passwort erzeugen',
    description: 'Generates a strong random password without storing it.',
    inputSchema: { type: 'object', properties: { length: { type: 'integer', minimum: 8, maximum: 128 }, symbols: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
];

const fail = (message) => Object.assign(new Error(message), { name: 'McpError' });

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
   */
  constructor({ vault, confirmRead, confirmWrite, audit, scope = () => ({ all: true }) }) {
    Object.assign(this, { vault, confirmRead, confirmWrite, audit, scope });
    this.clients = new Set();
    this.grants = new WeakMap();
  }

  connect(client) {
    this.clients.add(client);
    client.socket?.on?.('close', () => this.clients.delete(client));
  }

  /** Locking the app or revoking an agent ends its permission to read secrets. */
  revoke(agent = null) {
    for (const c of this.clients) if (!agent || c.agent === agent) this.grants.delete(c);
  }

  activeSessions() {
    const now = Date.now();
    return [...this.clients].filter((c) => (this.grants.get(c)?.until || 0) > now).map((c) => ({ agent: c.agent, until: new Date(this.grants.get(c).until).toISOString() }));
  }

  session() {
    const v = this.vault();
    if (!v) throw fail(t('Keevault ist gesperrt – bitte in der App entsperren und erneut versuchen.'));
    return v;
  }

  async container(vaultId) {
    const c = (await this.session().containers()).find((x) => x.id === vaultId);
    if (!c || !vaultInScope(this.scope(), c.id)) throw fail(t('Dieser Tresor ist für KI-Agenten nicht freigegeben.'));
    if (c.locked) throw fail(t('Der Tresor ist gesperrt – bitte in der App entsperren.'));
    return c;
  }

  requireScope(vaultId, folder) {
    if (!scopeAllows(this.scope(), vaultId, folder)) throw fail(t('Dieser Ordner ist für KI-Agenten nicht freigegeben.'));
  }

  async requireRead(client, title, vault) {
    if ((this.grants.get(client)?.until || 0) > Date.now()) return;
    const answer = await this.confirmRead({ agent: client.agent, title, vault });
    if (answer === 'session') this.grants.set(client, { until: Date.now() + SESSION_MS });
    else if (answer !== 'once') throw fail(t('Vom Benutzer abgelehnt'));
  }

  async call(client, tool, args = {}) {
    const entry = { agent: client.agent, tool, vault: args.vaultId || '', entry: args.entryId || args.title || '' };
    try {
      const result = await this.run(client, tool, args || {});
      this.audit?.({ ...entry, result: 'ok' });
      return result;
    } catch (e) {
      this.audit?.({ ...entry, result: e.message });
      throw e;
    }
  }

  async run(client, tool, a) {
    switch (tool) {
      case 'list_vaults': {
        const scope = this.scope();
        return (await this.session().containers()).filter((c) => vaultInScope(scope, c.id)).map((c) => {
          const folders = scope.all ? [] : scope.scopes.filter((s) => s.vaultId === c.id).map((s) => s.folder);
          return {
            id: c.id, name: c.name, kind: c.kind, locked: !!c.locked, writable: c.access?.write !== false && !c.error, error: c.error?.message || undefined,
            // Released area: the whole vault, or only these folders (with subfolders).
            ...(scope.all || folders.includes('') ? { access: 'whole vault' } : { access: 'folders', folders }),
          };
        });
      }

      case 'search_entries': {
        const v = this.session();
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
        const item = await this.session().getItem(c.id, a.entryId, { fresh: true });
        this.requireScope(c.id, item.folder);
        await this.requireRead(client, item.title, c.name);
        if (tool === 'get_totp') {
          if (!item.totp) throw fail(t('Kein Einmalcode (TOTP) hinterlegt'));
          const { code, remaining } = await totpCode(item.totp);
          return { code, validForSeconds: remaining };
        }
        // Never private key material: passkeys and certificate files stay in the vault.
        return {
          vaultId: c.id, entryId: item.id, type: item.type, title: item.title, username: item.username, password: item.password,
          urls: item.urls, notes: item.notes, folder: item.folder, hasTotp: !!item.totp,
          fields: item.fields.map((f) => ({ name: f.name, value: f.value })),
          ...(item.type === 'card' ? { card: item.card } : {}),
          ...(item.type === 'certificate' ? { certificate: { subject: item.cert?.subject, notAfter: item.cert?.notAfter, note: 'certificate file not exported' } } : {}),
          passkeys: item.passkeys.length,
        };
      }

      case 'create_entry':
      case 'update_entry': {
        const c = await this.container(a.vaultId);
        if (c.access?.write === false) throw fail(t('Kein Schreibrecht in diesem Tresor'));
        const v = this.session();
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
        const ok = await this.confirmWrite({
          agent: client.agent, action: before ? 'update' : 'create', title: patch.title || before?.title || '', vault: c.name,
          fields: changed.map((k) => (k === 'password' && a.generatePassword ? 'password (neu erzeugt)' : k)),
        });
        if (!ok) throw fail(t('Vom Benutzer abgelehnt'));
        const item = normalizeItem({ ...(before || { type: 'login' }), ...patch });
        const saved = await v.saveItem(c.id, item, before ? { expectedVersion: before.version } : {});
        return { vaultId: c.id, entryId: saved.id, title: saved.title, changed, passwordGenerated: !!a.generatePassword };
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
