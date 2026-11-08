// Smoke check of moving an entry with its linked assets (#452): the move dialog lists the assets that move along, a
// ticked box moves all of them with valid links, an unticked one moves only the entry (refused while assets use it),
// and a vault without write access is told up front. Part of the feature checks (desktop/smoke-features.js, at its size limit).

import { until } from './smoke-wait.js';
import { secondVault } from './smoke-second-vault.js';

const AREA = 'moveassets';
const LOGIN = 'Smoke Move Login';
const ASSET1 = 'Smoke Move Asset 1';
const ASSET2 = 'Smoke Move Asset 2';

export async function moveAssetsCheck({ js, fail, vault, api, changed, kvc }) {
  const second = await secondVault({ vault, api, kvc });
  try {
    return await moveAssets({ js, fail, vault, changed, kvc, target: second.target, seen: second.seen });
  } finally {
    await second.done();
  }
}

async function moveAssets({ js, fail, vault, changed, kvc, target, seen }) {
  if (!target) return fail(AREA, `no second vault with write access in the demo: ${JSON.stringify(seen)}`);
  const row = (title) => `[...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === ${JSON.stringify(title)})`;
  // "Move" sits in the entry's "⋯" menu (the list's right-click menu offers "Cut" instead, #467).
  const entryMenu = (title, action) => until(async () => {
    await js(`document.querySelector(".context-menu")?.remove(); ${row(title)}?.click(); true`);
    if (!(await js(`(document.querySelector(".detail-pane")?.textContent || "").includes(${JSON.stringify(title)})`))) return false;
    await js('document.querySelector(".detail-pane .item-hover-menu")?.click(); true');
    return js(`!!document.querySelector(".context-menu [data-action=${action}]")`);
  }, 4000);
  const inVault = async (id, title) => (await vault.summaries()).find((x) => x.containerId === id && x.title === title);
  const ids = [];

  const login = await vault.saveItem(kvc.id, { type: 'login', title: LOGIN, username: 'mover', password: 'Move-1' });
  const a1 = await vault.saveItem(kvc.id, { type: 'server', title: ASSET1, server: { kind: 'windows', host: '10.9.0.21', rdpLink: `${kvc.id}/${login.id}` } });
  const a2 = await vault.saveItem(kvc.id, { type: 'server', title: ASSET2, server: { kind: 'windows', host: '10.9.0.22', rdpLink: `${kvc.id}/${login.id}` } });
  changed();
  try {
    await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click(); document.querySelector(".folder-crumb .icon-btn")?.click(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true`);
    if (!(await until(() => js(`!!${row(LOGIN)}`), 10000))) return fail(AREA, 'the login is not in the list');

    // The dialog lists the two assets and offers to move them along (ticked by default).
    if (!(await entryMenu(LOGIN, 'move'))) return fail(AREA, 'the entry\'s "⋯" menu has no "Move"');
    await js('document.querySelector(".context-menu [data-action=move]")?.click(); true');
    await until(() => js('!!document.querySelector("dialog[open] select")'), 3000);
    await js(`(() => { const s = document.querySelector("dialog[open] select"); s.value = ${JSON.stringify(target.id)}; s.dispatchEvent(new Event("change")); })()`);
    const listed = await until(async () => (await js('document.querySelectorAll("dialog[open] .move-plan-row").length')) === 2, 5000);
    if (!listed) return fail(AREA, `the dialog does not list the two linked assets (${await js('document.querySelector("dialog[open] .move-plan")?.innerText.slice(0, 200)')})`);
    const text = await js('document.querySelector("dialog[open] .move-plan").innerText');
    if (!text.includes(ASSET1) || !text.includes(ASSET2)) fail(AREA, `assets missing in the list: ${text}`);
    const dialogText = await js('document.querySelector("dialog[open]").innerText');
    if (!/Passkeys wandern mit/.test(dialogText) && !/Passkeys move along/.test(dialogText)) fail(AREA, 'the dialog does not say that passkeys move along and the history stays');
    if (!(await js('document.querySelector("dialog[open] input[name=moveAssets]")?.checked'))) fail(AREA, 'the box "move linked assets" is not ticked by default');

    // Unticked: only the login moves, and it is refused because assets still use it – nothing changes.
    await js('document.querySelector("dialog[open] input[name=moveAssets]").click(); document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); true');
    await until(() => js('!!document.getElementById("toast")?.classList.contains("error")'), 4000);
    if (!(await inVault(kvc.id, LOGIN)) || await inVault(target.id, LOGIN)) fail(AREA, 'unticked: the login moved although assets use it');

    // Ticked: all three arrive in the target, the source has none of them, the links are valid there.
    await js('document.querySelector("dialog[open] input[name=moveAssets]").click(); document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); true');
    const moved = await until(async () => !!(await inVault(target.id, LOGIN)), 8000);
    if (!moved) return fail(AREA, 'the login did not arrive in the target vault');
    for (const title of [LOGIN, ASSET1, ASSET2]) {
      const there = await inVault(target.id, title);
      if (!there) fail(AREA, `"${title}" is not in the target vault`);
      else ids.push(there.id);
      if (await inVault(kvc.id, title)) fail(AREA, `"${title}" is still in the source vault`);
    }
    const newLogin = await inVault(target.id, LOGIN);
    const users = newLogin ? await vault.linkedEntries(target.id, newLogin.id) : [];
    if (users.map((u) => u.title).sort().join() !== `${ASSET1},${ASSET2}`) fail(AREA, `links after the move: ${JSON.stringify(users)}`);
    if (!users.every((u) => u.uses.includes('rdp'))) fail(AREA, 'an RDP link got lost');
  } finally {
    for (const id of [a1.id, a2.id, login.id]) await vault.deleteItem(kvc.id, id).catch(() => {});
    for (const id of [...ids].reverse()) await vault.deleteItem(target.id, id).catch(() => {});
    changed();
  }
  return undefined;
}
