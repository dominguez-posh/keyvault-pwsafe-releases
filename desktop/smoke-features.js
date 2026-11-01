// Feature checks of the smoke test (npm run smoke, demo run without --view): each recent function is used the way a
// person would – menus clicked, values copied, dialogs opened – and the result is checked. Rule (CLAUDE.md, "Prüfen"):
// every new or changed function gets a check here (or in scripts/extension-smoke.mjs) in the same commit.
//
// ctx: { js, sleep, errors, win, api, vault, config, changed, clipboardHas, signInFor, clearSignIns, copyViaHelperExe,
//        typeViaHelperExe }
// The clipboard is checked through Keevault-Update.exe (clipboardHas clears it when the text matches) – never read
// with Electron, never restored: after the run it is empty. Nothing is typed (auto-type: the helper's mode with
// empty input only).

export async function featureChecks(ctx) {
  const { js, sleep, errors, win, api, vault, config, changed, clipboardHas } = ctx;
  const fail = (area, message) => errors.push(`features/${area}: ${message}`);
  const closeDialogs = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu, .main-menu")?.remove(); true');
  // Admin mode the way a person switches it: menu → View → Admin tools.
  const setAdmin = async (on) => {
    await js('document.querySelector(".main-menu")?.remove(); document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-tab=view]")?.click()');
    await sleep(300);
    await js(`[...document.querySelectorAll('.main-menu .seg[aria-label="Admin-Werkzeuge"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(on ? 'An' : 'Aus')})?.click()`);
    await sleep(900);
    await js('document.querySelector(".main-menu")?.remove()');
    if (config.get().adminTools !== on) fail('admin', `menu switch did not set admin mode ${on ? 'on' : 'off'}`);
  };
  // Always the same demo vault (the order of unlocked vaults varies between runs); the UI is opened on it.
  const open = (await vault.containers()).filter((c) => c.kind === 'keyvault' && !c.error && !c.locked);
  const kvc = open.find((c) => c.name === 'Team Infrastruktur') || open[0];
  if (process.env.KVPWSAFE_SMOKE_DEBUG) {
    const mine = (await vault.summaries()).filter((x) => x.containerId === kvc.id);
    console.log(`[features] ${kvc.name}: ${mine.length} entries – ${mine.map((x) => x.title).join(', ')}`);
  }
  const created = [];
  const save = async (item) => {
    const saved = await vault.saveItem(kvc.id, item);
    created.push(saved.id);
    // The app learns about it like after a sync – the list shows it.
    changed();
    await sleep(500);
    return saved;
  };
  const openItem = async (title) => {
    await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
    await sleep(300);
    await js(`[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.querySelector(".row-title, .t, b")?.textContent.trim() === ${JSON.stringify(title)} || r.textContent.includes(${JSON.stringify(title)}))?.click()`);
    await sleep(600);
  };
  // Each area at most 45 s: a step that hangs is reported and the run goes on (never a smoke test without an end).
  const cleanUp = async () => {
    for (const id of created.splice(0)) await vault.deleteItem(kvc.id, id).catch(() => {});
    changed();
    await sleep(400);
  };
  const step = async (area, fn) => {
    const started = Date.now();
    try {
      await Promise.race([fn(), new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout after 45 s')), 45_000))]);
    } catch (e) {
      fail(area, e.message);
    }
    if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[features] ${area} ${Date.now() - started} ms`);
    await closeDialogs();
    await cleanUp();
  };

  try {
    await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click()`);
    await sleep(600);

    // ---- clipboard: the copy button in an entry, the helper program (history markers), auto-type helper mode
    await step('clipboard', async () => {
      const login = await save({ type: 'login', title: 'Smoke Copy', username: `copy-${Date.now()}@contoso.com`, password: 'Cp-1' });
      changed();
      await sleep(700);
      await openItem('Smoke Copy');
      await js('document.querySelector(".detail-pane .field-row .icon-btn[title=Kopieren], .detail-pane .field-row .icon-btn[title=Copy]")?.click()');
      // The copy runs through Keevault-Update.exe (a process start): wait up to 3 s for the text.
      let arrived = false;
      for (let i = 0; i < 10 && !arrived; i++) { await sleep(300); arrived = await clipboardHas(login.username); }
      if (!arrived) fail('clipboard', 'copy button in the entry did not reach the clipboard');
      if (await js('!!document.querySelector(".toast.error")')) fail('clipboard', `error toast: ${await js('document.querySelector(".toast.error")?.textContent')}`);
      const marker = `kv-smoke-${Date.now()}`;
      if (await ctx.copyViaHelperExe(marker)) {
        await sleep(100);
        if (!(await clipboardHas(marker))) fail('clipboard', 'Keevault-Update.exe --clipboard: text not on the clipboard');
      } else if (process.platform === 'win32') {
        fail('clipboard', 'Keevault-Update.exe --clipboard not available (windows/out or resources)');
      }
      // Auto-type through the helper: with empty input the mode runs and types nothing.
      if (process.platform === 'win32' && !(await ctx.typeViaHelperExe(''))) fail('autotype', 'Keevault-Update.exe --type not available');
    });

    // ---- main menu: entries open their dialogs, view switches take effect, no bottom-bar setting any more
    await step('mainmenu', async () => {
      const openMenu = async () => {
        await js('document.querySelector(".main-menu")?.remove(); document.querySelector(".menu-btn")?.click()');
        await sleep(300);
      };
      await openMenu();
      const actions = await js('[...document.querySelectorAll(".main-menu [data-action]")].map((b) => b.dataset.action).join(",")');
      for (const a of ['reload', 'settings', 'generator', 'health', 'view-reset', 'lock']) if (!String(actions).split(',').includes(a)) fail('mainmenu', `entry "${a}" missing`);
      if (await js('[...document.querySelectorAll(".main-menu .view-row, .main-menu label, .main-menu span")].some((e) => /Leiste unten|Bottom bar/.test(e.textContent))')) fail('mainmenu', 'removed "bottom bar" setting is back');
      // Two tabs: "Menu" shows the actions, "View" the view switches – never both at once.
      const tabState = () => js('JSON.stringify({ tabs: [...document.querySelectorAll(".main-menu [data-tab]")].map((b) => b.dataset.tab), settings: !!document.querySelector(".main-menu [data-action=settings]")?.offsetParent, zoom: !!document.querySelector(".main-menu .view-pane .view-row")?.offsetParent })');
      await js('document.querySelector(".main-menu [data-tab=main]")?.click()');
      let ts = JSON.parse(await tabState());
      if (ts.tabs.join() !== 'main,view') fail('mainmenu', `tabs: ${ts.tabs.join()}`);
      if (!ts.settings || ts.zoom) fail('mainmenu', 'tab "Menu" does not show only the actions');
      await js('document.querySelector(".main-menu [data-tab=view]")?.click()');
      ts = JSON.parse(await tabState());
      if (ts.settings || !ts.zoom) fail('mainmenu', 'tab "View" does not show only the view switches');
      await js('document.querySelector(".main-menu [data-tab=main]")?.click()');
      for (const { action, what } of [{ action: 'settings', what: 'settings dialog' }, { action: 'generator', what: 'password generator' }, { action: 'health', what: 'password check' }]) {
        await openMenu();
        await js(`document.querySelector(".main-menu [data-action=${action}]")?.click()`);
        await sleep(500);
        if (!(await js('!!document.querySelector("dialog[open]")'))) fail('mainmenu', `${what} did not open`);
        await closeDialogs();
        await sleep(200);
      }
      const segClick = async (label, text) => {
        await openMenu();
        await js('document.querySelector(".main-menu [data-tab=view]")?.click()');
        await js(`[...document.querySelectorAll('.main-menu .seg[aria-label="${label}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
        await sleep(400);
      };
      await segClick('Design', 'Dunkel');
      if (config.get().theme !== 'dark') fail('mainmenu', `theme not switched (${config.get().theme})`);
      await segClick('Design', 'System');
      await segClick('Transparenz', 'Stark');
      if (config.get().transparency !== 'strong') fail('mainmenu', `transparency not switched (${config.get().transparency})`);
      await segClick('Transparenz', 'Leicht');
      // Small window: the menu ends inside the window and scrolls.
      const [w, h] = win.getSize();
      win.setSize(900, 520);
      await sleep(900);
      await openMenu();
      const fits = await js('(() => { const m = document.querySelector(".main-menu"); return !!m && m.getBoundingClientRect().bottom <= innerHeight + 1 && getComputedStyle(m).overflowY === "auto"; })()');
      if (!fits) fail('mainmenu', 'menu cut off or not scrollable in a small window');
      await js('document.querySelector(".main-menu")?.remove()');
      win.setSize(w, h);
      // The resize event arrives late and closes open context menus – wait until it is through.
      await sleep(1000);
    });

    // ---- vault search: magnifier in the "Vaults" header filters the rows, Esc shows all again
    await step('vaultsearch', async () => {
      if (!(await js('!!document.querySelector(".nav-section .vault-find .icon-btn")'))) {
        fail('vaultsearch', 'magnifier in the vault header missing');
        return;
      }
      const visible = () => js('[...document.querySelectorAll(".sidebar-vaults .nav-row, .sidebar-vaults > *")].filter((r) => !r.hidden && r.offsetParent !== null).map((r) => r.textContent.trim()).join("|")');
      const all = String(await visible());
      await js('document.querySelector(".vault-find .icon-btn").click(); const q = document.querySelector(".vault-find input"); q.value = "Team-Datei"; q.dispatchEvent(new Event("input"))');
      await sleep(200);
      const hit = String(await visible());
      if (!hit.includes('Team-Datei') || hit.includes('Team Infrastruktur')) fail('vaultsearch', `filter shows: ${hit}`);
      await js('document.querySelector(".vault-find input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await sleep(200);
      if (String(await visible()) !== all) fail('vaultsearch', 'Esc did not show all vaults again');
    });

    // ---- vault order: drag a vault row before another one – the sidebar shows and keeps the new order
    await step('vaultorder', async () => {
      const names = () => js('[...document.querySelectorAll(".sidebar-vaults .nav-row .nav-label")].map((e) => e.textContent).join("|")');
      const before = String(await names()).split('|');
      if (before.length < 2) return;
      const last = before[before.length - 1];
      const r = await js(`(() => {
        const rows = [...document.querySelectorAll(".sidebar-vaults .nav-row")];
        const src = rows[rows.length - 1], dst = rows[0];
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 });
        dst.dispatchEvent(over);
        if (!over.defaultPrevented) return "first vault did not accept the dragged vault";
        dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return "ok";
      })()`);
      if (r !== 'ok') fail('vaultorder', r);
      await sleep(600);
      const after = String(await names()).split('|');
      if (after[0] !== last) fail('vaultorder', `first vault is "${after[0]}" instead of "${last}"`);
      if (!(config.get().containerOrder || []).length) fail('vaultorder', 'order not stored');
      config.update({ containerOrder: [] });
      changed();
      // Let the redraw finish – it would close the menus opened by the next step.
      await sleep(1500);
    });

    // ---- "New" menu and templates; no devices without admin mode
    const newMenu = async () => {
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".new-split .new-more")?.click()');
      await sleep(300);
      return String(await js('[...document.querySelectorAll(".context-menu [data-action]")].map((b) => b.dataset.action).join(",")')).split(',');
    };
    const cancelEditor = async () => {
      await js('[...document.querySelectorAll(".detail-pane button")].find((b) => /^(Abbrechen|Cancel)$/.test(b.textContent.trim()))?.click()');
      await sleep(300);
    };
    await step('newmenu', async () => {
      const items = await newMenu();
      for (const a of ['new-login', 'new-note', 'new-card', 'new-certificate', 'new-microsoft', 'new-ad']) if (!items.includes(a)) fail('newmenu', `"${a}" missing`);
      if (items.includes('new-server')) fail('newmenu', 'devices can be created without admin mode');
      // Open and click in one go: a redraw in between would close the menu.
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".new-split .new-more")?.click(); document.querySelector(".context-menu [data-action=new-microsoft]")?.click()');
      await sleep(500);
      const ms = await js('JSON.stringify({ urls: document.querySelector(".detail-pane textarea[name=urls]")?.value || "", logo: !!document.querySelector(".detail-pane img"), fields: [...document.querySelectorAll(".detail-pane .custom-field input")].map((i) => i.value).join("|") })');
      const m = JSON.parse(ms || '{}');
      if (!/login\.microsoft\.com/.test(m.urls) || !/login\.microsoftonline\.com/.test(m.urls)) fail('templates', `Microsoft login without sign-in addresses (${m.urls})`);
      if (!m.logo) fail('templates', 'Microsoft login without logo');
      if (!/Mandanten-ID|Tenant ID/.test(m.fields)) fail('templates', `Microsoft login fields: ${m.fields}`);
      await cancelEditor();
      await newMenu();
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".new-split .new-more")?.click(); document.querySelector(".context-menu [data-action=new-ad]")?.click()');
      await sleep(500);
      const ad = await js('[...document.querySelectorAll(".detail-pane .custom-field input")].map((i) => i.value).join("|")');
      if (!/Domänencontroller|Domain controller/.test(ad)) fail('templates', `AD logon fields: ${ad}`);
      await cancelEditor();
    });

    // ---- list: right-click on the empty area, entry without the removed bottom toolbar
    await step('list', async () => {
      await save({ type: 'login', title: 'Smoke Copy', username: 'list@contoso.com', password: 'x' });
      changed();
      await sleep(600);
      await js('(() => { const el = document.querySelector(".list-pane .list-scroll"); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.bottom - 20 })); })()');
      await sleep(300);
      if (!(await js('!!document.querySelector(".context-menu [data-action=new-login]")'))) fail('list', 'right-click on the empty list area offers no "New"');
      await js('document.querySelector(".context-menu")?.remove()');
      await openItem('Smoke Copy');
      if (await js('!!document.querySelector(".detail-pane .item-tools")')) fail('list', 'bottom toolbar is back in the entry');
      await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
      await sleep(300);
      if (!(await js('!!document.querySelector(".context-menu [data-action=edit]")'))) fail('list', '"⋯" menu without "Edit"');
    });

    // ---- folders: drag a folder onto another one – it moves in with its entries; never into itself
    await step('folderdrag', async () => {
      await save({ type: 'login', title: 'Smoke in A', username: 'a', password: 'x', folder: 'Smoke A' });
      await save({ type: 'login', title: 'Smoke in B', username: 'b', password: 'x', folder: 'Smoke B' });
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      await sleep(400);
      const drag = (from, to) => js(`(() => {
        const rows = [...document.querySelectorAll(".list .folder-row")];
        const src = rows.find((r) => r.querySelector(".row-title")?.textContent === ${JSON.stringify(from)});
        const dst = rows.find((r) => r.querySelector(".row-title")?.textContent === ${JSON.stringify(to)});
        if (!src || !dst) return "rows missing: " + rows.map((r) => r.querySelector(".row-title")?.textContent).join(",");
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
        dst.dispatchEvent(over);
        if (!over.defaultPrevented) return "target did not accept the folder";
        dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return "ok";
      })()`);
      const r = await drag('Smoke A', 'Smoke B');
      if (r !== 'ok') fail('folderdrag', r);
      await sleep(1500);
      const moved = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.title === 'Smoke in A');
      if (moved?.folder !== 'Smoke B/Smoke A') fail('folderdrag', `entry of the dragged folder is in "${moved?.folder}"`);
      if ((await vault.summaries()).find((x) => x.title === 'Smoke in B')?.folder !== 'Smoke B') fail('folderdrag', 'target folder content changed');
    });

    // ---- passkey: drag it from the entry onto another login in the list – it moves there (after one confirmation)
    await step('passkeydrag', async () => {
      const grafana = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.title === 'Grafana' && x.rpIds?.length);
      if (!grafana) return;
      const target = await save({ type: 'login', title: 'Smoke PK Ziel', username: 'ops', password: 'x', folder: grafana.folder || '' });
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      await sleep(300);
      if (grafana.folder) await js(`[...document.querySelectorAll(".list .folder-row")].find((r) => r.querySelector(".row-title")?.textContent === ${JSON.stringify(grafana.folder)})?.click()`);
      await sleep(400);
      await js('[...document.querySelectorAll(".list li.row-item[data-key]")].find((x) => x.textContent.includes("Grafana"))?.click()');
      await sleep(600);
      const r = await js(`(() => {
        const src = document.querySelector(".detail-pane .passkey-row[draggable=true]");
        const dst = [...document.querySelectorAll(".list li.row-item[data-key]")].find((x) => x.textContent.includes("Smoke PK Ziel"));
        if (!src || !dst) return "passkey row or target row missing";
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
        dst.dispatchEvent(over);
        if (!over.defaultPrevented) return "login did not accept the passkey";
        dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return "ok";
      })()`);
      if (r !== 'ok') { fail('passkeydrag', r); return; }
      await sleep(400);
      await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
      let movedTo = null;
      for (let i = 0; i < 10 && !movedTo; i++) {
        await sleep(300);
        movedTo = (await vault.summaries()).find((x) => x.id === target.id && x.rpIds?.length);
      }
      if (!movedTo) fail('passkeydrag', 'passkey did not arrive in the target login');
      // Back where it was (the demo entry keeps its passkey for the other checks).
      const full = await vault.getItem(kvc.id, target.id, { fresh: true });
      if (full.passkeys[0]) await api.movePasskey({ from: { containerId: kvc.id, id: target.id }, to: { containerId: kvc.id, id: grafana.id }, credentialId: full.passkeys[0].credentialId });
    });

    // ---- admin mode: badge, devices tab, Microsoft entry tiles with sign-in for that account
    await step('admin', async () => {
      const msUser = 'smoke-admin@contoso.onmicrosoft.com';
      await save({ type: 'login', title: 'Smoke Microsoft', username: msUser, password: 'Ms-1', msAdmin: true, urls: ['https://login.microsoftonline.com'] });
      await setAdmin(true);
      const look = () => js('JSON.stringify({ accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase(), logo: document.querySelector(".brand img")?.getAttribute("src") || "", name: document.querySelector(".brand-name")?.textContent || "" })');
      let lk = JSON.parse(await look());
      if (!['#ac5500', '#e07a1f'].includes(lk.accent)) fail('admin', `accent not copper/red (${lk.accent})`);
      if (!lk.logo.includes('icon-admin') || !/for Admins/.test(lk.name)) fail('admin', `brand not "Keevault for Admins" with the admin logo (${lk.name}, ${lk.logo})`);
      if (!(await js('!!document.querySelector(".sidebar .mode-switch [data-mode=devices]")'))) fail('admin', '"Passwords | Devices" switch missing');
      if ((await newMenu()).includes('new-server')) fail('admin', 'devices offered while "Passwords" is selected');
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=devices]")?.click()');
      await sleep(400);
      const deviceItems = (await newMenu()).filter((a) => a.startsWith('new-') && a !== 'new-folder' && a !== 'new-subfolder');
      if (deviceItems.join() !== 'new-server') fail('admin', `"Devices" offers ${deviceItems.join()}`);
      if (await js('!!document.querySelector(".sidebar .nav[data-view=passkeys], .sidebar [data-nav=passkeys]")')) fail('admin', 'passkey view among devices');
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=items]")?.click()');
      await sleep(400);
      await js('document.querySelector(".context-menu")?.remove()');
      await openItem('Smoke Microsoft');
      const tiles = await js('[...document.querySelectorAll(".detail-pane [data-admin-link]")].map((b) => b.dataset.adminLink).join(",")');
      for (const id of ['pim', 'm365', 'entra', 'intune', 'azure']) if (!String(tiles).split(',').includes(id)) fail('admin', `tile "${id}" missing`);
      ctx.clearSignIns();
      await js('document.querySelector(".detail-pane [data-admin-link=entra]")?.click()');
      await sleep(400);
      if ((await ctx.signInFor('login.microsoftonline.com'))?.username !== msUser) fail('admin', 'Entra tile does not sign in with the entry');
      // One-time: once the page reports the last step, the job is gone – a second sign-in is left to the user.
      await ctx.signInDone('login.microsoftonline.com');
      if (await ctx.signInFor('login.microsoftonline.com')) fail('admin', 'sign-in still handed out after it was done');
      ctx.clearSignIns();
      await setAdmin(false);
      if (await js('!!document.querySelector(".admin-mode")')) fail('admin', 'the removed "Admin mode" badge is back');
      lk = JSON.parse(await look());
      if (['#ac5500', '#e07a1f'].includes(lk.accent) || lk.logo.includes('icon-admin') || /for Admins/.test(lk.name)) fail('admin', 'admin colour or brand stays after switching off');
      if (await js('!!document.querySelector(".detail-pane [data-admin-link]")')) fail('admin', 'admin tiles without admin mode');
    });

    // ---- devices: kinds and their connections, same-vault links, the search picker
    await step('devices', async () => {
      await setAdmin(true);
      const fw = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.type === 'login' && /Firewall/.test(x.title));
      const win1 = await save({ type: 'server', title: 'Smoke WIN', server: { kind: 'windows', host: '10.9.0.1', rdpLink: fw?.key || '' } });
      const lnx = await save({ type: 'server', title: 'Smoke LNX', username: 'root', password: 'Lx-1', server: { kind: 'linux', host: '10.9.0.2' } });
      const vmw = await save({ type: 'server', title: 'Smoke VMW', server: { kind: 'vmware', host: 'vmw', mgmtUrl: 'https://vcenter.contoso.local' } });
      const az = await save({ type: 'server', title: 'Smoke AZ', server: { kind: 'azurevm', host: 'az', bastionUrl: 'https://portal.azure.com/#@contoso.com/resource/x/connect' } });
      const methods = async (id) => (await vault.summaries()).find((x) => x.id === id)?.methods || [];
      if (!(await methods(win1.id)).includes('rdp')) fail('devices', 'Windows server without RDP');
      if (!(await methods(lnx.id)).includes('ssh') || (await methods(lnx.id)).includes('rdp')) fail('devices', 'Linux server: SSH instead of RDP expected');
      if (!(await methods(vmw.id)).includes('mgmt')) fail('devices', 'VMware VM without vSphere client');
      if ((await vault.getItem(kvc.id, lnx.id)).server.port !== 22) fail('devices', 'Linux server: default port not 22');
      const conn = (id, method) => api.connectServer({ containerId: kvc.id, id, method });
      if ((await conn(win1.id, 'rdp')).method !== 'rdp') fail('devices', 'RDP failed');
      if (!(await conn(lnx.id, 'ssh')).copied) fail('devices', 'SSH: password not handed over');
      if ((await conn(vmw.id, 'mgmt')).method !== 'mgmt') fail('devices', 'management page failed');
      if ((await conn(az.id, 'bastion')).method !== 'bastion') fail('devices', 'Bastion failed');
      ctx.clearSignIns();
      const evil = await save({ type: 'server', title: 'Smoke EVIL', server: { kind: 'linux', host: '-oProxyCommand=calc' } });
      if (await conn(evil.id, 'ssh').then(() => true, () => false)) fail('devices', 'SSH option injection not refused');
      const foreign = (await vault.summaries()).find((x) => x.containerId !== kvc.id && x.type === 'login');
      if (foreign && await api.save(kvc.id, { type: 'server', title: 'X', server: { host: 'x', rdpLink: foreign.key } }).then(() => true, () => false)) fail('devices', 'link into another vault saved');
      // Devices only in their tab; the form's link picker searches.
      changed();
      await sleep(700);
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      await sleep(300);
      if (await js('[...document.querySelectorAll(".list li.row-item[data-key]")].some((r) => r.textContent.includes("Smoke WIN"))')) fail('devices', 'device listed under "All"');
      await js('document.querySelector(".mode-switch [data-mode=devices]")?.click()');
      await sleep(400);
      if (!(await js('!!document.querySelector(".list-head .mode-badge")'))) fail('devices', 'list head does not show that devices are listed');
      if (await js('[...document.querySelectorAll(".list li.row-item[data-key]")].some((r) => r.textContent.includes("Grafana"))')) fail('devices', 'passwords listed in device mode');
      await openItem('Smoke WIN');
      if (!(await js('!!document.querySelector(".detail-pane [data-connect=rdp]")'))) fail('devices', 'RDP button missing in the entry');
      await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
      await sleep(300);
      await js('document.querySelector(".context-menu [data-action=edit]")?.click()');
      await sleep(500);
      await js('document.querySelector(".link-pick[data-name=srvRdpLink]")?.click()');
      await sleep(300);
      const rows = await js('(() => { const q = document.querySelector("dialog[open] .link-pick-search"); if (!q) return -1; q.value = "zzz-nothing"; q.dispatchEvent(new Event("input")); return document.querySelectorAll("dialog[open] .link-pick-row").length; })()');
      if (rows !== 0) fail('devices', `link picker search does not filter (${rows})`);
      await closeDialogs();
      await cancelEditor();
      // Room for the folder check (the demo vault takes 10 entries without a licence).
      for (const id of [lnx.id, vmw.id, az.id, evil.id]) {
        await vault.deleteItem(kvc.id, id).catch(() => {});
        created.splice(created.indexOf(id), 1);
      }
      // Own folders: an asset folder "Smoke Ordner" is not among the secrets' folders, renaming it leaves secrets alone.
      await save({ type: 'server', title: 'Smoke RACK', server: { kind: 'windows', host: '10.9.9.9' }, folder: 'Smoke Ordner' });
      await save({ type: 'login', title: 'Smoke Secret', username: 's', password: 'x', folder: 'Smoke Ordner' });
      await api.renameFolder(kvc.id, 'Smoke Ordner', 'Smoke Rack', 'assets');
      const sums = await vault.summaries();
      if (sums.find((x) => x.title === 'Smoke RACK')?.folder !== 'Smoke Rack') fail('devices', 'asset folder not renamed');
      if (sums.find((x) => x.title === 'Smoke Secret')?.folder !== 'Smoke Ordner') fail('devices', 'renaming an asset folder touched the secrets');
      await api.addFolder?.(kvc.id, 'assets:Smoke Leer');
      changed();
      await sleep(700);
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      await sleep(300);
      let assetFolders = '';
      for (let i = 0; i < 10 && !/Smoke Rack/.test(assetFolders); i++) { await sleep(300); assetFolders = await js('[...document.querySelectorAll(".list .folder-row .row-title")].map((e) => e.textContent).join("|")'); }
      if (!/Smoke Rack/.test(assetFolders) || /Smoke Ordner/.test(assetFolders)) fail('devices', `asset folders shown: ${assetFolders}`);
      await js('document.querySelector(".mode-switch [data-mode=items]")?.click()');
      await sleep(400);
      const secretFolders = await js('[...document.querySelectorAll(".list .folder-row .row-title")].map((e) => e.textContent).join("|")');
      if (/Smoke Rack|Smoke Leer|assets:/.test(secretFolders) || !/Smoke Ordner/.test(secretFolders)) fail('devices', `secret folders shown: ${secretFolders}`);
      await vault.removeFolder(kvc.id, 'assets:Smoke Leer').catch(() => {});
      if (await js('!!document.querySelector(".list-head .mode-badge")')) fail('devices', 'device marker stays after switching back to passwords');
      if (await js('[...document.querySelectorAll(".list li.row-item[data-key]")].some((r) => r.textContent.includes("Smoke WIN"))')) fail('devices', 'device listed among the passwords');
      await setAdmin(false);
      if (await js('!!document.querySelector(".mode-switch")')) fail('devices', 'switch visible without admin mode');
    });
  } finally {
    await cleanUp();
    config.update({ adminTools: false, theme: 'system', transparency: 'light' });
    changed();
    await sleep(500);
  }
}
