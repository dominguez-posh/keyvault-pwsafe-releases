import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../../extension/core/session.js';

// In-memory imitation of the Key Vault secrets REST API (paging with page size 2, versions, soft delete).
export function fakeKeyVault(host) {
  const secrets = new Map(); // name -> [{ version, value, tags, contentType, attributes }]
  const deleted = new Map();
  let versionSeq = 0;
  const calls = [];
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bundle = (name, v) => ({ id: `https://${host}/secrets/${name}/${v.version}`, value: v.value, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
  const item = (name, v) => ({ id: `https://${host}/secrets/${name}`, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
  const page = (url, all) => {
    const skip = Number(url.searchParams.get('$skiptoken') || 0);
    const next = skip + 2 < all.length ? `https://${host}${url.pathname}?api-version=7.5&$skiptoken=${skip + 2}` : null;
    return { value: all.slice(skip, skip + 2), nextLink: next };
  };

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    calls.push(`${method} ${url.pathname}`);
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.get('api-version'), '7.5');
    assert.match(init.headers.Authorization, /^Bearer token-/);
    const parts = url.pathname.split('/').filter(Boolean);
    const [kind, name, version] = parts;
    if (kind === 'secrets' && !name && method === 'GET') {
      return json(200, page(url, [...secrets].map(([n, vs]) => item(n, vs.at(-1)))));
    }
    if (kind === 'secrets' && parts[2] === 'versions') {
      return json(200, page(url, (secrets.get(name) || []).map((v) => ({ ...item(name, v), id: `https://${host}/secrets/${name}/${v.version}` }))));
    }
    if (kind === 'secrets' && method === 'GET') {
      const vs = secrets.get(name);
      const v = vs && (version ? vs.find((x) => x.version === version) : vs.at(-1));
      return v ? json(200, bundle(name, v)) : json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
    }
    if (kind === 'secrets' && method === 'PUT') {
      if (deleted.has(name)) return json(409, { error: { code: 'Conflict', message: 'deleted' } });
      const body = JSON.parse(init.body);
      const now = Math.floor(Date.now() / 1000) + versionSeq;
      const v = { version: `v${++versionSeq}`, value: body.value, tags: body.tags, contentType: body.contentType, attributes: { enabled: true, created: now, updated: now } };
      secrets.set(name, [...(secrets.get(name) || []), v]);
      return json(200, bundle(name, v));
    }
    if (kind === 'secrets' && method === 'PATCH') {
      const v = (secrets.get(name) || []).find((x) => x.version === version);
      if (!v) return json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
      v.attributes = { ...v.attributes, ...JSON.parse(init.body).attributes };
      return json(200, bundle(name, v));
    }
    if (kind === 'secrets' && method === 'DELETE') {
      const vs = secrets.get(name);
      secrets.delete(name);
      deleted.set(name, vs);
      return json(200, { recoveryId: `https://${host}/deletedsecrets/${name}`, ...item(name, vs.at(-1)) });
    }
    if (kind === 'deletedsecrets' && method === 'GET') {
      return json(200, page(url, [...deleted].map(([n, vs]) => ({ recoveryId: `https://${host}/deletedsecrets/${n}`, ...item(n, vs.at(-1)), deletedDate: 1000, scheduledPurgeDate: 2000 }))));
    }
    if (kind === 'deletedsecrets' && parts[2] === 'recover') {
      secrets.set(name, deleted.get(name));
      deleted.delete(name);
      return json(200, {});
    }
    if (kind === 'deletedsecrets' && method === 'DELETE') {
      deleted.delete(name);
      return json(204);
    }
    return json(400, { error: { code: 'BadRequest', message: `${method} ${url.pathname}` } });
  }
  return { fetch, secrets, deleted, calls };
}

export async function setup() {
  const kv = fakeKeyVault('kv-team.vault.azure.net');
  const session = new VaultSession({
    getToken: async (scope) => `token-${scope}`,
    store: new MemoryStore(),
    fetch: kv.fetch,
    actor: () => 'alice@contoso.com',
  });
  await session.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return { kv, session };
}

