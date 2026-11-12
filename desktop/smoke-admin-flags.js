// Smoke check (#487): the admin flags of a login ("Microsoft-Admin-Konto", "Sophos-Login") are in the editor only in
// admin mode. Without it the boxes are missing, and saving – in the editor and through the main process – keeps the
// stored values. With admin mode the boxes are there and change the flag. Part of the feature checks (smoke-features.js).

import { until } from './smoke-wait.js';

export async function adminFlagsCheck(ctx) {
  const { js, sleep, fail, save, openItem, getItem, byTitle, api, containerId, setAdmin, isAdmin } = ctx;
  const boxes = 'JSON.stringify({ form: !!document.querySelector(".detail-pane .item-form"), msAdmin: !!document.querySelector(".detail-pane .item-form input[name=msAdmin]"), sophos: !!document.querySelector(".detail-pane .item-form input[name=sophos]") })';
  const edit = async () => {
    await js('document.querySelector(".detail-pane .item-hover-menu")?.click(); true');
    await sleep(300);
    await js('document.querySelector(".context-menu [data-action=edit]")?.click(); true');
    return until(() => js('!!document.querySelector(".detail-pane .item-form")'), 4000);
  };
  const submit = async () => {
    await js('document.querySelector(".detail-pane .item-form")?.requestSubmit(); true');
    return until(() => js('!document.querySelector(".detail-pane .item-form")'), 5000);
  };
  const saved = await save({ type: 'login', title: 'Smoke Admin-Flag', username: 'admin@contoso.onmicrosoft.com', password: 'Adm-Pass-1', msAdmin: true, urls: ['https://admin.microsoft.com'] });
  try {
    if (isAdmin()) await setAdmin(false);
    await openItem('Smoke Admin-Flag');
    if (!(await edit())) return fail('the editor did not open');
    const off = JSON.parse(await js(boxes));
    if (off.msAdmin || off.sophos) fail(`without admin mode the editor shows admin flags: ${JSON.stringify(off)}`);
    await js('(() => { const i = document.querySelector(".detail-pane .item-form input[name=username]"); i.value = "admin2@contoso.onmicrosoft.com"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    if (!(await submit())) return fail('saving without admin mode did not return to the detail view');
    let stored = await getItem(saved.id);
    if (stored.username !== 'admin2@contoso.onmicrosoft.com') fail('the edit without admin mode was not saved');
    if (!stored.msAdmin) fail('saving in the editor without admin mode cleared the Microsoft admin flag');

    // Main process: a save without admin mode that tries to change the flags keeps the stored values.
    await api.save(containerId, { ...stored, msAdmin: false, sophos: true }, stored.version);
    stored = await getItem(saved.id);
    if (!stored.msAdmin || stored.sophos) fail(`the main process changed admin flags without admin mode: ${JSON.stringify({ msAdmin: stored.msAdmin, sophos: stored.sophos })}`);

    await setAdmin(true);
    await openItem('Smoke Admin-Flag');
    if (!(await edit())) return fail('the editor did not open in admin mode');
    const on = JSON.parse(await js(boxes));
    if (!on.msAdmin || !on.sophos) fail(`in admin mode the editor lacks admin flags: ${JSON.stringify(on)}`);
    if (await js('document.querySelector(".detail-pane .item-form input[name=msAdmin]")?.checked !== true')) fail('admin mode: the stored Microsoft admin flag is not ticked');
    await js('(() => { const b = document.querySelector(".detail-pane .item-form input[name=msAdmin]"); b.checked = false; b.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    if (!(await submit())) return fail('saving in admin mode did not return to the detail view');
    stored = await getItem(saved.id);
    if (stored.msAdmin) fail('in admin mode the Microsoft admin flag could not be cleared');

    // Lucas, 2026-11-10: server entries are edited only in admin mode. In it the server can be edited; outside it the
    // same entry is shown without "Bearbeiten"/"Duplizieren", and the main process keeps its server data.
    const server = await save({ type: 'server', title: 'Smoke Server 487', username: 'srv-admin', password: 'Srv-Pass-1', server: { kind: 'windows', host: 'srv487.contoso.local' } });
    await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=devices]")?.click(); true');
    await sleep(400);
    await openItem('Smoke Server 487');
    const menuActions = async () => {
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".detail-pane .item-hover-menu")?.click(); true');
      await sleep(300);
      const a = await js('[...document.querySelectorAll(".context-menu [data-action]")].map((b) => b.dataset.action).join(",")');
      await js('document.querySelector(".context-menu")?.remove(); true');
      return String(a).split(',');
    };
    const inAdmin = await menuActions();
    if (!inAdmin.includes('edit')) fail(`admin mode: server entry cannot be edited (${inAdmin.join(',')})`);
    await setAdmin(false);
    await sleep(500);
    if (await js('/Smoke Server 487/.test(document.querySelector(".detail-pane")?.textContent || "")')) {
      const outside = await menuActions();
      if (outside.includes('edit') || outside.includes('duplicate')) fail(`without admin mode the server entry offers ${outside.join(',')}`);
    }
    let srv = await getItem(server.id);
    await api.save(containerId, { ...srv, type: 'login', title: 'Smoke Server 487b', favorite: true, server: { kind: 'windows', host: 'evil.example.com' }, password: 'changed' }, srv.version);
    srv = await getItem(server.id);
    if (srv.type !== 'server' || srv.server?.host !== 'srv487.contoso.local' || srv.password !== 'Srv-Pass-1') fail(`without admin mode the main process changed the server: ${JSON.stringify({ type: srv.type, host: srv.server?.host })}`);
    if (srv.title !== 'Smoke Server 487b' || !srv.favorite) fail('without admin mode title/favourite of a server entry were not saved');
    let refused = false;
    await api.save(containerId, { type: 'server', title: 'Smoke Server neu', server: { kind: 'windows', host: 'x.contoso.local' } }).catch(() => { refused = true; });
    if (!refused) fail('without admin mode a new server entry was created');

    // Review #487: an import file sets no admin flags outside admin mode.
    await api.importItems(containerId, [{ type: 'login', title: 'Smoke Import 487', username: 'imp', password: 'Imp-Pass-1', msAdmin: true, sophos: true }]);
    const imp = await byTitle('Smoke Import 487');
    const impItem = imp ? await getItem(imp.id) : null;
    if (!impItem) fail('the import outside admin mode saved nothing');
    else if (impItem.msAdmin || impItem.sophos) fail(`the import outside admin mode set admin flags: ${JSON.stringify({ msAdmin: impItem.msAdmin, sophos: impItem.sophos })}`);
    if (impItem) await api.delete(containerId, impItem.id).catch(() => {});
  } finally {
    if (isAdmin()) await setAdmin(false);
  }
}
