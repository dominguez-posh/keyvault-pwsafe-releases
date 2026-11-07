// Smoke check of deleting during a refresh (#408): the entry stays gone from the list and no copy of it stays readable. The
// timing itself is pinned down in test/delete-race.test.js; here it runs through the app's session and list. Part of the
// feature checks (desktop/smoke-features.js), which have reached their size limit.

import { until } from './smoke-wait.js';

const AREA = 'deleterace';
const TITLE = 'Smoke Delete Race';
const ROW = `[...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === ${JSON.stringify(TITLE)})`;

export async function deleteRaceCheck({ js, fail, vault, changed, kvc }) {
  const saved = await vault.saveItem(kvc.id, { type: 'login', title: TITLE, username: 'race', password: 'Race-1' });
  changed();
  await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click(); document.querySelector(".folder-crumb .icon-btn")?.click(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true`);
  if (!(await until(() => js(`!!${ROW}`), 10000))) {
    const rows = await js('[...document.querySelectorAll(".list li.row-item .row-title")].map((e) => e.firstChild?.textContent).join("|").slice(0, 300)');
    fail(AREA, `the entry is not in the list (rows: ${rows}; search: "${await js('document.getElementById("search")?.value')}")`);
  }

  const reading = vault.getItem(kvc.id, saved.id, { fresh: true }).catch(() => null);
  const refreshing = vault.refreshIndexFast([kvc.id]);
  await vault.deleteItem(kvc.id, saved.id);
  await Promise.all([reading, refreshing]);
  changed();
  if ((await vault.summaries({ maxAgeMs: Infinity })).some((x) => x.id === saved.id)) fail(AREA, 'the deleted entry came back into the index');
  if (!(await until(() => js(`!${ROW}`), 5000))) fail(AREA, 'the deleted entry stays in the list');
  if (await vault.store.get(`item:${kvc.id}/${saved.id}`)) fail(AREA, 'a copy of the deleted entry stays in the cache');
  if (await vault.getItem(kvc.id, saved.id).then(() => true, () => false)) fail(AREA, 'the deleted entry can still be read');
}
