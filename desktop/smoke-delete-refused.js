// Smoke check of a refused deletion (#407): a login still used by an asset may not be deleted, and the person is told why.
// Through the context menu the refusal used to vanish, the entry just stayed in the list; the multi-selection dropped the
// reason. Part of the feature checks (desktop/smoke-features.js), which have reached their size limit.

import { until } from './smoke-wait.js';
import { internalSecretsCheck } from './smoke-internal-secrets.js';

const AREA = 'deleterefused';
const ASSET = 'Smoke Linked Asset';
const LOGIN = 'Smoke Linked';
const SPARE = 'Smoke Spare';

export async function deleteRefusedCheck({ js, fail, vault, changed, kvc }) {
  await internalSecretsCheck({ fail, vault, kvc });
  const row = (title) => `[...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === ${JSON.stringify(title)})`;
  const present = async (id) => (await vault.summaries()).some((x) => x.containerId === kvc.id && x.id === id);
  const clearToast = () => js('document.getElementById("toast")?.classList.remove("show"); true');
  const errorToast = () => js('(() => { const el = document.getElementById("toast"); return el?.classList.contains("show") && el.classList.contains("error") ? el.textContent : ""; })()');
  const contextMenu = (element, action) => until(async () => {
    await js(`document.querySelector(".context-menu")?.remove(); ${element}?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); true`);
    return js(`!!document.querySelector(".context-menu [data-action=${action}]")`);
  }, 2000);
  const choose = async (action) => {
    await js(`document.querySelector(".context-menu [data-action=${action}]")?.click(); true`);
    await until(() => js('!!document.querySelector("dialog[open] .modal-footer .btn.danger")'), 3000);
    await js('document.querySelector("dialog[open] .modal-footer .btn.danger")?.click(); true');
  };

  const login = await vault.saveItem(kvc.id, { type: 'login', title: LOGIN, username: 'linked', password: 'Linked-1' });
  const spare = await vault.saveItem(kvc.id, { type: 'login', title: SPARE, username: 'spare', password: 'Spare-1' });
  const asset = await vault.saveItem(kvc.id, { type: 'server', title: ASSET, server: { kind: 'windows', host: '10.9.0.7', rdpLink: `${kvc.id}/${login.id}` } });
  changed();
  try {
    await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click(); document.querySelector(".folder-crumb .icon-btn")?.click(); window.dispatchEvent(new Event("kvpwsafe-refresh")); true`);
    if (!(await until(() => js(`!!${row(LOGIN)} && !!${row(SPARE)}`), 10000))) {
      const rows = await js('[...document.querySelectorAll(".list li.row-item .row-title")].map((e) => e.firstChild?.textContent).join("|").slice(0, 300)');
      return fail(AREA, `the entries are not in the list (rows: ${rows}; search: "${await js('document.getElementById("search")?.value')}")`);
    }

    // Context menu: the message says what uses it, the entry stays.
    await clearToast();
    if (!(await contextMenu(row(LOGIN), 'delete'))) return fail(AREA, 'context menu without "Delete"');
    await choose('delete');
    const single = await until(errorToast, 3000);
    if (!single.includes(ASSET)) fail(AREA, `context menu: no message naming the asset ("${single}")`);
    if (!(await present(login.id)) || !(await js(`!!${row(LOGIN)}`))) fail(AREA, 'context menu: the linked login is gone');

    // Multi-selection: the free entry goes, the linked one stays, and the message gives the reason, not only a number.
    await js(`${row(LOGIN)}?.click(); true`);
    await js(`${row(SPARE)}?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); true`);
    const selected = await until(async () => (await js('document.querySelectorAll(".list li.row-item.multi").length')) === 2, 2000);
    // Anything else selected would be deleted with them.
    if (!selected) return fail(AREA, 'multi-selection: not exactly the two entries selected');
    await clearToast();
    if (!(await contextMenu('document.querySelector(".list li.row-item.multi")', 'multi-delete'))) return fail(AREA, 'context menu without the multi deletion');
    await choose('multi-delete');
    const many = await until(errorToast, 5000);
    if (!many.includes(ASSET)) fail(AREA, `multi-selection: no reason in the message ("${many}")`);
    if (!(await present(login.id))) fail(AREA, 'multi-selection: the linked login is gone');
    if (await present(spare.id)) fail(AREA, 'multi-selection: the free entry was not deleted');
  } finally {
    for (const id of [asset.id, login.id, spare.id]) await vault.deleteItem(kvc.id, id).catch(() => {});
    changed();
    await clearToast();
  }
  return undefined;
}

export { folderFirstCheck } from './smoke-folder-order.js';
export { renameCheck } from './smoke-rename.js';
export { vaultProfileCheck } from './smoke-vault-profile.js';
