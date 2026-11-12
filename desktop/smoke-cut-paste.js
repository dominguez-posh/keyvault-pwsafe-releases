// Smoke check of cut and paste (#467) and of the plan question on the paste / drag way (#462): Ctrl+X marks an entry
// (not while typing in a field), "Paste" in the vault's menu names the number and moves it; an entry with a linked
// asset asks first (dialog) and takes the asset along. Part of the feature checks (desktop/smoke-features.js).

import { until } from './smoke-wait.js';
import { secondVault } from './smoke-second-vault.js';

const AREA = 'cutpaste';
const SOLO = 'Smoke Cut Solo';
const LOGIN = 'Smoke Cut Login';
const ASSET = 'Smoke Cut Asset';

export async function cutPasteCheck({ js, fail, vault, api, changed, kvc }) {
  const second = await secondVault({ vault, api, kvc });
  try {
    return await cutPaste({ js, fail, vault, changed, kvc, target: second.target, seen: second.seen });
  } finally {
    await second.done();
  }
}

async function cutPaste({ js, fail, vault, changed, kvc, target, seen }) {
  if (!target) return fail(AREA, `no second vault with write access in the demo: ${JSON.stringify(seen)}`);
  const row = (title) => `[...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === ${JSON.stringify(title)})`;
  const inVault = async (id, title) => (await vault.summaries()).find((x) => x.containerId === id && x.title === title);
  // Sends a key to the focused element; → whether the window took it over (preventDefault).
  const key = (name, ctrlKey = true) => js(`(() => { const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true }); (document.activeElement || document.body).dispatchEvent(e); return e.defaultPrevented; })()`);
  // The vault rows by id, not by name: a full run has two vaults named "Persönlich" (the demo Key Vault and the personal
  // vault of the personal flow), and the personal one rightly refuses entries from a shared vault.
  const navRow = (id) => `document.querySelector(${JSON.stringify(`.sidebar .nav-row[data-vault="${id}"]`)})`;
  const navMenu = (action) => until(async () => {
    await js(`document.querySelector(".context-menu")?.remove(); ${navRow(target.id)}?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 200 })); true`);
    return js(`!!document.querySelector(".context-menu [data-action=${action}]")`);
  }, 2000);
  const ids = [];
  const solo = await vault.saveItem(kvc.id, { type: 'login', title: SOLO, username: 'cut', password: 'Cut-1' });
  const login = await vault.saveItem(kvc.id, { type: 'login', title: LOGIN, username: 'cut2', password: 'Cut-2' });
  const asset = await vault.saveItem(kvc.id, { type: 'server', title: ASSET, server: { kind: 'windows', host: '10.9.0.31', rdpLink: `${kvc.id}/${login.id}` } });
  changed();
  try {
    // The source vault at its top level: an earlier area may have left a folder open (the entries are at the root).
    await js(`${navRow(kvc.id)}?.querySelector(".nav")?.click(); for (let i = 0; i < 4; i++) document.querySelector(".folder-crumb .icon-btn")?.click(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true`);
    if (!(await until(() => js(`!!${row(SOLO)}`), 10000))) return fail(AREA, `the entry is not in the list (${await js('JSON.stringify({ folder: document.querySelector(".folder-crumb")?.textContent, rows: [...document.querySelectorAll(".list li.row-item")].map((r) => r.querySelector(".row-title")?.textContent).slice(0, 15) })')})`);
    if (await navMenu('paste')) fail(AREA, '"Paste" is offered although nothing is marked');

    // In a field Ctrl+X stays text cutting: not taken over, nothing marked.
    await js('document.getElementById("search")?.focus(); true');
    if (await key('x')) fail(AREA, 'Ctrl+X in the search field was taken over');
    if (await js('!!document.querySelector(".list li.row-item.cut")')) fail(AREA, 'an entry was marked while typing in a field');
    await js('document.activeElement?.blur(); true');

    // Cut: the entry looks cut, Esc cancels.
    await js(`${row(SOLO)}?.click(); true`);
    if (!(await key('x'))) fail(AREA, 'Ctrl+X on an entry was not handled');
    if (!(await until(() => js(`!!${row(SOLO)}?.classList.contains("cut")`), 2000))) fail(AREA, 'the marked entry does not look cut');
    await key('Escape', false);
    if (await js('!!document.querySelector(".list li.row-item.cut")')) fail(AREA, 'Esc did not clear the mark');

    // Cut again, paste through the vault's menu (names the number): arrives there, gone from the source.
    await js(`${row(SOLO)}?.click(); true`);
    await key('x');
    if (!(await navMenu('paste'))) return fail(AREA, 'no "Paste" in the vault menu after cutting');
    const label = await js('document.querySelector(".context-menu [data-action=paste]").textContent');
    if (!/\b1\b/.test(label)) fail(AREA, `the paste entry does not name the number: ${label}`);
    await js('document.querySelector(".context-menu [data-action=paste]").click(); true');
    if (!(await until(async () => !!(await inVault(target.id, SOLO)), 8000))) return fail(AREA, `the pasted entry did not arrive in the target (toast: ${await js('document.getElementById("toast")?.textContent')})`);
    ids.push((await inVault(target.id, SOLO)).id);
    if (!(await until(async () => !(await inVault(kvc.id, SOLO)), 8000))) fail(AREA, 'the entry is still in the source after pasting');
    if (await navMenu('paste')) fail(AREA, '"Paste" still offered after pasting');

    // An entry with a linked asset: the paste asks first and takes the asset along (the same way as dragging).
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    await until(() => js(`!!${row(LOGIN)}`), 8000);
    await js(`${row(LOGIN)}?.click(); true`);
    await key('x');
    await navMenu('paste');
    await js('document.querySelector(".context-menu [data-action=paste]")?.click(); true');
    if (!(await until(() => js('!!document.querySelector("dialog[open]")'), 6000))) return fail(AREA, 'no question about the linked asset');
    const text = await js('document.querySelector("dialog[open]").innerText');
    if (!text.includes(ASSET)) fail(AREA, `the question does not name the asset: ${text.slice(0, 200)}`);
    await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); true');
    // The move copies first and deletes the originals last (#526: judged in the middle of it in a slow full run).
    const settled = async () => !!(await inVault(target.id, LOGIN)) && !!(await inVault(target.id, ASSET)) && !(await inVault(kvc.id, LOGIN)) && !(await inVault(kvc.id, ASSET));
    if (!(await until(settled, 20000))) fail(AREA, 'login and asset did not both arrive');
    for (const title of [LOGIN, ASSET]) {
      const there = await inVault(target.id, title);
      if (there) ids.push(there.id);
      if (await inVault(kvc.id, title)) fail(AREA, `"${title}" is still in the source`);
    }
  } finally {
    // The asset before the login it uses (a login in use cannot be deleted): a login left behind filled the demo vault
    // up to its 10 entries without a license, and "devices" could not save its entries after a failed run here.
    for (const id of [asset.id, login.id, solo.id]) await vault.deleteItem(kvc.id, id).catch(() => {});
    for (const id of [...ids].reverse()) await vault.deleteItem(target.id, id).catch(() => {});
    changed();
  }
  return undefined;
}
