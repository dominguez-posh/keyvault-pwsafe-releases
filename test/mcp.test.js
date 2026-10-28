import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpService, MCP_TOOLS, mcpHostScript } from '../desktop/mcp.js';
import { BrowserBridge } from '../desktop/bridge.js';

// Fake vault session with one vault and two entries.
function fakeVault() {
  const items = new Map([
    ['pws-1', { id: 'pws-1', version: 'v1', type: 'login', title: 'Azure Admin', username: 'admin@contoso.com', password: 'S3cret!', urls: ['https://portal.azure.com/'], totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', notes: 'n', folder: 'Cloud', fields: [], passkeys: [{ credentialId: 'c', privateKey: 'PRIVATE' }], card: {}, cert: {} }],
    ['pws-2', { id: 'pws-2', version: 'v1', type: 'login', title: 'Firewall', username: 'root', password: 'fw', urls: [], totp: '', notes: '', folder: '', fields: [], passkeys: [], card: {}, cert: {} }],
  ]);
  const saved = [];
  return {
    saved,
    containers: async () => [{ id: 'kv-team', name: 'Team', kind: 'keyvault', access: { write: true } }],
    summaries: async () => [...items.values()].map((i) => ({ containerId: 'kv-team', id: i.id, title: i.title, username: i.username, hosts: i.urls.map((u) => new URL(u).hostname), folder: i.folder, type: i.type, hasTotp: !!i.totp })),
    getItem: async (_c, id) => structuredClone(items.get(id)),
    saveItem: async (_c, item) => {
      const id = item.id || `pws-${saved.length + 10}`;
      saved.push({ ...item, id });
      return { ...item, id };
    },
  };
}

function service({ read = 'session', write = true, locked = false } = {}) {
  const v = fakeVault();
  const asked = { read: 0, write: [] };
  const audit = [];
  const mcp = new McpService({
    vault: () => (locked ? null : v),
    confirmRead: async () => { asked.read++; return read; },
    confirmWrite: async (x) => { asked.write.push(x); return write; },
    audit: (e) => audit.push(e),
  });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  return { mcp, client, v, asked, audit };
}

test('mcp: search shows metadata only, never secrets', async () => {
  const { mcp, client, asked } = service();
  const r = await mcp.call(client, 'search_entries', { query: 'azure' });
  assert.equal(r.total, 1);
  assert.deepEqual(Object.keys(r.entries[0]).sort(), ['entryId', 'folder', 'hasTotp', 'hosts', 'title', 'type', 'username', 'vault', 'vaultId']);
  assert.ok(!JSON.stringify(r).includes('S3cret'), 'no password in search results');
  assert.equal(asked.read, 0, 'searching needs no confirmation');
});

test('mcp: reading needs a confirmation – once per session', async () => {
  const { mcp, client, asked, audit } = service({ read: 'session' });
  const e = await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(e.password, 'S3cret!');
  assert.equal(e.passkeys, 1, 'passkeys only counted');
  assert.ok(!JSON.stringify(e).includes('PRIVATE'), 'never private keys');
  const code = await mcp.call(client, 'get_totp', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.match(code.code, /^\d{6}$/);
  assert.equal(asked.read, 1, 'second read within the session without asking');
  mcp.revoke();
  await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-2' });
  assert.equal(asked.read, 2, 'after locking/revoking it asks again');
  assert.ok(audit.every((x) => !JSON.stringify(x).includes('S3cret')), 'log without secrets');
});

test('mcp: "only once" asks every time, "deny" refuses', async () => {
  const once = service({ read: 'once' });
  await once.mcp.call(once.client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  await once.mcp.call(once.client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(once.asked.read, 2);
  const deny = service({ read: 'deny' });
  await assert.rejects(deny.mcp.call(deny.client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' }), /abgelehnt/);
});

test('mcp: create/update with confirmation; generated password is stored, not returned', async () => {
  const { mcp, client, v, asked } = service();
  const r = await mcp.call(client, 'create_entry', { vaultId: 'kv-team', title: 'Neuer Server', username: 'svc', generatePassword: true, passwordLength: 32 });
  assert.ok(r.passwordGenerated && !('password' in r));
  assert.equal(v.saved[0].password.length, 32);
  assert.deepEqual(asked.write[0].fields, ['title', 'username', 'password (neu erzeugt)']);
  await assert.rejects(mcp.call(client, 'update_entry', { vaultId: 'kv-team', entryId: 'pws-2' }), /Keine Änderung/);
  const denied = service({ write: false });
  await assert.rejects(denied.mcp.call(denied.client, 'update_entry', { vaultId: 'kv-team', entryId: 'pws-2', title: 'x' }), /abgelehnt/);
  assert.equal(denied.v.saved.length, 0);
});

test('mcp: scope – only released vaults and folders (with subfolders)', async () => {
  const v = fakeVault();
  // Second vault and a nested folder.
  const containers = v.containers;
  v.containers = async () => [...(await containers()), { id: 'kv-private', name: 'Privat', kind: 'keyvault', access: { write: true } }];
  let scope = { all: false, scopes: [] };
  const asked = [];
  const mcp = new McpService({ vault: () => v, confirmRead: async () => 'once', confirmWrite: async (x) => { asked.push(x); return true; }, scope: () => scope });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);

  assert.deepEqual(await mcp.call(client, 'list_vaults'), [], 'nothing released: the agent sees nothing');
  assert.equal((await mcp.call(client, 'search_entries', {})).total, 0);
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' }), /nicht freigegeben/);

  scope = { all: false, scopes: [{ vaultId: 'kv-team', folder: 'Cloud' }] };
  const vaults = await mcp.call(client, 'list_vaults');
  assert.deepEqual(vaults.map((x) => [x.id, x.access, x.folders]), [['kv-team', 'folders', ['Cloud']]]);
  const found = await mcp.call(client, 'search_entries', {});
  assert.deepEqual(found.entries.map((e) => e.entryId), ['pws-1'], 'entries outside the folder stay invisible');
  assert.equal((await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' })).password, 'S3cret!');
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-2' }), /Ordner ist für KI-Agenten nicht freigegeben/);
  assert.equal((await mcp.call(client, 'search_entries', { vaultId: 'kv-private' })).total, 0, 'unreleased vault: no hits');

  // Creating: without a folder it lands in the only released one; outside is refused; moving out is refused.
  const created = await mcp.call(client, 'create_entry', { vaultId: 'kv-team', title: 'Neu' });
  assert.equal(v.saved.at(-1).folder, 'Cloud');
  assert.ok(created.entryId);
  await assert.rejects(mcp.call(client, 'create_entry', { vaultId: 'kv-team', title: 'Draußen', folder: 'Privat' }), /nicht freigegeben/);
  await assert.rejects(mcp.call(client, 'update_entry', { vaultId: 'kv-team', entryId: 'pws-1', folder: 'Anderswo' }), /nicht freigegeben/);
  await mcp.call(client, 'update_entry', { vaultId: 'kv-team', entryId: 'pws-1', folder: 'Cloud/Azure' });
  assert.equal(v.saved.at(-1).folder, 'Cloud/Azure', 'subfolders of a released folder are allowed');
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: 'kv-private', entryId: 'x' }), /Tresor ist für KI-Agenten nicht freigegeben/);

  scope = { all: false, scopes: [{ vaultId: 'kv-team', folder: '' }] };
  assert.equal((await mcp.call(client, 'search_entries', {})).total, 2, 'whole vault released');
});

test('mcp: locked app gives nothing', async () => {
  const { mcp, client } = service({ locked: true });
  await assert.rejects(mcp.call(client, 'list_vaults'), /gesperrt/);
});

test('mcp host: agent ↔ host ↔ app (JSON-RPC over stdio, approval by client name)', async () => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\kvpwsafe-mcp-test-${process.pid}` : join(mkdtempSync(join(tmpdir(), 'kv-mcp-')), 's.sock');
  const approved = [];
  const bridge = new BrowserBridge({
    path: pipe,
    approve: async (origin) => { approved.push(origin); return origin === 'mcp:test-agent'; },
    handlers: {
      hello: async () => ({ version: 'test' }),
      'mcp:call': async ({ tool, args }) => ({ tool, args }),
    },
  });
  await bridge.start();
  const dir = mkdtempSync(join(tmpdir(), 'kv-mcp-host-'));
  const script = join(dir, 'keevault-mcp.cjs');
  writeFileSync(script, mcpHostScript(pipe, '9.9.9'));
  const proc = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  const rpc = async (id, method, params) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let n = 0; n < 100 && !replies.has(id); n++) await new Promise((r) => setTimeout(r, 30));
    return replies.get(id);
  };
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'keevault');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await rpc(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map((x) => x.name), MCP_TOOLS.map((x) => x.name));
    const call = await rpc(3, 'tools/call', { name: 'search_entries', arguments: { query: 'vpn' } });
    assert.ok(!call.result.isError, JSON.stringify(call));
    assert.deepEqual(JSON.parse(call.result.content[0].text), { tool: 'search_entries', args: { query: 'vpn' } });
    assert.deepEqual(approved, ['mcp:test-agent'], 'approved by the MCP client name');
    assert.equal((await rpc(4, 'nope/unknown', {})).error.code, -32601);
  } finally {
    bridge.stop();
  }
  // App gone: tool calls answer with an error instead of hanging.
  const offline = await rpc(5, 'tools/call', { name: 'list_vaults', arguments: {} });
  assert.ok(offline.result.isError && /not running/.test(offline.result.content[0].text));
  proc.kill();
});
