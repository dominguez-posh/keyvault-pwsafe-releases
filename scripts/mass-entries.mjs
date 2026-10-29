// Mass test against a real Key Vault (scaling checks). Token from KV_TOKEN, never printed:
//   KV_TOKEN=$(az account get-access-token --resource https://vault.azure.net --query accessToken -o tsv)
//   node scripts/mass-entries.mjs <vaultUrl> seed <count>   writes <count> entries in folder "Massentest" (app format)
//   node scripts/mass-entries.mjs <vaultUrl> measure        index build / search / open / save timings through VaultSession
//   node scripts/mass-entries.mjs <vaultUrl> fast           listing vs. start through the index secrets (writes the index!)
//   node scripts/mass-entries.mjs <vaultUrl> delete         soft-deletes the Massentest entries (then tries to purge them)
// Only ever against a test vault: seed/fast write into the vault, delete removes everything named pws-mass*.
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { serializeItem } from '../extension/core/model.js';
import { mapLimit } from '../extension/core/util.js';

const [vaultUrl, mode, countArg] = process.argv.slice(2);
const token = process.env.KV_TOKEN;
if (!vaultUrl || !token) throw new Error('vaultUrl und KV_TOKEN nötig');
const base = vaultUrl.replace(/\/$/, '');
const FOLDER = 'Massentest';
const PREFIX = 'pws-mass';
const api = '7.5';
let requests = 0;
let throttled = 0;
const kv = async (method, path, body) => {
  for (let attempt = 0; ; attempt++) {
    requests++;
    // nextLink pages come as complete URLs (already with api-version and $skiptoken).
    const res = await fetch(path.startsWith('http') ? path : `${base}${path}${path.includes('?') ? '&' : '?'}api-version=${api}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // Key Vault throttles bursts (429 "VaultRequestTypeLimitReached"): back off as the service asks.
    if (res.status === 429 && attempt < 10) {
      throttled++;
      const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(30_000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : null;
  }
};
const massNames = async () => {
  const names = [];
  let url = `/secrets?maxresults=25`;
  while (url) {
    const page = await kv('GET', url);
    for (const s of page.value || []) {
      const n = s.id.split('/').pop();
      if (n.startsWith(PREFIX)) names.push(n);
    }
    url = page.nextLink || null;
  }
  return names;
};

const t0 = performance.now();
if (mode === 'seed') {
  const count = Number(countArg || 2000);
  const existing = new Set(await massNames());
  const todo = [];
  for (let i = 0; i < count; i++) {
    const name = `${PREFIX}${String(i).padStart(5, '0')}`;
    if (!existing.has(name)) todo.push([i, name]);
  }
  console.log(`${existing.size} vorhanden, ${todo.length} anzulegen …`);
  let done = 0;
  await mapLimit(todo, 8, async ([i, name]) => {
    const { value, tags, contentType } = serializeItem({
      type: 'login', title: `Massentest Server ${String(i).padStart(4, '0')}`, username: `svc-${i}@contoso.example`,
      password: `Test-${i}-${Math.random().toString(36).slice(2, 14)}`, urls: [`https://host${i % 300}.massentest.example/login`],
      folder: `${FOLDER}/Kunde ${i % 40}`, notes: 'Automatisch angelegter Testeintrag – kann gelöscht werden.',
    }, 'massentest');
    await kv('PUT', `/secrets/${name}`, { value, tags, contentType });
    if (++done % 250 === 0) console.log(`  ${done}/${todo.length}`);
  });
  console.log(`fertig: ${todo.length} Einträge in ${((performance.now() - t0) / 1000).toFixed(0)} s, ${requests} Requests, ${throttled}× gedrosselt (429)`);
} else if (mode === 'measure') {
  const session = new VaultSession({ getToken: async () => token, store: new MemoryStore(), fetch, actor: () => 'massentest' });
  await session.refreshContainers({ configured: [{ name: 'pwmgr', vaultUrl: base }], discover: false });
  const [c] = await session.containers();
  const time = async (label, fn) => {
    const s = performance.now();
    const out = await fn();
    console.log(`${label.padEnd(34)} ${(performance.now() - s).toFixed(0).padStart(6)} ms`);
    return out;
  };
  await time('Index aufbauen (refreshIndex)', () => session.refreshIndex());
  const summaries = await time('summaries() aus Cache', () => session.summaries());
  console.log(`   → ${summaries.length} Einträge insgesamt, davon ${summaries.filter((x) => x.folder.startsWith(FOLDER)).length} Massentest`);
  await time('Suche "Server 19"', async () => summaries.filter((x) => /Server 19/i.test(x.title)));
  await time('matchesForHost', () => session.matchesForHost('host12.massentest.example'));
  const one = summaries.find((x) => x.folder.startsWith(FOLDER));
  const item = await time('getItem (ein Eintrag)', () => session.getItem(c.id, one.id));
  await time('saveItem (ändern + Index)', () => session.saveItem(c.id, { ...item, notes: `${item.notes} geändert` }, { expectedVersion: item.version }));
  await time('Index erneut', () => session.refreshIndex([c.id]));
} else if (mode === 'fast') {
  // Listing once (writes the index secrets), then a fresh client through the index secrets only.
  const mk = () => new VaultSession({ getToken: async () => token, store: new MemoryStore(), fetch: (u, i) => { requests++; return fetch(u, i); }, actor: () => 'massentest' });
  const a = mk();
  await a.refreshContainers({ configured: [{ name: 'pwmgr', vaultUrl: base }], discover: false });
  let s = performance.now();
  let r0 = requests;
  await a.refreshIndex();
  console.log(`Listing (voller Index)                ${(performance.now() - s).toFixed(0).padStart(6)} ms  ${requests - r0} Requests`);
  s = performance.now(); r0 = requests;
  await a.flushFastIndex();
  console.log(`Index-Secrets schreiben               ${(performance.now() - s).toFixed(0).padStart(6)} ms  ${requests - r0} Requests`);
  const b = mk();
  await b.refreshContainers({ configured: [{ name: 'pwmgr', vaultUrl: base }], discover: false });
  s = performance.now(); r0 = requests;
  const idx = await b.refreshIndexFast();
  const [c] = await b.containers();
  console.log(`Start über Index-Secrets              ${(performance.now() - s).toFixed(0).padStart(6)} ms  ${requests - r0} Requests  → ${idx[c.id].items.length} Einträge, fast=${idx[c.id].fast}`);
  const hdr = JSON.parse((await b.kv(c).getSecret('pws-index')).value);
  console.log(`   Index: ${hdr.shards} Teil(e), ${hdr.count} Einträge, erzeugt ${hdr.at} von ${hdr.by}`);
} else if (mode === 'delete') {
  const names = await massNames();
  console.log(`${names.length} Massentest-Einträge löschen …`);
  await mapLimit(names, 8, (n) => kv('DELETE', `/secrets/${n}`));
  console.log(`soft-deleted in ${((performance.now() - t0) / 1000).toFixed(0)} s – versuche zu bereinigen (purge) …`);
  let purged = 0;
  await mapLimit(names, 4, async (n) => {
    // Deleted secrets need a moment before purge works; retry a few times.
    for (let i = 0; i < 6; i++) {
      try {
        await kv('DELETE', `/deletedsecrets/${n}`);
        purged++;
        return;
      } catch (e) {
        if (/HTTP 403/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }).catch((e) => console.log(`Purge nicht möglich: ${e.message.slice(0, 120)}`));
  console.log(`bereinigt: ${purged}/${names.length} (Rest bleibt 90 Tage als gelöscht sichtbar)`);
} else {
  throw new Error('mode: seed | measure | fast | delete');
}
