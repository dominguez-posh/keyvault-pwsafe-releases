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

test('mcp: timed grant is bound to the agent name, survives a new client, ends on revoke', async () => {
  const { mcp, client, asked } = service({ read: 'minutes:60' });
  await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  const again = { agent: 'claude-ai' }; // the agent started a new process (e.g. one per call)
  mcp.connect(again);
  await mcp.call(again, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-2' });
  assert.equal(asked.read, 1, 'the new process reads without asking within the hour');
  const other = { agent: 'copilot' };
  mcp.connect(other);
  await mcp.call(other, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(asked.read, 2, 'another agent name asks');
  assert.deepEqual(mcp.activeSessions().map((s) => s.agent).sort(), ['claude-ai', 'copilot']);
  mcp.revoke('claude-ai');
  await mcp.call(again, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(asked.read, 3, 'revoking the agent ends the timed grant');
});

test('mcp: "never ask again" holds for this agent and this entry only, survives lock, ends when untrusted', async () => {
  const v = fakeVault();
  let answer = 'always';
  let asked = 0;
  let store = [];
  const mcp = new McpService({
    vault: () => v,
    confirmRead: async () => { asked++; return answer; },
    confirmWrite: async () => true,
    trusted: (agent, vaultId, entryId) => store.some((x) => x.agent === agent && x.vaultId === vaultId && x.entryId === entryId),
    trust: (grant) => { store.push(grant); },
  });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.deepEqual(store, [{ agent: 'claude-ai', vaultId: 'kv-team', entryId: 'pws-1', title: 'Azure Admin' }]);
  answer = 'once';
  mcp.revoke(); // app locked and unlocked again
  const fresh = { agent: 'claude-ai' };
  mcp.connect(fresh);
  assert.equal((await mcp.call(fresh, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' })).password, 'S3cret!');
  assert.equal(asked, 1, 'trusted entry is read without asking, also after locking and in a new agent process');
  await mcp.call(fresh, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-2' });
  assert.equal(asked, 2, 'another entry still asks');
  const other = { agent: 'copilot' };
  mcp.connect(other);
  await mcp.call(other, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(asked, 3, 'another agent still asks');
  store = [];
  await mcp.call(fresh, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.equal(asked, 4, 'after revoking from the context menu it asks again');
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

test('mcp: locked app – the request waits for the unlock (app comes to the front) and then continues', async () => {
  const v = fakeVault();
  let locked = true;
  let waited = 0;
  const mcp = new McpService({
    vault: () => (locked ? null : v),
    confirmRead: async () => 'once',
    confirmWrite: async () => true,
    audit: () => {},
    waitUnlock: async () => { waited++; locked = false; return true; },
  });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  assert.ok((await mcp.call(client, 'list_vaults')).length > 0);
  assert.equal(waited, 1);
  await mcp.call(client, 'list_vaults');
  assert.equal(waited, 1, 'no waiting while unlocked');
  // Nobody unlocks in time: refused as before.
  locked = true;
  mcp.waitUnlock = async () => false;
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-1' }), /gesperrt/);
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

test('mcp: a login that signs in with another entry gives only the reference, never that entry\'s password', async () => {
  const { mcp, client, v } = service({ read: 'session' });
  const original = v.getItem;
  v.getItem = async (c, id) => (id === 'pws-3'
    ? { id: 'pws-3', version: 'v1', type: 'login', title: 'Intranet', username: '', password: '', urls: [], totp: '', notes: '', folder: '', fields: [], passkeys: [], card: {}, cert: {}, loginLink: 'kv-team/pws-1' }
    : original(c, id));
  const e = await mcp.call(client, 'get_entry', { vaultId: 'kv-team', entryId: 'pws-3' });
  assert.equal(e.password, '');
  assert.deepEqual({ vaultId: e.signInFrom.vaultId, entryId: e.signInFrom.entryId }, { vaultId: 'kv-team', entryId: 'pws-1' });
  assert.ok(!JSON.stringify(e).includes('S3cret!'), 'the linked password is not handed out with this entry');
});

test('mcp: passkey sign-in for an agent – off by default, own site only, every use confirmed, verifiable assertion (#308)', async () => {
  const { createCredential } = await import('../extension/core/webauthn.js');
  const { verifyRegistrationResponse, verifyAuthenticationResponse } = await import('@simplewebauthn/server');
  const { b64uEncode, randomBytes } = await import('../extension/core/util.js');
  const origin = 'https://github.com';
  const regChallenge = b64uEncode(randomBytes(32));
  const { passkey, response } = await createCredential({ origin, rpId: 'github.com', rpName: 'GitHub', user: { id: b64uEncode(randomBytes(16)), name: 'alice', displayName: 'Alice' }, challenge: regChallenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const reg = await verifyRegistrationResponse({ response, expectedChallenge: regChallenge, expectedOrigin: origin, expectedRPID: 'github.com' });
  const items = new Map([['pk-1', { id: 'pk-1', version: 'v1', type: 'login', title: 'GitHub', username: 'alice', password: '', urls: ['https://github.com/'], totp: '', notes: '', folder: '', fields: [], passkeys: [passkey], card: {}, cert: {} }]]);
  const v = { containers: async () => [{ id: 'kv', name: 'Team', kind: 'keyvault', access: { write: true } }], summaries: async () => [], getItem: async (_c, id) => structuredClone(items.get(id)), saveItem: async (_c, i) => i };
  const features = { passkeys: false };
  const asked = [];
  let answer = true;
  const mcp = new McpService({ vault: () => v, confirmRead: async () => 'deny', confirmWrite: async () => false, audit: () => {}, features: () => features,
    confirmPasskey: async (x) => { asked.push(x); return answer; } });
  const client = { agent: 'claude-code' };
  mcp.connect(client);
  const challenge = b64uEncode(randomBytes(32));
  const args = { vaultId: 'kv', entryId: 'pk-1', origin, challenge };
  await assert.rejects(mcp.call(client, 'sign_in_with_passkey', args), /ausgeschaltet/, 'off by default');
  features.passkeys = true;
  await assert.rejects(mcp.call(client, 'sign_in_with_passkey', { ...args, origin: 'https://evil.example' }), /nur für github\.com/);
  await assert.rejects(mcp.call(client, 'sign_in_with_passkey', { ...args, origin: 'http://github.com' }), /nur für github\.com/);
  assert.equal(asked.length, 0, 'foreign origins are refused before asking');
  answer = false;
  await assert.rejects(mcp.call(client, 'sign_in_with_passkey', args), /abgelehnt/);
  answer = true;
  const r = await mcp.call(client, 'sign_in_with_passkey', args);
  assert.equal(asked.length, 2, 'every use is confirmed');
  assert.ok(!JSON.stringify(r).includes(passkey.privateKey), 'never the private key');
  const auth = await verifyAuthenticationResponse({ response: r.credential, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: 'github.com', credential: reg.registrationInfo.credential });
  assert.equal(auth.verified, true);
});

test('mcp: Microsoft sign-in for a tool – off by default, the user picks the account, nothing without a choice (#315)', async () => {
  const items = new Map([
    ['ms-1', { id: 'ms-1', type: 'login', title: 'M365 Admin', username: 'admin@contoso.com', password: 'Ms-1', urls: ['https://login.microsoftonline.com'], msAdmin: true, totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', passkeys: [], folder: '' }],
    ['ms-2', { id: 'ms-2', type: 'login', title: 'Fabrikam', username: 'it@fabrikam.com', password: 'Ms-2', urls: ['https://login.microsoftonline.com'], totp: '', passkeys: [], folder: '' }],
    ['gh', { id: 'gh', type: 'login', title: 'GitHub', username: 'alice', password: 'Gh', urls: ['https://github.com'], totp: '', passkeys: [], folder: '' }],
  ]);
  const v = {
    containers: async () => [{ id: 'kv', name: 'Team', kind: 'keyvault' }],
    summaries: async () => [...items.values()].map((i) => ({ containerId: 'kv', id: i.id, type: i.type, title: i.title, username: i.username, msAdmin: !!i.msAdmin, hosts: i.urls.map((u) => new URL(u).hostname), folder: '' })),
    getItem: async (_c, id) => structuredClone(items.get(id)),
  };
  const features = { microsoft: false };
  let offered = null;
  let pick = 'kv/ms-2';
  const mcp = new McpService({ vault: () => v, confirmRead: async () => 'deny', confirmWrite: async () => false, audit: () => {}, features: () => features,
    chooseMicrosoft: async (x) => { offered = x; return pick; } });
  const client = { agent: 'report-tool' };
  mcp.connect(client);
  await assert.rejects(mcp.call(client, 'request_microsoft_login', {}), /ausgeschaltet/, 'off by default');
  features.microsoft = true;
  const r = await mcp.call(client, 'request_microsoft_login', { purpose: 'Graph-Bericht' });
  assert.deepEqual(offered.accounts.map((a) => a.title), ['M365 Admin', 'Fabrikam'], 'only Microsoft logins, admins first');
  assert.equal(offered.purpose, 'Graph-Bericht');
  assert.equal(r.username, 'it@fabrikam.com');
  assert.equal(r.password, 'Ms-2');
  await mcp.call(client, 'request_microsoft_login', { tenant: 'contoso.com' }).catch(() => {});
  assert.deepEqual(offered.accounts.map((a) => a.title), ['M365 Admin'], 'tenant narrows the choice');
  pick = null;
  await assert.rejects(mcp.call(client, 'request_microsoft_login', {}), /abgelehnt/, 'no choice, nothing returned');
  pick = 'kv/gh';
  await assert.rejects(mcp.call(client, 'request_microsoft_login', {}), /abgelehnt/, 'a key that was not offered is refused');
});
