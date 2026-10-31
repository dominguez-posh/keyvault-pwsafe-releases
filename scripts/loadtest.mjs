// Load and concurrency test: many Keevault clients (real VaultSession code) work on one vault at the same time.
//   node scripts/loadtest.mjs                       simulated Key Vault (latency, throttling), 50 clients
//   node scripts/loadtest.mjs --clients=100         more clients
//   node scripts/loadtest.mjs --vault=kv-test-xyz   a real Key Vault: token from "az account get-access-token";
//                                                    only entries created by the test are touched and deleted again
//                                                    (the shared index secrets of the vault are rewritten)
// Checks: start-up of all clients, parallel edits of different entries, the same entry edited by many at once
// (conflict check, no lost version), isolation (every client sees exactly the vault's entries), and how often the
// shared index is written after a change.

import { execFileSync } from 'node:child_process';
import { VaultSession, MemoryStore, ConflictError } from '../extension/core/session.js';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const CLIENTS = Number(arg('clients', 50));
const ENTRIES = Number(arg('entries', 120));
const SAME = Number(arg('same', 10)); // clients editing one entry at the same moment
const realVault = arg('vault', '');
const PREFIX = `loadtest-${Date.now().toString(36)}`;

// ------------------------------------------------------------------ simulated Key Vault
/**
 * Secrets REST API in memory with 25 per page, versions, 20–80 ms latency and throttling like Key Vault
 * (a token bucket of 4000 requests per 10 s per vault; beyond that 429 with Retry-After).
 */
function simulatedVault(host) {
  const secrets = new Map();
  let versionSeq = 0;
  const stats = { requests: 0, puts: 0, throttled: 0, indexPuts: 0 };
  let bucket = 4000;
  setInterval(() => { bucket = 4000; }, 10_000).unref();
  const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetch(input, init = {}) {
    stats.requests++;
    await sleep(20 + Math.random() * 60);
    if (--bucket < 0) {
      stats.throttled++;
      return json(429, { error: { code: 'Throttled', message: 'Too many requests' } }, { 'retry-after': '1' });
    }
    const url = new URL(input);
    const method = init.method || 'GET';
    const [kind, name, version] = url.pathname.split('/').filter(Boolean);
    const item = (n, v) => ({ id: `https://${host}/secrets/${n}`, tags: v.tags, contentType: v.contentType, attributes: v.attributes });
    const bundle = (n, v) => ({ ...item(n, v), id: `https://${host}/secrets/${n}/${v.version}`, value: v.value });
    if (kind === 'secrets' && !name && method === 'GET') {
      const all = [...secrets].map(([n, vs]) => item(n, vs.at(-1)));
      const skip = Number(url.searchParams.get('$skiptoken') || 0);
      return json(200, { value: all.slice(skip, skip + 25), nextLink: skip + 25 < all.length ? `https://${host}/secrets?api-version=7.5&$skiptoken=${skip + 25}` : null });
    }
    if (kind === 'secrets' && version === 'versions') {
      return json(200, { value: (secrets.get(name) || []).map((v) => ({ ...item(name, v), id: `https://${host}/secrets/${name}/${v.version}` })), nextLink: null });
    }
    if (kind === 'secrets' && method === 'GET') {
      const vs = secrets.get(name);
      const v = vs && (version ? vs.find((x) => x.version === version) : vs.at(-1));
      return v ? json(200, bundle(name, v)) : json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
    }
    if (kind === 'secrets' && method === 'PUT') {
      stats.puts++;
      if (name.startsWith('pws-index')) stats.indexPuts++;
      const body = JSON.parse(init.body);
      const now = Math.floor(Date.now() / 1000);
      const v = { version: `v${++versionSeq}`, value: body.value, tags: body.tags || {}, contentType: body.contentType, attributes: { enabled: true, created: now, updated: now } };
      secrets.set(name, [...(secrets.get(name) || []), v]);
      return json(200, bundle(name, v));
    }
    if (kind === 'secrets' && method === 'DELETE') {
      const vs = secrets.get(name);
      secrets.delete(name);
      return vs ? json(200, item(name, vs.at(-1))) : json(404, { error: { code: 'SecretNotFound', message: 'not found' } });
    }
    return json(400, { error: { code: 'BadRequest', message: `${method} ${url.pathname}` } });
  }
  return { fetch, stats, secrets };
}

// ------------------------------------------------------------------ real Key Vault
function realVaultAccess() {
  // --tenant=<id>: the vault's tenant (guest accounts sign in there: az login --tenant <id>).
  const tenant = arg('tenant', '');
  const token = execFileSync('az', ['account', 'get-access-token', '--resource', 'https://vault.azure.net', ...(tenant ? ['--tenant', tenant] : []), '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8', shell: true }).trim();
  const stats = { requests: 0, puts: 0, throttled: 0, indexPuts: 0 };
  const fetchImpl = async (input, init = {}) => {
    stats.requests++;
    const method = init.method || 'GET';
    if (method === 'PUT') {
      stats.puts++;
      if (/\/secrets\/pws-index/.test(String(input))) stats.indexPuts++;
    }
    const res = await fetch(input, init);
    if (res.status === 429) stats.throttled++;
    return res;
  };
  return { token, fetch: fetchImpl, stats };
}

// ------------------------------------------------------------------ test
const host = realVault ? `${realVault}.vault.azure.net` : 'kv-loadtest.vault.azure.net';
const backend = realVault ? realVaultAccess() : simulatedVault(host);
const containerId = host;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const time = async (label, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${label}: ${Date.now() - t0} ms`);
  return r;
};

function client(i) {
  return new VaultSession({
    getToken: async () => (realVault ? backend.token : `token-${i}`),
    store: new MemoryStore(),
    fetch: backend.fetch,
    actor: () => `user${i}@loadtest.local`,
  });
}

console.log(`Lasttest: ${CLIENTS} Clients, ${ENTRIES} Einträge, ${SAME} gleichzeitig am selben Eintrag – ${realVault ? `Key Vault ${host}` : 'simulierter Key Vault'}`);
const clients = Array.from({ length: CLIENTS }, (_, i) => client(i));
const created = [];
try {
  // 1. Seed: one client creates the entries.
  await clients[0].refreshContainers({ configured: [{ name: 'Lasttest', vaultUrl: host }], discover: false });
  clients[0].requireLicenseForNew = async () => {}; // the free limit does not matter here
  await time(`${ENTRIES} Einträge anlegen`, async () => {
    for (let n = 0; n < ENTRIES; n += 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, ENTRIES - n) }, (_, k) => clients[0].saveItem(containerId, { title: `${PREFIX}-${n + k}`, username: `u${n + k}`, password: 'pw', urls: ['https://example.com'] })));
      created.push(...batch.map((x) => x.id));
    }
  });
  await clients[0].flushFastIndex();

  // 2. All clients start at once: containers, fast index, full reconcile.
  for (const c of clients) c.requireLicenseForNew = async () => {};
  const before = { ...backend.stats };
  await time(`${CLIENTS} Clients starten gleichzeitig (Index + Abgleich)`, () => Promise.all(clients.map(async (c) => {
    await c.refreshContainers({ configured: [{ name: 'Lasttest', vaultUrl: host }], discover: false });
    await c.refreshIndexFast();
    await c.refreshIndex();
  })));
  console.log(`    Anfragen: ${backend.stats.requests - before.requests}, gedrosselt (429): ${backend.stats.throttled - before.throttled}`);
  const mine = (list) => list.filter((s) => s.title.startsWith(PREFIX)).length;
  const seen = await Promise.all(clients.map(async (c) => mine(await c.summaries())));
  check(seen.every((n) => n === ENTRIES), `Isolation/Vollständigkeit: Clients sehen ${[...new Set(seen)].join('/')} statt ${ENTRIES} Einträge`);

  // 3. Every client edits a different entry at the same time.
  const results = await time(`${CLIENTS} Clients bearbeiten gleichzeitig verschiedene Einträge`, () => Promise.allSettled(clients.map(async (c, i) => {
    const id = created[i % created.length];
    const item = await c.getItem(containerId, id, { fresh: true });
    return c.saveItem(containerId, { ...item, notes: `client ${i}` }, { expectedVersion: item.version });
  })));
  const distinct = Math.min(CLIENTS, created.length);
  const failed = results.filter((r) => r.status === 'rejected');
  check(CLIENTS > created.length || failed.length === 0, `Verschiedene Einträge: ${failed.length} Speicherungen fehlgeschlagen (${failed[0]?.reason?.message})`);
  console.log(`    erfolgreich: ${results.length - failed.length} von ${results.length} (${distinct} verschiedene Einträge)`);

  // 4. The same entry, opened by SAME clients, saved at the same moment.
  const target = created[created.length - 1];
  const opened = await Promise.all(clients.slice(0, SAME).map((c) => c.getItem(containerId, target, { fresh: true })));
  const same = await time(`${SAME} Clients speichern gleichzeitig denselben Eintrag`, () => Promise.allSettled(clients.slice(0, SAME).map((c, i) => c.saveItem(containerId, { ...opened[i], password: `pw-${i}` }, { expectedVersion: opened[i].version }))));
  const won = same.filter((r) => r.status === 'fulfilled').length;
  const conflicts = same.filter((r) => r.reason instanceof ConflictError).length;
  const other = same.length - won - conflicts;
  const history = await clients[0].history(containerId, target);
  console.log(`    gespeichert: ${won}, Konflikt gemeldet: ${conflicts}, andere Fehler: ${other}, Versionen in der Historie: ${history.length}`);
  check(other === 0, `Gleicher Eintrag: ${other} unerwartete Fehler`);
  check(won >= 1, 'Gleicher Eintrag: keine Speicherung erfolgreich');
  check(history.length >= won + 1, `Gleicher Eintrag: ${won} Speicherungen, aber nur ${history.length} Versionen – eine Fassung fehlt`);
  if (won > 1) console.log(`    Hinweis: ${won} Speicherungen kamen im selben Moment durch (Key Vault kennt kein bedingtes Schreiben); alle Fassungen stehen in der Historie.`);

  // 4b. Realistic: the same entry, opened at the same time, saved within two seconds (people, not a script).
  const target2 = created[created.length - 2];
  const opened2 = await Promise.all(clients.slice(0, SAME).map((c) => c.getItem(containerId, target2, { fresh: true })));
  const staggered = await time(`${SAME} Clients speichern denselben Eintrag innerhalb von 2 s`, () => Promise.allSettled(clients.slice(0, SAME).map(async (c, i) => {
    await new Promise((r) => setTimeout(r, Math.random() * 2000));
    return c.saveItem(containerId, { ...opened2[i], password: `pw2-${i}` }, { expectedVersion: opened2[i].version });
  })));
  const won2 = staggered.filter((r) => r.status === 'fulfilled').length;
  const conflicts2 = staggered.filter((r) => r.reason instanceof ConflictError).length;
  console.log(`    gespeichert: ${won2}, Konflikt gemeldet: ${conflicts2} (erwartet: einer speichert, die anderen bekommen den Konflikt)`);
  check(won2 + conflicts2 === SAME, `Gestaffelt: ${SAME - won2 - conflicts2} unerwartete Fehler`);

  // 5. After the changes every client reconciles: how often is the shared index written?
  const idxBefore = backend.stats.indexPuts;
  await time(`${CLIENTS} Clients gleichen ab und schreiben den Index`, async () => {
    // Like the app: the reconcile schedules the index write with delay + jitter; wait until all timers ran.
    await Promise.all(clients.map((c) => c.refreshIndex()));
    await new Promise((r) => setTimeout(r, 23_000));
  });
  const writers = clients.filter((c) => (c.indexWrites || 0) > 0).length;
  console.log(`    Index-Schreibvorgänge (Secrets): ${backend.stats.indexPuts - idxBefore}, schreibende Clients: ${writers} von ${CLIENTS}`);
  const after = await Promise.all(clients.map(async (c) => { await c.refreshIndexFast(); return mine(await c.summaries()); }));
  check(after.every((n) => n === ENTRIES), `Nach dem Abgleich sehen Clients ${[...new Set(after)].join('/')} statt ${ENTRIES} Einträge`);
} finally {
  if (realVault && created.length) {
    console.log(`  Aufräumen: ${created.length} Test-Einträge löschen …`);
    for (const id of created) await clients[0].deleteItem(containerId, id).catch(() => {});
    // Leave the vault's shared index without the test entries (a pending, delayed write would be lost on exit).
    await clients[0].refreshIndex([containerId]).catch(() => {});
    await clients[0].writeFastIndex(containerId).catch(() => {});
  }
}
console.log(`  gesamt: ${backend.stats.requests} Anfragen, ${backend.stats.puts} Schreibvorgänge, ${backend.stats.throttled} gedrosselt`);
console.log(failures.length ? `LOADTEST FAIL\n${failures.join('\n')}` : 'LOADTEST OK');
process.exit(failures.length ? 1 : 0);
