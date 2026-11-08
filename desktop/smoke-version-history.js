// Smoke check of the version history in the detail view (#450): "Last edited" at the foot unfolds into a timeline with
// "Added", an older version opens read-only with its password hidden, and "Show earlier versions" reveals the rest.
// Part of the feature checks (desktop/smoke-features.js), which have reached their size limit.

import { until } from './smoke-wait.js';

export async function versionHistoryCheck(ctx) {
  const { js, sleep, fail, save, openItem } = ctx;
  const first = await save({ type: 'login', title: 'Smoke Verlauf', username: 'verlauf', password: 'Alt-Passwort-1' });
  // Five more saves: more versions than the first three shown, so "Show earlier versions" has something to show.
  let item = first;
  for (let i = 2; i <= 6; i++) item = await save({ ...item, id: first.id, password: `Alt-Passwort-${i}` });
  await openItem('Smoke Verlauf');
  try {
    const toggle = '.detail-pane .version-history .version-toggle';
    if (!(await until(() => js(`!!document.querySelector(${JSON.stringify(toggle)})`), 4000))) return fail('no "Last edited" toggle at the foot of the entry');
    if (await js('!document.querySelector(".detail-pane .version-timeline").hidden')) fail('the timeline is open before the click');
    await js(`document.querySelector(${JSON.stringify(toggle)}).click(); true`);
    if (!(await until(() => js('!!document.querySelector(".detail-pane .timeline .timeline-row")'), 4000))) return fail('the timeline did not load');
    const rows = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll(".detail-pane .timeline .timeline-row")].map((r) => ({ kind: r.dataset.kind, hidden: r.hidden, text: r.textContent })))`));
    if (rows[0]?.kind !== 'current') fail(`first row is not the current version: ${JSON.stringify(rows[0])}`);
    if (!rows.some((r) => r.kind === 'added')) fail('no "Added" row');
    if (!rows.some((r) => r.hidden)) fail('older versions are not folded away');
    if (rows.some((r) => /Alt-Passwort/.test(r.text))) fail('a password is shown in the timeline');
    if (!(await js('!!document.querySelector(".detail-pane .version-more")'))) return fail('no "Show earlier versions" button');
    await js('document.querySelector(".detail-pane .version-more").click(); true');
    if (await js('[...document.querySelectorAll(".detail-pane .timeline .timeline-row")].some((r) => r.hidden)')) fail('"Show earlier versions" left versions folded');
    // An older version opens read-only: password hidden, restore offered.
    await js('document.querySelector(".detail-pane .timeline-row[data-kind=version] .timeline-open").click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open] .item-detail")'), 4000))) return fail('older version did not open');
    const view = JSON.parse(await js(`JSON.stringify({ text: document.querySelector("dialog[open]").innerText, restore: [...document.querySelectorAll("dialog[open] .modal-footer .btn")].some((b) => /wiederherstellen|Restore/.test(b.textContent)) })`));
    if (/Alt-Passwort-\d/.test(view.text)) fail('the password of the older version is visible without "show"');
    if (!view.restore) fail('no "Restore this version" in the older version');
    await js('document.querySelector("dialog[open]")?.close(); true');
    await sleep(200);
  } finally {
    await js('document.querySelector("dialog[open]")?.close(); true');
  }
}
