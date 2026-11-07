// #381: remains of the F4/F5 review – an approval that ran out ends its grants and keeps its time limit when renewed,
// the agent's own name and purpose are shown like any other value it sends, other space characters (Zs) are marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpService, renewedAgentRule, shown } from '../desktop/mcp.js';

const vault = () => ({
  containers: async () => [{ id: 'kv', name: 'Team', kind: 'keyvault', access: { write: true } }],
  summaries: async () => [],
  getItem: async (_c, id) => ({ id, type: 'login', title: 'Azure', username: 'a', password: 'pw', urls: [], totp: '', folder: '', fields: [], passkeys: [] }),
});

test('#381: an approval that ran out ends the session and timed read grants, a new approval asks again', async () => {
  let admitted = true;
  let asked = 0;
  const mcp = new McpService({ vault, admitted: () => admitted, confirmRead: async () => { asked++; return asked === 1 ? 'session' : 'minutes:60'; }, confirmWrite: async () => false });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  await mcp.call(client, 'get_entry', { vaultId: 'kv', entryId: 'e1' });
  mcp.timed.set('claude-ai', Date.now() + 3_600_000);
  assert.equal(mcp.activeSessions().length, 1);
  admitted = false; // the approval's time ran out
  await assert.rejects(mcp.call(client, 'get_entry', { vaultId: 'kv', entryId: 'e1' }), /nicht mehr zugelassen/);
  assert.deepEqual(mcp.activeSessions(), [], 'no session or timed grant is left');
  admitted = true; // approved again
  await mcp.call(client, 'get_entry', { vaultId: 'kv', entryId: 'e1' });
  assert.equal(asked, 2, 'reading needs a new confirmation');
});

test('#381: a new approval keeps the time limit of the old one instead of becoming unlimited', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.deepEqual(renewedAgentRule({ write: true, until: '2026-11-01T00:00:00Z', days: 7 }, false, now),
    { write: false, days: 7, until: '2026-11-14T10:00:00.000Z' });
  assert.equal(renewedAgentRule({ write: false, until: '2026-11-01T00:00:00Z' }, false, now).until, '2026-11-08T10:00:00.000Z', 'older rule without days: shortest period');
  assert.deepEqual(renewedAgentRule(undefined, true, now), { write: true, days: 0, until: null }, 'a first approval stays unlimited');
  assert.equal(renewedAgentRule({ write: false, until: null, days: 0 }, true, now).until, null);
  const src = readFileSync(new URL('../desktop/main/agents.js', import.meta.url), 'utf8');
  assert.ok(!/until:\s*null/.test(src), 'agents.js no longer drops the limit on a new approval');
  assert.match(src, /renewedAgentRule\(previous/);
  assert.match(src, /mcp\?\.revoke\(agent\)/, 'the expired approval ends its grants');
});

test('#381: the agent name and the purpose are shown with shown(), Zs characters are marked', async () => {
  assert.equal(shown('Claude Code'), 'Claude Code', 'the plain space stays');
  for (const cp of [0xa0, 0x2003, 0x3000, 0x202f, 0x1680]) assert.equal(shown(`a${String.fromCodePoint(cp)}b`), 'a�b', `U+${cp.toString(16)}`);
  const src = readFileSync(new URL('../desktop/main/agents.js', import.meta.url), 'utf8');
  assert.ok(!/\{ agent \}\)/.test(src), 'no title with the raw agent name');
  assert.ok(!/^\s+agent,$/m.test(src), 'no question with the raw agent name');
  let offered = null;
  const v = { containers: async () => [{ id: 'kv', name: 'Team' }], getItem: async () => ({ id: 'm', username: 'u', password: 'p', totp: '', passkeys: [] }),
    summaries: async () => [{ containerId: 'kv', id: 'm', type: 'login', title: 'M365', username: 'u@contoso.com', msAdmin: true, hosts: [], folder: '' }] };
  const mcp = new McpService({ admitted: () => true, vault: () => v, confirmRead: async () => 'deny', confirmWrite: async () => false, features: () => ({ microsoft: true }),
    chooseMicrosoft: async (x) => { offered = x; return null; } });
  await mcp.call({ agent: 'x' }, 'request_microsoft_login', { purpose: `Bericht${String.fromCodePoint(0x202e)} ${'y'.repeat(300)}` }).catch(() => {});
  assert.ok(offered.purpose.startsWith('Bericht��'), 'invisible and space characters in the purpose are marked');
  assert.ok(offered.purpose.length <= 201, 'the purpose is cut');
});
