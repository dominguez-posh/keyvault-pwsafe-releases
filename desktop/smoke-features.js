// Feature checks of the smoke test (npm run smoke, demo run without --view): each recent function is used the way a
// person would – menus clicked, values copied, dialogs opened – and the result is checked. Rule (CLAUDE.md, "Prüfen"):
// every new or changed function gets a check here (or in scripts/extension-smoke.mjs) in the same commit.
//
// ctx: { js, sleep, errors, win, api, vault, config, changed, clipboardHas, signInFor, clearSignIns, copyViaHelperExe,
//        typeViaHelperExe }
// The clipboard is checked through Keevault-Update.exe (clipboardHas clears it when the text matches) – never read
// with Electron, never restored: after the run it is empty. Nothing is typed (auto-type: the helper's mode with
// empty input only).

import { readFile } from 'node:fs/promises';

export async function featureChecks(ctx) {
  const { js, sleep, errors, win, api, vault, config, changed, clipboardHas } = ctx;
  const fail = (area, message) => errors.push(`features/${area}: ${message}`);
  const closeDialogs = () => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); document.querySelector(".context-menu, .main-menu")?.remove(); true');
  // Settings → View (all view settings since #18): menu → Settings → tab "View".
  const openViewSettings = async () => {
    // Up to three tries: right after unlocking the window may still be drawing its menu button.
    for (let attempt = 0; attempt < 3; attempt++) {
      await closeDialogs();
      for (let i = 0; i < 10 && !(await js('!!document.querySelector(".menu-btn")')); i++) await sleep(300);
      await js('document.querySelector(".menu-btn")?.click()');
      await sleep(300);
      await js('document.querySelector(".main-menu [data-action=settings]")?.click()');
      await sleep(500);
      await js('[...document.querySelectorAll("dialog[open] .tabs button")].find((b) => /^(Ansicht|View)$/.test(b.textContent.trim()))?.click()');
      await sleep(200);
      if (await js('!!document.querySelector("dialog[open] .view-settings .view-row")?.offsetParent')) return;
    }
  };
  // Admin mode the way a person switches it (#23): offered under Settings → View, then the switch next to Help → app
  // PIN; switching off without.
  const setAdmin = async (on) => {
    const pin = on ? await ctx.ensurePin() : '';
    if (!config.get().adminOffered) {
      config.update({ adminOffered: true });
      changed();
      for (let i = 0; i < 10 && !(await js('!!document.querySelector(".sidebar-foot .admin-foot")')); i++) await sleep(300);
    }
    // Up to three clicks: the sidebar may be redrawn right as the switch is clicked (a save just before).
    for (let attempt = 0; attempt < 3 && config.get().adminTools !== on; attempt++) {
      await js('document.querySelector(".main-menu")?.remove()');
      await js(`document.querySelector(".sidebar-foot [data-action=${on ? 'admin-on' : 'admin-off'}]")?.click()`);
      await sleep(400);
      if (on) {
        await js(`(() => { const p = document.querySelector("dialog[open] .admin-pin"); if (p) { p.value = ${JSON.stringify(pin)}; } document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); })()`);
      }
      for (let i = 0; i < 10 && config.get().adminTools !== on; i++) await sleep(300);
    }
    await sleep(600);
    if (config.get().adminTools !== on) {
      const why = await js('JSON.stringify({ foot: document.querySelector(".sidebar-foot")?.innerHTML.slice(0, 300), dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.slice(0, 80)), offered: !!document.querySelector(".admin-foot") })');
      fail('admin', `switch next to Help did not switch admin mode ${on ? 'on' : 'off'} (${why}, offered=${config.get().adminOffered})`);
    }
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
    // Newest first: assets and linked logins go before the logins they use (those cannot be deleted while in use).
    for (const id of created.splice(0).reverse()) await vault.deleteItem(kvc.id, id).catch(() => {});
    changed();
    await sleep(400);
  };
  // The window is drawn completely (sidebar and list) – slow machines (GitHub runners) are still redrawing otherwise.
  const uiReady = async () => {
    for (let i = 0; i < 40; i++) {
      if (await js('!!document.querySelector(".sidebar .nav") && !!document.querySelector(".list-pane .list-scroll")')) return;
      await sleep(250);
    }
    if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log('[features] UI not ready:', await js('JSON.stringify({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.slice(0, 200)), body: document.body.innerText.slice(0, 300) })'));
  };
  // Window size of the run: steps that resize return to it; set until window and page agree (late resizes on Windows).
  const baseSize = win.getSize();
  const baseView = String(await js('innerWidth + "x" + innerHeight'));
  const resizeTo = async (w, h, area = '') => {
    for (let i = 0; i < 5; i++) {
      const [cw, ch] = win.getSize();
      const view = String(await js('innerWidth + "x" + innerHeight'));
      const want = w === baseSize[0] && h === baseSize[1] ? baseView.split('x').map(Number) : null;
      const [vw, vh] = view.split('x').map(Number);
      if (Math.abs(cw - w) <= 4 && Math.abs(ch - h) <= 4 && (!want || (Math.abs(vw - want[0]) <= 8 && Math.abs(vh - want[1]) <= 8))) return;
      if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[features] ${area} window ${cw}x${ch} (page ${view}) → ${w}x${h}`);
      win.setSize(w, h);
      await sleep(700);
    }
  };
  const step = async (area, fn) => {
    const started = Date.now();
    await uiReady();
    try {
      await Promise.race([fn(), new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout after 45 s')), 45_000))]);
    } catch (e) {
      fail(area, e.message);
    }
    if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[features] ${area} ${Date.now() - started} ms`);
    await closeDialogs();
    await cleanUp();
    // A step that resized the window must not leave the next ones in a small one: back to the size of the start,
    // checked on the page too (Windows sometimes applies a late resize after the restore).
    await resizeTo(...baseSize, area);
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
      // Someone copying on the same machine meanwhile overwrites it: one more click before it counts as failed.
      if (!arrived) {
        await js('document.querySelector(".detail-pane .field-row .icon-btn[title=Kopieren], .detail-pane .field-row .icon-btn[title=Copy]")?.click()');
        for (let i = 0; i < 10 && !arrived; i++) { await sleep(300); arrived = await clipboardHas(login.username); }
      }
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
      for (const a of ['reload', 'settings', 'generator', 'health', 'lock']) if (!String(actions).split(',').includes(a)) fail('mainmenu', `entry "${a}" missing`);
      if (await js('[...document.querySelectorAll(".main-menu .view-row, .main-menu label, .main-menu span")].some((e) => /Leiste unten|Bottom bar/.test(e.textContent))')) fail('mainmenu', 'removed "bottom bar" setting is back');
      // One menu (#18): no tabs; design and zoom on top, the admin mode as a switch, all other view settings in the settings.
      const menuState = JSON.parse(await js('JSON.stringify({ tabs: document.querySelectorAll(".main-menu [data-tab]").length, rows: [...document.querySelectorAll(".main-menu .view-row .grow")].map((e) => e.textContent), adminSwitch: document.querySelector(".main-menu .admin-switch")?.getAttribute("aria-checked"), settings: !!document.querySelector(".main-menu [data-action=settings]")?.offsetParent })'));
      if (menuState.tabs || !menuState.settings) fail('mainmenu', `menu still has tabs or lacks the settings: ${JSON.stringify(menuState)}`);
      if (menuState.rows.join() !== 'Design,Zoom') fail('mainmenu', `menu view settings: ${menuState.rows.join()}`);
      // Admin mode (#23): never in the menu, next to Help only once offered under Settings → View.
      if (menuState.adminSwitch !== undefined) fail('mainmenu', 'admin mode switch in the menu');
      await js('document.querySelector(".main-menu")?.remove()');
      if (config.get().adminOffered || (await js('!!document.querySelector(".sidebar-foot .admin-foot")'))) fail('mainmenu', 'admin mode offered without being switched on');
      await openViewSettings();
      await js('document.querySelector("dialog[open] .view-settings .seg[aria-label=\'Admin-Modus anbieten\'] button")?.click()');
      await closeDialogs();
      let foot = '';
      for (let i = 0; i < 10 && !foot; i++) {
        await sleep(300);
        foot = String(await js('(() => { const f = document.querySelector(".sidebar-foot"); const a = f?.querySelector(".admin-foot"), help = f?.querySelector(".help-btn"); return a && help && Math.abs(a.getBoundingClientRect().top - help.getBoundingClientRect().top) < 4 ? a.getAttribute("aria-checked") : ""; })()'));
      }
      if (foot !== 'false') fail('mainmenu', `no admin switch next to Help after offering it (${foot})`);
      config.update({ adminOffered: false });
      changed();
      await sleep(400);
      for (const { action, what } of [{ action: 'settings', what: 'settings dialog' }, { action: 'generator', what: 'password generator' }, { action: 'health', what: 'password check' }]) {
        await openMenu();
        await js(`document.querySelector(".main-menu [data-action=${action}]")?.click()`);
        await sleep(500);
        if (!(await js('!!document.querySelector("dialog[open]")'))) fail('mainmenu', `${what} did not open`);
        if (action === 'settings' && !(await js('!!document.querySelector("dialog[open] select[name=updateChannel] option[value=beta]")'))) fail('mainmenu', 'settings without the update channel (Stable / Early Access)');
        await closeDialogs();
        await sleep(200);
      }
      // Design in the menu; transparency only under Settings → View.
      const segClick = async (label, text) => {
        if (label === 'Design') {
          await openMenu();
          await js(`[...document.querySelectorAll('.main-menu .seg[aria-label="${label}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
        } else {
          await openViewSettings();
          await js(`[...document.querySelectorAll('dialog[open] .view-settings .seg[aria-label="${label}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
        }
        await sleep(400);
        await closeDialogs();
      };
      await openViewSettings();
      const viewRows = await js('[...document.querySelectorAll("dialog[open] .view-settings .view-row .grow")].map((e) => e.textContent).join()');
      for (const r of ['Zoom', 'Design', 'Transparenz', 'Speicherort', 'PIM beim Entsperren', 'PIM-Knopf im Admin-Modus']) if (!String(viewRows).split(',').includes(r)) fail('mainmenu', `Settings → View without "${r}"`);
      if (!(await js('!!document.querySelector("dialog[open] .view-settings [data-action=view-reset]")'))) fail('mainmenu', 'Settings → View without "reset"');
      // Settings keep one size on every tab, navigation on the left (#211).
      const sizes = JSON.parse(await js(`JSON.stringify((() => {
        const d = document.querySelector("dialog[open].settings-modal"); if (!d) return null;
        const tabs = [...d.querySelectorAll(".tabs button")];
        const out = tabs.map((b) => { b.click(); const r = d.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); });
        const [a, b] = tabs.map((x) => x.getBoundingClientRect());
        return { sizes: out, vertical: b.top > a.top + 4 && Math.abs(b.left - a.left) < 4 };
      })())`));
      if (!sizes || new Set(sizes.sizes).size !== 1 || !sizes.vertical) fail('mainmenu', `settings dialog changes size or has no side navigation: ${JSON.stringify(sizes)}`);
      await closeDialogs();
      // The update window (Keevault-Update.exe) gets the app's own theme, not Windows' app mode.
      const updaterTheme = () => { const a = ctx.updaterArgs(); return a[a.indexOf('--theme') + 1]; };
      await segClick('Design', 'Dunkel');
      if (config.get().theme !== 'dark') fail('mainmenu', `theme not switched (${config.get().theme})`);
      if (updaterTheme() !== 'dark') fail('mainmenu', `update window not dark with the dark theme (${ctx.updaterArgs().join(' ')})`);
      await segClick('Design', 'Hell');
      if (updaterTheme() !== 'light') fail('mainmenu', `update window not light with the light theme (${ctx.updaterArgs().join(' ')})`);
      await segClick('Design', 'System');
      await segClick('Transparenz', 'Stark');
      if (config.get().transparency !== 'strong') fail('mainmenu', `transparency not switched (${config.get().transparency})`);
      if (Math.abs(win.getOpacity() - 0.95) > 0.01) fail('mainmenu', `strong transparency is not 95 % (${win.getOpacity()})`);
      await segClick('Transparenz', 'Leicht');
      // Light (the default) is barely see-through.
      if (Math.abs(win.getOpacity() - 0.985) > 0.01) fail('mainmenu', `light transparency is not 98.5 % (${win.getOpacity()})`);
      // Small window: the menu ends inside the window and scrolls.
      const [w, h] = win.getSize();
      win.setSize(900, 520);
      await sleep(900);
      await openMenu();
      const fits = await js('(() => { const m = document.querySelector(".main-menu"); return !!m && m.getBoundingClientRect().bottom <= innerHeight + 1 && getComputedStyle(m).overflowY === "auto"; })()');
      if (!fits) fail('mainmenu', 'menu cut off or not scrollable in a small window');
      await js('document.querySelector(".main-menu")?.remove()');
      await resizeTo(w, h, "mainmenu");
      // The resize event arrives late and closes open context menus – wait until it is through.
      await sleep(1000);
    });

    // ---- trash: reachable from the main menu, a deleted entry is listed there and the button restores it
    await step('trash', async () => {
      const gone = await save({ type: 'login', title: 'Smoke Papierkorb', username: 'trash', password: 'x' });
      await api.delete(kvc.id, gone.id);
      created.splice(created.indexOf(gone.id), 1);
      changed();
      await sleep(500);
      await js('document.querySelector(".main-menu")?.remove(); document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-tab=main]")?.click(); document.querySelector(".main-menu [data-action=trash]")?.click()');
      let listed = false;
      for (let i = 0; i < 10 && !listed; i++) { await sleep(300); listed = await js(`!!document.querySelector('dialog[open] [data-restore="${gone.id}"]')`); }
      if (!listed) {
        if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log('[features] trash screen:', await js('JSON.stringify({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.slice(0, 300)), body: document.body.innerText.slice(0, 400) })'));
        fail('trash', 'main menu → trash does not list the deleted entry');
        return;
      }
      await js(`document.querySelector('dialog[open] [data-restore="${gone.id}"]').click()`);
      let back = false;
      for (let i = 0; i < 30 && !back; i++) { await sleep(400); back = (await vault.summaries()).some((x) => x.id === gone.id); }
      if (!back) fail('trash', 'restore did not bring the entry back');
      else created.push(gone.id);
      await closeDialogs();
      // The list area offers it too.
      await js('(() => { const el = document.querySelector(".list-pane .list-scroll"); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.bottom - 20 })); })()');
      await sleep(300);
      if (!(await js('!!document.querySelector(".context-menu [data-action=trash]")'))) fail('trash', 'right-click on the list area offers no trash');
      await js('document.querySelector(".context-menu")?.remove()');
    });

    // ---- vault search: magnifier in the "Vaults" header filters the rows, Esc shows all again
    await step('vaultsearch', async () => {
      if (await js('!!document.querySelector(".nav-section .count")')) fail('vaultsearch', 'vault count back in the Vaults header');
      if (!(await js('!!document.querySelector(".nav-section .vault-find .icon-btn")'))) {
        fail('vaultsearch', 'magnifier in the vault header missing');
        return;
      }
      const visible = () => js('[...document.querySelectorAll(".sidebar-vaults .nav-row, .sidebar-vaults > *")].filter((r) => !r.hidden && r.offsetParent !== null).map((r) => r.textContent.trim()).join("|")');
      const all = String(await visible());
      await js('document.querySelector(".vault-find .icon-btn").click(); const q = document.querySelector(".vault-find input"); q.value = "Team-Datei"; q.dispatchEvent(new Event("input"))');
      await sleep(300);
      // Open, the field spans the header from its left edge up to the magnifier (not a stub over a cut label).
      const box = JSON.parse(await js(`JSON.stringify((() => {
        const r = (el) => el.getBoundingClientRect();
        const sec = r(document.querySelector(".vault-find").closest(".nav-section")), q = r(document.querySelector(".vault-find input")), b = r(document.querySelector(".vault-find .icon-btn"));
        return { left: Math.round(q.left - sec.left), gap: Math.round(b.left - q.right), width: Math.round(q.width), section: Math.round(sec.width) };
      })())`));
      if (box.left > 8 || box.gap < 0 || box.gap > 8 || box.width < box.section - 80) fail('vaultsearch', `search field not full width: ${JSON.stringify(box)}`);
      const hit = String(await visible());
      if (!hit.includes('Team-Datei') || hit.includes('Team Infrastruktur')) fail('vaultsearch', `filter shows: ${hit}`);
      await js('document.querySelector(".vault-find input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      let again = '';
      for (let i = 0; i < 10 && again !== all; i++) { await sleep(200); again = String(await visible()); }
      if (again !== all) fail('vaultsearch', 'Esc did not show all vaults again');
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
      for (const a of ['new-login', 'new-note', 'new-card', 'new-certificate']) if (!items.includes(a)) fail('newmenu', `"${a}" missing`);
      // Without admin mode the menu stays simple: no devices, no admin templates.
      for (const a of ['new-server', 'new-microsoft', 'new-ad', 'new-sophos']) if (items.includes(a)) fail('newmenu', `"${a}" offered without admin mode`);
      await js('document.querySelector(".context-menu")?.remove()');
      // The templates: in admin mode on the passwords side.
      await setAdmin(true);
      if (!(await newMenu()).includes('new-microsoft')) fail('templates', 'admin mode without the Microsoft template');
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
      // Sophos login: logo, named portal rows (free name + address) instead of the website box; saved, the entry shows
      // one "… öffnen" button per portal.
      await newMenu();
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".new-split .new-more")?.click(); document.querySelector(".context-menu [data-action=new-sophos]")?.click()');
      await sleep(500);
      const so = JSON.parse(await js(`JSON.stringify({
        sophos: !!document.querySelector(".detail-pane input[name=sophos]")?.checked,
        labels: [...document.querySelectorAll(".detail-pane .portal-row .portal-label")].map((i) => i.value).join("|"),
        urlsHidden: !!document.querySelector(".detail-pane textarea[name=urls]")?.closest(".field")?.hidden,
        logo: !!document.querySelector(".detail-pane img") })`));
      if (!so.sophos || !/VPN-Portal/.test(so.labels) || !/Admin-Portal/.test(so.labels) || !so.urlsHidden || !so.logo) fail('templates', `Sophos login form: ${JSON.stringify(so)}`);
      await js(`(() => { const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
        set(document.querySelector(".detail-pane input[name=title]"), "Smoke Sophos");
        set(document.querySelector(".detail-pane input[name=username]"), "vpnuser");
        set(document.querySelector(".detail-pane input[name=password]"), "Vpn-Pass-1");
        set(document.querySelector(".detail-pane .portal-row .portal-url"), "https://vpn.contoso.com");
        set(document.querySelectorAll(".detail-pane .portal-row .portal-url")[1], "https://vpn.contoso.com:4444");
        document.querySelector(".detail-pane .portal-add").click();
        const rows = document.querySelectorAll(".detail-pane .portal-row");
        set(rows[rows.length - 1].querySelector(".portal-label"), "Zweites Portal");
        set(rows[rows.length - 1].querySelector(".portal-url"), "https://vpn2.contoso.com");
        document.querySelector(".detail-pane form .actions .btn.primary").click(); return true; })()`);
      let sophosSaved = null;
      for (let i = 0; i < 20 && !sophosSaved; i++) {
        await sleep(250);
        sophosSaved = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.title === 'Smoke Sophos');
      }
      if (!sophosSaved) fail('templates', 'Sophos login not saved');
      else {
        created.push(sophosSaved.id);
        const full = await vault.getItem(kvc.id, sophosSaved.id);
        if (!full.sophos || full.portals.map((p) => p.label).join('|') !== `${so.labels.split('|')[0]}|${so.labels.split('|')[1]}|Zweites Portal` || full.urls.length) {
          fail('templates', `Sophos login stored: ${JSON.stringify({ sophos: full.sophos, portals: full.portals, urls: full.urls })}`);
        }
        await sleep(300);
        const buttons = await js('[...document.querySelectorAll(".detail-pane .portal-open")].map((b) => b.textContent + "=" + b.title).join("|")');
        if (!/VPN-Portal öffnen=https:\/\/vpn\.contoso\.com/.test(buttons) || !/Zweites Portal öffnen=https:\/\/vpn2\.contoso\.com/.test(buttons)) fail('templates', `Sophos portal buttons: ${buttons}`);
      }
      await setAdmin(false);
    });

    // ---- vault menu: "Infos" directly in the right-click menu of a Key Vault, not in a submenu
    await step('vaultmenu', async () => {
      await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)})); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
      await sleep(300);
      const r = JSON.parse(await js('JSON.stringify({ top: !!document.querySelector(".context-menu > [data-action=info], .context-menu > .context-group > [data-action=info]"), sub: !!document.querySelector(".context-sub [data-action=info]") })'));
      if (!r.top || r.sub) fail('vaultmenu', `"Infos" not at the top of the vault menu (${JSON.stringify(r)})`);
      await js('document.querySelector(".context-menu")?.remove()');
    });

    // ---- import of a KeePass database (.kdbx): vault menu → Import → file → master password + key file → import
    await step('kdbximport', async () => {
      const fixtures = new URL('../test/fixtures/', import.meta.url);
      const [db, key] = await Promise.all([readFile(new URL('smoke.kdbx', fixtures)), readFile(new URL('smoke.keyx', fixtures))]);
      const setFile = (selector, name, bytes) => js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(${JSON.stringify([...bytes])})], ${JSON.stringify(name)})); input.files = dt.files; input.dispatchEvent(new Event("change")); return true; })()`);
      await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)})); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
      await sleep(300);
      await js('document.querySelector(".context-menu [data-action=import]")?.click()');
      await sleep(400);
      await setFile('dialog[open] input[type=file]:not(.kdbx-keyfile)', 'Smoke.kdbx', db);
      await sleep(400);
      if (!(await js('!!document.querySelector("dialog[open] .kdbx-password")'))) fail('kdbximport', 'no master password field for a .kdbx file');
      const openWith = async (password) => {
        await js(`(() => { const p = document.querySelector("dialog[open] .kdbx-password"); p.value = ${JSON.stringify(password)}; document.querySelector("dialog[open] .kdbx-open").click(); return true; })()`);
        for (let i = 0; i < 30 && (await js('!!document.querySelector("dialog[open] .kdbx-open")?.disabled')); i++) await sleep(200);
        await sleep(200);
      };
      // Without the key file the database does not open: the error is shown, the import stays off.
      await openWith('Smoke-Master-1');
      if (!/Master-Passwort|master password/i.test(await js('document.querySelector("dialog[open] .notice.error")?.textContent || ""'))) fail('kdbximport', `no wrong-key message without the key file: ${(await js('document.querySelector("dialog[open] .notice.error")?.textContent || ""'))}`);
      await setFile('dialog[open] .kdbx-keyfile', 'smoke.keyx', key);
      await openWith('Smoke-Master-1');
      const summary = await js('document.querySelector("dialog[open]")?.textContent || ""');
      if (!summary.includes('KeePass (KDBX)') || !summary.includes('Smoke KDBX')) fail('kdbximport', `database not read: ${summary.slice(0, 200)}`);
      await js('[...document.querySelectorAll("dialog[open] .modal-footer .btn.primary")].find((b) => /Importieren|Import/.test(b.textContent))?.click()');
      let imported = null;
      for (let i = 0; i < 20 && !imported; i++) {
        await sleep(300);
        imported = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.title === 'Smoke KDBX');
      }
      if (!imported) fail('kdbximport', 'entry not imported');
      else {
        created.push(imported.id);
        const full = await vault.getItem(kvc.id, imported.id);
        if (full.password !== 'Kdbx-Secret-1' || full.username !== 'kdbx@contoso.com' || full.folder !== 'KeePass') fail('kdbximport', `imported entry wrong: ${full.username} ${full.folder}`);
      }
      await closeDialogs();
    });

    // ---- linked login: an entry signs in with another login (domain login / Microsoft login) – shown with the linked
    // values, edited without own user and password; a Microsoft link opens the website with a one-click sign-in
    await step('loginlink', async () => {
      const domain = await save({ type: 'login', title: 'Smoke Domain', username: 'CONTOSO\\smoke', password: 'Dom-Smoke-1' });
      const ms = await save({ type: 'login', title: 'Smoke MS Link', username: 'smoke-link@contoso.onmicrosoft.com', password: 'Ms-Link-1', msAdmin: true, urls: ['https://login.microsoftonline.com'] });
      const intranet = await save({ type: 'login', title: 'Smoke Intranet', urls: ['https://intranet.contoso.com'], loginLink: `${kvc.id}/${domain.id}` });
      const partner = await save({ type: 'login', title: 'Smoke Partner', urls: ['https://partner.contoso.com'], loginLink: `${kvc.id}/${ms.id}` });
      await openItem('Smoke Intranet');
      const shown = await js('document.querySelector(".detail-pane")?.innerText || ""');
      if (!/Anmeldung über|Signs in with/.test(shown) || !shown.includes('Smoke Domain') || !shown.includes('CONTOSO\\smoke')) fail('loginlink', `linked login not shown: ${shown.slice(0, 200)}`);
      if (!(await js('[...document.querySelectorAll(".detail-pane .field label")].some((l) => /^(Passwort|Password)$/.test(l.textContent.trim()))'))) fail('loginlink', 'password of the linked login missing in the detail view');
      // Editor: the link is chosen, own user name and password are hidden; the stored entry keeps no copy.
      await js('document.querySelector(".detail-pane .item-hover-menu")?.click()');
      await sleep(300);
      await js('document.querySelector(".context-menu [data-action=edit]")?.click()');
      await sleep(500);
      const ed = JSON.parse(await js('JSON.stringify({ own: !!document.querySelector(".detail-pane .own-login")?.hidden, pick: document.querySelector(".detail-pane .login-link .link-pick-text")?.textContent || "" })'));
      if (!ed.own || ed.pick !== 'Smoke Domain') fail('loginlink', `editor of a linked login: ${JSON.stringify(ed)}`);
      // The type of an existing entry is fixed (#263).
      if (!(await js('!!document.querySelector(".detail-pane select[name=type]")?.disabled'))) fail('loginlink', 'type of an existing entry can be changed');
      await js('[...document.querySelectorAll(".detail-pane button")].find((b) => /^(Abbrechen|Cancel)$/.test(b.textContent.trim()))?.click()');
      await sleep(300);
      const stored = await vault.getItem(kvc.id, intranet.id);
      if (stored.password || stored.username || stored.loginLink !== `${kvc.id}/${domain.id}`) fail('loginlink', 'linked login stores its own values');
      // In use by another entry (#34): the domain login cannot be deleted until the link is gone.
      const refused = await api.delete(kvc.id, domain.id).then(() => '', (e) => e.message);
      if (!/Smoke Intranet/.test(refused)) fail('loginlink', `login in use was deleted or without naming its user (${refused})`);
      // Microsoft link: opening the website starts the one-click sign-in for exactly that Microsoft account.
      ctx.clearSignIns();
      await api.openWithMicrosoft({ containerId: kvc.id, id: partner.id, url: 'https://partner.contoso.com' });
      const job = await ctx.signInFor('login.microsoftonline.com');
      if (job?.username !== 'smoke-link@contoso.onmicrosoft.com' || ctx.lastAdminUrl() !== 'https://partner.contoso.com') fail('loginlink', `Microsoft link: sign-in job ${job?.username}, opened ${ctx.lastAdminUrl()}`);
      if (await api.openWithMicrosoft({ containerId: kvc.id, id: intranet.id, url: 'https://intranet.contoso.com' }).then(() => true, () => false)) fail('loginlink', 'one-click Microsoft sign-in for a domain-linked login');
      ctx.clearSignIns();
    });

    // ---- import guide for browsers: the import dialog shows per-browser CSV-export steps (Chrome, Edge, Firefox)
    await step('browserimport', async () => {
      await js(`(() => { const row = [...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)})); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
      await sleep(300);
      await js('document.querySelector(".context-menu [data-action=import]")?.click()');
      await sleep(400);
      if (!(await js('!!document.querySelector("dialog[open] .browser-import .browser-chrome")'))) fail('browserimport', 'browser import guide missing');
      await js('document.querySelector("dialog[open] .browser-import").open = true; document.querySelector("dialog[open] .browser-firefox")?.click()');
      await sleep(200);
      const steps = await js('document.querySelectorAll("dialog[open] .browser-steps ol li").length');
      const addr = await js('document.querySelector("dialog[open] .browser-steps code")?.textContent || ""');
      if (Number(steps) < 2 || addr !== 'about:logins') fail('browserimport', `Firefox guide not shown (${steps} steps, "${addr}")`);
      await closeDialogs();
    });

    // ---- folder symbols: chosen in the folder's menu, shown in the list, moved along with a rename, taken over from an
    // import (KeePass group icons)
    await step('foldericons', async () => {
      await save({ type: 'login', title: 'Smoke Symbol', username: 's', password: 'x', folder: 'Smoke Symbole' });
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      for (let i = 0; i < 15 && !(await js('!!document.querySelector(\'.list .folder-row[data-folder="Smoke Symbole"]\')')); i++) await sleep(300);
      await js('document.querySelector(\'.list .folder-row[data-folder="Smoke Symbole"]\')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 200 }))');
      await sleep(300);
      await js('document.querySelector(".context-menu [data-action=folder-icon]")?.click()');
      await sleep(400);
      if (!(await js('document.querySelectorAll("dialog[open] .icon-grid .icon-choice").length > 20'))) fail('foldericons', 'symbol picker did not open');
      await js('document.querySelector("dialog[open] .icon-choice[data-icon=server]")?.click()');
      let icons = {};
      for (let i = 0; i < 15 && icons['Smoke Symbole'] !== 'server'; i++) {
        await sleep(300);
        icons = await api.folderIcons(kvc.id);
      }
      if (icons['Smoke Symbole'] !== 'server') fail('foldericons', `symbol not stored: ${JSON.stringify(icons)}`);
      let shown = false;
      for (let i = 0; i < 15 && !shown; i++) {
        await sleep(300);
        shown = await js('!!document.querySelector(\'.list .folder-row[data-folder="Smoke Symbole"] .folder-icon .icon-server\')');
      }
      if (!shown) fail('foldericons', 'list does not show the chosen symbol');
      await api.renameFolder(kvc.id, 'Smoke Symbole', 'Smoke Symbole 2');
      icons = await api.folderIcons(kvc.id);
      if (icons['Smoke Symbole 2'] !== 'server' || icons['Smoke Symbole']) fail('foldericons', `symbol did not move with the rename: ${JSON.stringify(icons)}`);
      const r = await api.importItems(kvc.id, [{ type: 'login', title: 'Smoke KP Symbol', username: 'k', password: 'x', folder: 'Smoke KP' }], { folderIcons: { 'Smoke KP': 'database', 'Smoke Symbole 2': 'star' } });
      const imported = (await vault.summaries()).find((x) => x.containerId === kvc.id && x.title === 'Smoke KP Symbol');
      if (imported) created.push(imported.id);
      icons = await api.folderIcons(kvc.id);
      if (r.imported !== 1 || icons['Smoke KP'] !== 'database') fail('foldericons', `import did not take the folder symbol: ${JSON.stringify(icons)}`);
      if (icons['Smoke Symbole 2'] !== 'server') fail('foldericons', 'import replaced a symbol chosen before');
      for (const f of ['Smoke Symbole 2', 'Smoke KP']) await api.setFolderIcon(kvc.id, f, '');
    });

    // ---- setup wizard for a team vault: step by step with an explanation per step, the check before creating
    await step('vaultwizard', async () => {
      // "+" is the last button in the head of the vault list (the vault search comes before it).
      await js('[...document.querySelectorAll(".nav-section .icon-btn")].at(-1)?.click()');
      await sleep(300);
      await js('[...document.querySelectorAll("dialog[open] .option-card")].find((b) => /Neuen Key-Vault-Tresor|new Key Vault/i.test(b.textContent))?.click()');
      // The demo's example Azure: subscription, resource groups and regions filled in.
      const selects = async () => String(await js('JSON.stringify([...document.querySelectorAll("dialog[open] .vault-wizard select")].map((x) => [...x.options].map((o) => o.value)))'));
      for (let i = 0; i < 30 && !(await selects()).includes('rg-security'); i++) await sleep(300);
      if (!(await selects()).includes('rg-security') || !(await selects()).includes('westeurope')) fail('vaultwizard', `example resource groups or regions missing: ${await selects()}`);
      // "Use an existing empty Key Vault" lists the demo's empty vault in rg-security.
      await js('(() => { const [, rg, mode] = document.querySelectorAll("dialog[open] .vault-wizard select"); rg.value = "rg-security"; rg.dispatchEvent(new Event("change")); mode.value = "existing"; mode.dispatchEvent(new Event("change")); return true; })()');
      for (let i = 0; i < 20 && !(await selects()).includes('kv-pws-demo-leer'); i++) await sleep(300);
      if (!(await selects()).includes('kv-pws-demo-leer')) fail('vaultwizard', `empty example Key Vault not offered: ${await selects()}`);
      await js('(() => { const mode = document.querySelectorAll("dialog[open] .vault-wizard select")[2]; mode.value = "new"; mode.dispatchEvent(new Event("change")); return true; })()');
      const at = () => js('document.querySelector("dialog[open] .vault-wizard .wizard-steps li.on")?.textContent || ""');
      if (!/Ort|Location/.test(await at())) fail('vaultwizard', `wizard does not start at the location: "${await at()}"`);
      if (!(await js('!!document.querySelector("dialog[open] .vault-wizard .wizard-explain")'))) fail('vaultwizard', 'no explanation in the step');
      // No scrollbars in a normal window (#17): the dialog body neither scrolls sideways nor down.
      const scrolls = async (where) => {
        const o = JSON.parse(await js('JSON.stringify((() => { const b = document.querySelector("dialog[open].wizard-modal .modal-body"); return b ? { x: b.scrollWidth - b.clientWidth, y: b.scrollHeight - b.clientHeight, win: innerWidth + "x" + innerHeight } : { missing: true }; })())'));
        if (o.missing || o.x > 1 || o.y > 1) fail('vaultwizard', `scrollbars at ${where}: ${JSON.stringify(o)}`);
      };
      await scrolls('location');
      const next = () => js('[...document.querySelectorAll("dialog[open] .wizard-buttons .btn.primary")].at(-1)?.click()');
      // An invalid name stops at the location step.
      await js('(() => { const n = [...document.querySelectorAll("dialog[open] .vault-wizard input")].find((i) => /kv-pws/.test(i.placeholder)); n.value = "1"; n.dispatchEvent(new Event("input")); })()');
      await next();
      await sleep(400);
      if (!/Ort|Location/.test(await at())) fail('vaultwizard', 'went on with an invalid Key Vault name');
      // The error message of a dialog is in front of it, not hidden behind (#21).
      const onTop = await js(`(() => { const el = document.getElementById("toast"); if (!el || !el.classList.contains("show")) return "no message";
        const r = el.getBoundingClientRect(); el.style.pointerEvents = "auto"; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); el.style.pointerEvents = "";
        return hit?.closest("#toast") ? "ok" : "behind " + (hit?.closest("dialog") ? "the dialog" : hit?.tagName); })()`);
      if (onTop !== 'ok') fail('vaultwizard', `error message not in front of the dialog: ${onTop}`);
      await js('(() => { const n = [...document.querySelectorAll("dialog[open] .vault-wizard input")].find((i) => /kv-pws/.test(i.placeholder)); n.value = "kv-pws-smoke"; n.dispatchEvent(new Event("input")); })()');
      for (const label of [/Zugriff|Access/, /Notfall|Emergency/, /Erstellen|Create/]) {
        await next();
        await sleep(400);
        if (!label.test(await at())) fail('vaultwizard', `expected step ${label}, at "${await at()}"`);
        await scrolls(String(label));
      }
      const summary = await js('document.querySelector("dialog[open] .wizard-summary")?.textContent || ""');
      if (!summary.includes('kv-pws-smoke')) fail('vaultwizard', `summary without the Key Vault: ${summary.slice(0, 200)}`);
      // Created in the demo's Azure: the wizard ends with "Fertig" and the vault is in the app.
      await next();
      for (let i = 0; i < 30 && !(await js('/Fertig|Done/.test(document.querySelector("dialog[open] .vault-wizard .wizard-buttons")?.textContent || "")')); i++) await sleep(300);
      if (!(await vault.containers()).some((c) => c.id === 'kv-pws-smoke.vault.azure.net')) fail('vaultwizard', 'vault not created in the demo');
      await closeDialogs();
      await api.removeContainer('kv-pws-smoke.vault.azure.net').catch(() => {});
      // The wizard opened the new vault: the following checks work in the demo's team vault again.
      changed();
      await sleep(600);
      await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click()`);
      await sleep(600);
    });

    // ---- start: admin mode is always off after a start (#8)
    await step('adminstart', async () => {
      config.update({ adminTools: true });
      ctx.startInNormalMode();
      if (config.get().adminTools) fail('adminstart', 'admin mode survives a start');
    });

    // ---- narrow sidebar: lock and menu button stay visible, even in admin mode (#6)
    await step('narrowsidebar', async () => {
      await setAdmin(true);
      const r = JSON.parse(await js(`(() => {
        const sp = document.querySelector(".shell > .splitter");
        const x = sp.getBoundingClientRect().left;
        const ev = (type, clientX) => new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 });
        sp.dispatchEvent(ev("pointerdown", x));
        sp.dispatchEvent(ev("pointermove", x - 600));
        sp.dispatchEvent(ev("pointerup", x - 600));
        const side = document.querySelector(".sidebar").getBoundingClientRect();
        const box = (q) => { const b = document.querySelector(q)?.getBoundingClientRect(); return b ? { l: b.left, r: b.right, w: b.width } : null; };
        const out = { side: Math.round(side.width), menu: box(".brand .menu-btn"), lock: box(".brand .icon-btn"), right: side.right };
        sp.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return JSON.stringify(out);
      })()`));
      // Narrowest is the minimum width (#19): 280 px, room for longer vault names.
      if (r.side > 285 || r.side < 280) fail('narrowsidebar', `narrowest sidebar is ${r.side}px instead of 280px`);
      const inside = (b) => b && b.w >= 24 && b.r <= r.right + 1;
      if (!inside(r.menu) || !inside(r.lock)) fail('narrowsidebar', `menu/lock button cut off at the narrowest sidebar (${JSON.stringify(r)})`);
      await setAdmin(false);
    });

    // ---- sidebar foot: only Help (no company name)
    await step('sidebarfoot', async () => {
      if (await js('!!document.querySelector(".sidebar-foot .org-name")')) fail('sidebarfoot', 'company name back in the sidebar foot');
    });

    // ---- version: in the sidebar foot of the open app, not fixed over the entry
    await step('version', async () => {
      // Bottom right, and the end of the entry (scrolled down) stays above it.
      await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
      await sleep(600);
      const r = JSON.parse(await js(`(() => {
        const v = document.getElementById("app-version"), pane = document.querySelector(".detail-pane");
        pane.scrollTop = pane.scrollHeight;
        const last = [...pane.querySelectorAll(".meta, .field-card")].pop();
        const vr = v?.getBoundingClientRect(), lr = last?.getBoundingClientRect();
        return JSON.stringify({ text: v?.textContent || "", right: vr ? innerWidth - vr.right < 60 : false, free: vr && lr ? lr.bottom <= vr.top + 2 : false });
      })()`));
      if (!/^Keevault \d/.test(r.text) || !r.right) fail('version', `version not at the bottom right (${JSON.stringify(r)})`);
      if (!r.free) fail('version', 'the end of the entry lies under the version');
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

    // ---- AI agents: a request brings the hidden window to the front (above all windows) and lets go after the answer;
    // while Keevault is locked the unlock screen comes to the front and the request waits instead of failing.
    await step('agentfront', async () => {
      const front = () => ({ visible: win.isVisible(), top: win.isAlwaysOnTop() });
      win.hide();
      const asked = ctx.confirmAgentRead({ agent: 'smoke-agent', title: 'Smoke Front', vault: 'Smoke' });
      await sleep(600);
      const during = front();
      if (!during.visible || !during.top) fail('agentfront', `read request did not come to the front: ${JSON.stringify(during)}`);
      if (!(await js('!!document.querySelector("dialog[open] .question.agent-read")'))) fail('agentfront', 'read request dialog not shown');
      await js('[...document.querySelectorAll("dialog[open] button")].find((b) => b.closest("dialog").querySelector(".question") && /Ablehnen|Deny/.test(b.textContent))?.click()');
      if ((await Promise.race([asked, sleep(3000).then(() => 'timeout')])) !== 'deny') fail('agentfront', 'deny did not answer the request');
      await sleep(200);
      if (win.isAlwaysOnTop()) fail('agentfront', 'window stays on top after the answer');
      win.hide();
      let open = false;
      const waiting = ctx.waitForUnlock({ ms: 4000, isOpen: () => open });
      await sleep(600);
      const locked = front();
      if (!locked.visible || !locked.top) fail('agentfront', `locked: unlock screen did not come to the front: ${JSON.stringify(locked)}`);
      open = true;
      if ((await waiting) !== true) fail('agentfront', 'locked: request did not continue after unlocking');
      if (win.isAlwaysOnTop()) fail('agentfront', 'locked: window stays on top after unlocking');
      if ((await ctx.waitForUnlock({ ms: 300, isOpen: () => false })) !== false) fail('agentfront', 'locked: no refusal when nobody unlocks');
      if (win.isAlwaysOnTop()) fail('agentfront', 'locked: window stays on top after giving up');
    });

    // ---- AI agents: "never ask again" for one entry shows "Revoke AI approval" in its context menu, which removes it
    await step('agenttrust', async () => {
      await js('document.querySelector(".context-menu")?.remove()');
      const entry = await save({ type: 'login', title: 'Smoke Trust', username: 'agent@contoso.com', password: 'x' });
      const menu = async () => {
        await js('document.querySelector(".context-menu")?.remove(); [...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === "Smoke Trust")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))');
        await sleep(300);
        return !!(await js('!!document.querySelector(".context-menu [data-action=agent-untrust]")'));
      };
      if (await menu()) fail('agenttrust', 'revoke offered for an entry without approval');
      ctx.trustAgentEntry({ agent: 'smoke-agent', vaultId: kvc.id, entryId: entry.id, title: entry.title });
      await sleep(400);
      if (!(await menu())) return fail('agenttrust', 'context menu offers no "Revoke AI approval" for a trusted entry');
      await js('document.querySelector(".context-menu [data-action=agent-untrust]")?.click()');
      await sleep(400);
      const text = String(await js('document.querySelector("dialog[open]")?.textContent || ""'));
      if (!text.includes('smoke-agent')) fail('agenttrust', `confirmation does not name the agent (${text.slice(0, 80)})`);
      await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
      for (let i = 0; i < 10 && (config.get().mcpTrusted || []).length; i++) await sleep(200);
      if ((config.get().mcpTrusted || []).length) fail('agenttrust', `approval not removed (${JSON.stringify(config.get().mcpTrusted)})`);
      let still = true;
      for (let i = 0; i < 5 && still; i++) still = await menu();
      if (still) fail('agenttrust', 'revoke still offered after revoking');
      await js('document.querySelector(".context-menu")?.remove()');
    });

    // ---- folders: drag a folder onto another one – it moves in with its entries; never into itself
    await step('folderdrag', async () => {
      await save({ type: 'login', title: 'Smoke in A', username: 'a', password: 'x', folder: 'Smoke A' });
      await save({ type: 'login', title: 'Smoke in B', username: 'b', password: 'x', folder: 'Smoke B' });
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      // Both folders must be on screen (the list redraws after each save).
      for (let i = 0; i < 15; i++) {
        await sleep(300);
        const rows = String(await js('[...document.querySelectorAll(".list .folder-row .row-title")].map((e) => e.textContent).join("|")'));
        if (rows.includes('Smoke A') && rows.includes('Smoke B')) break;
      }
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

    // ---- several folders and an entry selected together (Ctrl+click) and dragged into a folder at once (#11)
    await step('multidrag', async () => {
      await save({ type: 'login', title: 'Smoke in C', username: 'c', password: 'x', folder: 'Smoke C' });
      await save({ type: 'login', title: 'Smoke in D', username: 'd', password: 'x', folder: 'Smoke D' });
      await save({ type: 'login', title: 'Smoke in T', username: 't', password: 'x', folder: 'Smoke T' });
      await save({ type: 'login', title: 'Smoke loose', username: 'l', password: 'x' });
      await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
      for (let i = 0; i < 15; i++) {
        await sleep(300);
        const rows = String(await js('[...document.querySelectorAll(".list li.row-item .row-title")].map((e) => e.textContent).join("|")'));
        if (['Smoke C', 'Smoke D', 'Smoke T', 'Smoke loose'].every((x) => rows.includes(x))) break;
      }
      const row = (title) => `[...document.querySelectorAll(".list li.row-item")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent === ${JSON.stringify(title)})`;
      for (const title of ['Smoke C', 'Smoke D', 'Smoke loose']) {
        await js(`${row(title)}?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`);
        await sleep(250);
      }
      const sel = JSON.parse(await js(`JSON.stringify({ multi: [...document.querySelectorAll(".list li.row-item.multi .row-title")].map((e) => e.firstChild?.textContent), head: document.querySelector(".detail-pane .multi-selection h2")?.textContent || "" })`));
      if (['Smoke C', 'Smoke D', 'Smoke loose'].some((x) => !sel.multi.includes(x))) fail('multidrag', `Ctrl+click did not select folders and entry together (${sel.multi.join(", ")})`);
      if (!/2 Ordner/.test(sel.head)) fail('multidrag', `detail pane does not count the folders (${sel.head})`);
      const r = await js(`(() => {
        const src = ${row('Smoke C')}, dst = ${row('Smoke T')};
        if (!src || !dst) return "rows missing";
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
        dst.dispatchEvent(over);
        if (!over.defaultPrevented) return "target did not accept the selection";
        dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return "ok";
      })()`);
      if (r !== 'ok') fail('multidrag', r);
      const where = async () => Object.fromEntries((await vault.summaries()).filter((x) => x.containerId === kvc.id && /^Smoke (in [CDT]|loose)$/.test(x.title)).map((x) => [x.title, x.folder || '']));
      let w = {};
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        w = await where();
        if (w['Smoke loose'] === 'Smoke T' && w['Smoke in C'] === 'Smoke T/Smoke C' && w['Smoke in D'] === 'Smoke T/Smoke D') break;
      }
      const want = { 'Smoke in C': 'Smoke T/Smoke C', 'Smoke in D': 'Smoke T/Smoke D', 'Smoke in T': 'Smoke T', 'Smoke loose': 'Smoke T' };
      if (JSON.stringify(Object.keys(want).map((k) => w[k])) !== JSON.stringify(Object.values(want))) fail('multidrag', `after the drop: ${JSON.stringify(w)}`);
    });

    // ---- passkey: drag it from the entry onto another login in the list – it moves there (after one confirmation)
    // ---- a short entry shows no scrollbar in the detail pane (#25); the access report needs no sideways scrolling (#24)
    await step('noscroll', async () => {
      await save({ type: 'login', title: 'Smoke Kurz', username: 'kurz', password: 'x' });
      let pane = null;
      for (let i = 0; i < 3 && !pane?.title; i++) {
        await openItem('Smoke Kurz');
        pane = JSON.parse(await js('JSON.stringify((() => { const p = document.querySelector(".detail-pane"); return { title: /Smoke Kurz/.test(p?.innerText || ""), over: p.scrollHeight - p.clientHeight }; })())'));
      }
      if (!pane?.title) fail('noscroll', 'short entry did not open');
      else if (pane.over > 1) fail('noscroll', `detail pane scrolls by ${pane.over}px for a short entry`);
      await js('document.querySelector(".menu-btn")?.click()');
      await sleep(300);
      await js('document.querySelector(".main-menu [data-action=access]")?.click()');
      let report = null;
      for (let i = 0; i < 20 && !report?.rows; i++) {
        await sleep(300);
        report = JSON.parse(await js('JSON.stringify((() => { const d = document.querySelector("dialog[open].report-modal"); const tb = d?.querySelector(".table"); const b = d?.querySelector(".modal-body"); return d ? { rows: d.querySelectorAll(".table tbody tr").length, tableX: tb ? tb.scrollWidth - tb.clientWidth : 0, bodyX: b.scrollWidth - b.clientWidth, tableY: tb ? tb.scrollHeight - tb.clientHeight : 0 } : null; })())'));
      }
      if (!report?.rows) fail('noscroll', `access report did not show its table (${JSON.stringify(report)})`);
      else if (report.tableX > 1 || report.bodyX > 1 || report.tableY > 1) fail('noscroll', `access report scrolls: ${JSON.stringify(report)}`);
      await closeDialogs();
      // Password check (#26): a login on a website of the passkey directory without a passkey is recommended one.
      process.env.KVPWSAFE_TEST_PASSKEY_DIRECTORY = JSON.stringify({ 'smoke-passkey.example': { passwordless: 'allowed', documentation: 'https://smoke-passkey.example/help' } });
      await save({ type: 'login', title: 'Smoke Passkey-Seite', username: 'pk', password: 'Pk-Smoke-1', urls: ['https://login.smoke-passkey.example'] });
      const hr = await api.healthReport({ containerIds: [kvc.id] });
      if (!hr.passkeys?.some((p) => p.title === 'Smoke Passkey-Seite' && p.kind === 'passwordless')) fail('noscroll', `password check without the passkey recommendation (${JSON.stringify(hr.passkeys)})`);
      await js('document.querySelector(".menu-btn")?.click()');
      await sleep(300);
      await js('document.querySelector(".main-menu [data-action=health]")?.click()');
      let rec = '';
      for (let i = 0; i < 20 && !rec; i++) {
        await sleep(300);
        rec = String(await js('document.querySelector("dialog[open] .passkey-recommend")?.textContent || ""'));
      }
      if (!/Smoke Passkey-Seite/.test(rec)) fail('noscroll', 'password check does not show the passkey recommendation');
      delete process.env.KVPWSAFE_TEST_PASSKEY_DIRECTORY;
      await closeDialogs();
    });

    // ---- narrow window: the passkey sits flush in its field (no box inside the field box) and its name is not broken
    await step('passkeynarrow', async () => {
      await save({ type: 'login', title: 'Smoke Passkey schmal', username: 'unique@contoso-fabrikam.de', urls: ['https://login.microsoft.com'],
        passkeys: [{ credentialId: 'c21va2UtbmFycm93', rpId: 'login.microsoft.com', userName: 'unique@contoso-fabrikam.de', userHandle: 'dQ', privateKey: '', created: '2026-11-01T18:47:00Z' }] });
      // The entry is drawn after the list caught up with the save: wait for it, open it again if needed.
      for (let i = 0; i < 3 && !(await js('!!document.querySelector(".detail-pane .passkey-row")')); i++) {
        await openItem('Smoke Passkey schmal');
        for (let j = 0; j < 10 && !(await js('!!document.querySelector(".detail-pane .passkey-row")')); j++) await sleep(300);
      }
      const [w, h] = win.getSize();
      win.setSize(1000, 700);
      await sleep(900);
      const m = JSON.parse(await js(`JSON.stringify((() => {
        const row = document.querySelector(".detail-pane .field-card .passkey-row");
        const label = row?.closest(".field")?.querySelector("label");
        if (!row || !label) return { missing: true };
        const text = row.querySelector(".passkey-text > div");
        return { indent: Math.round(row.getBoundingClientRect().left - label.getBoundingClientRect().left), border: getComputedStyle(row).borderTopWidth,
          pane: Math.round(document.querySelector(".detail-pane").clientWidth), lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight || "20")) };
      })())`));
      await resizeTo(w, h, "passkeynarrow");
      await sleep(1000);
      if (m.missing) fail('passkeynarrow', `passkey row not shown: ${String(await js('document.querySelector(".detail-pane")?.innerText.slice(0, 160) || "no detail pane"')).replace(/\s+/g, ' ')}`);
      else if (m.pane > 520) fail('passkeynarrow', `detail pane not narrow in the small window: ${JSON.stringify(m)}`);
      else if (m.indent > 2 || m.border !== '0px') fail('passkeynarrow', `passkey indented in a narrow window: ${JSON.stringify(m)}`);
    });

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

    // ---- admin mode only with the PIN: a wrong PIN and a settings patch do not switch it on
    await step('adminpin', async () => {
      await ctx.ensurePin();
      if (await api.updateSettings({ adminTools: true }).then(() => true, () => false)) fail('adminpin', 'settings patch switched admin mode on');
      if (await api.activateAdminMode('0000').then(() => true, () => false)) fail('adminpin', 'wrong PIN switched admin mode on');
      ctx.resetPinGuard();
      if (config.get().adminTools) fail('adminpin', 'admin mode on without the right PIN');
      if (await js('[...document.querySelectorAll(".main-menu .seg")].some((s) => /Admin/.test(s.getAttribute("aria-label") || ""))')) fail('adminpin', 'old admin switch still in the menu');
    });

    // ---- admin mode: badge, devices tab, Microsoft entry tiles with sign-in for that account
    await step('admin', async () => {
      const msUser = 'smoke-admin@contoso.onmicrosoft.com';
      const msEntry = await save({ type: 'login', title: 'Smoke Microsoft', username: msUser, password: 'Ms-1', msAdmin: true, urls: ['https://login.microsoftonline.com'] });
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
      // No entry selected: the empty detail pane does not scroll (no scrollbar without content to scroll).
      const empty = JSON.parse(await js('JSON.stringify((() => { const p = document.querySelector(".detail-pane"); return { placeholder: !!p?.querySelector(":scope > .placeholder"), overflow: p ? p.scrollHeight - p.clientHeight : -1 }; })())'));
      if (!empty.placeholder || empty.overflow > 0) fail('admin', `empty detail pane scrolls: ${JSON.stringify(empty)}`);
      if (await js('!!document.querySelector(".sidebar .nav[data-view=passkeys], .sidebar [data-nav=passkeys]")')) fail('admin', 'passkey view among devices');
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=items]")?.click()');
      await sleep(400);
      await js('document.querySelector(".context-menu")?.remove()');
      await openItem('Smoke Microsoft');
      const tiles = await js('[...document.querySelectorAll(".detail-pane [data-admin-link]")].map((b) => b.dataset.adminLink).join(",")');
      for (const id of ['pim', 'm365', 'entra', 'intune', 'azure']) if (!String(tiles).split(',').includes(id)) fail('admin', `tile "${id}" missing`);
      // #7: PIM as the first, wide action; the centers in three groups, each tile with its own symbol on its colour.
      const panel = JSON.parse(await js(`JSON.stringify((() => {
        const p = document.querySelector(".detail-pane .admin-panel");
        const tiles = [...(p?.querySelectorAll(".admin-link") || [])];
        return {
          first: tiles[0]?.dataset.adminLink || "",
          groups: [...(p?.querySelectorAll(".admin-group") || [])].map((g) => g.dataset.adminGroup).join(","),
          bare: tiles.filter((b) => !b.querySelector(".admin-logo svg *") || getComputedStyle(b.querySelector(".admin-logo")).backgroundImage === "none").map((b) => b.dataset.adminLink),
          colors: new Set(tiles.map((b) => b.querySelector(".admin-logo")?.style.getPropertyValue("--c"))).size,
        };
      })())`));
      if (panel.first !== 'pim' || panel.groups !== 'identity,m365,azure') fail('admin', `admin panel layout: ${JSON.stringify(panel)}`);
      if (panel.bare.length || panel.colors < 8) fail('admin', `admin tiles without their own symbol/colour: ${JSON.stringify(panel)}`);
      ctx.clearSignIns();
      await js('document.querySelector(".detail-pane [data-admin-link=entra]")?.click()');
      await sleep(400);
      const msJob = await ctx.signInFor('login.microsoftonline.com');
      if (msJob?.username !== msUser) fail('admin', 'Entra tile does not sign in with the entry');
      // Azure portal family opens in the account's tenant: an account of another tenant in the browser is not taken silently.
      if (ctx.lastAdminUrl() !== 'https://entra.microsoft.com/#@contoso.onmicrosoft.com') fail('admin', `Entra not opened in the account's tenant (${ctx.lastAdminUrl()})`);
      const tenantUrls = {
        pim: ctx.adminCenterUrl('https://portal.azure.com/#view/Pim/Blade', 'a@Contoso.com'),
        intune: ctx.adminCenterUrl('https://intune.microsoft.com', 'admin@fabrikam.com'),
        m365: ctx.adminCenterUrl('https://admin.microsoft.com', 'a@contoso.com'),
        noDomain: ctx.adminCenterUrl('https://intune.microsoft.com', 'CONTOSO\\admin'),
      };
      if (tenantUrls.pim !== 'https://portal.azure.com/#@contoso.com/view/Pim/Blade' || tenantUrls.intune !== 'https://intune.microsoft.com/#@fabrikam.com'
        || tenantUrls.m365 !== 'https://admin.microsoft.com' || tenantUrls.noDomain !== 'https://intune.microsoft.com') fail('admin', `tenant links: ${JSON.stringify(tenantUrls)}`);
      // The extension prefers the passkey (and uses it without a click) when the job says the account has one.
      if (msJob?.passkey !== false) fail('admin', `job of an account without passkey says passkey=${msJob?.passkey}`);
      await vault.saveItem(kvc.id, { ...(await vault.getItem(kvc.id, msEntry.id)), passkeys: [{ credentialId: 'AQID', rpId: 'login.microsoft.com', userName: msUser, privateKey: 'x' }] });
      if ((await ctx.signInFor('login.microsoftonline.com'))?.passkey !== true) fail('admin', 'job of an account with passkey does not say so');
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
      // Credential Guard (#29): no saved credential for mstsc, the linked account's password goes to the clipboard.
      process.env.KVPWSAFE_TEST_CREDENTIAL_GUARD = '1';
      const cg = await api.connectServer({ containerId: kvc.id, id: win1.id, method: 'rdp' }).catch((e) => ({ error: e.message }));
      delete process.env.KVPWSAFE_TEST_CREDENTIAL_GUARD;
      if (fw && (!cg.credentialGuard || !cg.autoType)) fail('devices', `RDP with Credential Guard does not sign in by itself: ${JSON.stringify(cg)}`);
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

    // ---- Bastion: the VM account of an AD login always signs in with the FQDN (user@contoso.local)
    await step('bastionfqdn', async () => {
      const adLogin = await save({ type: 'login', title: 'Smoke AD', username: 'CONTOSO\\admin', password: 'Ad-1',
        fields: [{ name: 'Domäne (NT)', value: 'CONTOSO' }, { name: 'Domäne (FQDN)', value: 'contoso.local' }] });
      // Tenant of the VM (#30): the portal link opens in that directory, not in the one the link was copied from.
      const vm = await save({ type: 'server', title: 'Smoke BASTION', server: { kind: 'azurevm', host: '10.9.0.9', bastionUrl: 'https://portal.azure.com/#@contoso.com/resource/vm/bastionHost', bastionVmLink: `${kvc.id}/${adLogin.id}`, bastionTenant: 'Fabrikam.com' } });
      ctx.clearSignIns();
      const r = await api.connectServer({ containerId: kvc.id, id: vm.id, method: 'bastion' });
      if (r.url !== 'https://portal.azure.com/#@fabrikam.com/resource/vm/bastionHost') fail('bastionfqdn', `Bastion link not in the VM's tenant: ${r.url}`);
      const job = await ctx.signInFor('x.bastion.azure.com');
      if (job?.username !== 'admin@contoso.local') fail('bastionfqdn', `Bastion gets "${job?.username}" instead of admin@contoso.local`);
      // The extension fills the form and presses "Connect" for this job (#31).
      if (job?.mode !== 'bastion') fail('bastionfqdn', `Bastion job without connecting (mode ${job?.mode})`);
      ctx.clearSignIns();
    });

    // ---- sidebar and admin PIM (#19): the sidebar is never narrower than 280 px; in admin mode an optional PIM button
    // sits between the brand and the lock (Settings → View), off by default and gone outside admin mode
    await step('adminpim', async () => {
      await js('localStorage.setItem("paneWidths", JSON.stringify({ sidebar: 200 })); window.dispatchEvent(new Event("resize")); true');
      changed();
      await sleep(800);
      const width = await js('Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)');
      if (Number(width) < 280) fail('adminpim', `sidebar narrower than 280 px (${width})`);
      await js('localStorage.removeItem("paneWidths"); true');
      await setAdmin(true);
      if (await js('!!document.querySelector(".sidebar .pim-head")')) fail('adminpim', 'PIM button in the sidebar without being switched on');
      await openViewSettings();
      await js('document.querySelector("dialog[open] .view-settings .seg[aria-label=\'PIM-Knopf im Admin-Modus\'] button")?.click()');
      for (let i = 0; i < 10 && !config.get().adminPim; i++) await sleep(200);
      await closeDialogs();
      await sleep(400);
      const order = await js('(() => { const head = document.querySelector(".pim-head")?.parentElement; if (!head) return "missing"; const kids = [...head.children]; const i = (el) => kids.indexOf(el); return [i(head.querySelector(".brand-name")), i(head.querySelector(".pim-head")), i([...head.querySelectorAll(".icon-btn")].find((b) => b.querySelector(".icon-lock")))].join(","); })()');
      const [brand, pim, lock] = String(order).split(',').map(Number);
      if (order === 'missing' || !(brand < pim && pim < lock)) fail('adminpim', `PIM button not between brand and lock (${order})`);
      await setAdmin(false);
      if (await js('!!document.querySelector(".sidebar .pim-head")')) fail('adminpim', 'PIM button outside admin mode');
      config.update({ adminPim: false });
    });

    // ---- Windows locked (#28): the app locks too and asks for the PIN again (Windows' lock state is simulated)
    await step('winlock', async () => {
      process.env.KVPWSAFE_TEST_WINDOWS_LOCKED = '0';
      if (await ctx.lockIfWindowsLocked()) fail('winlock', 'locked although Windows is not locked');
      process.env.KVPWSAFE_TEST_WINDOWS_LOCKED = '1';
      if (!(await ctx.lockIfWindowsLocked())) fail('winlock', 'not locked while Windows is locked');
      let pinAsked = false;
      for (let i = 0; i < 10 && !pinAsked; i++) {
        await sleep(300);
        pinAsked = await js('!!document.querySelector(".pin-input")');
      }
      if (!pinAsked) fail('winlock', 'unlock screen without PIN after Windows was locked');
      delete process.env.KVPWSAFE_TEST_WINDOWS_LOCKED;
      const back = await (async () => {
        await api.verifyPin(await ctx.ensurePin());
        return api.unlock({ entra: true });
      })().catch((e) => ({ error: e.message }));
      if (!back?.opened) fail('winlock', `not unlocked again with the PIN (${back?.error || 'locked'})`);
      changed();
      await sleep(800);
      await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click()`);
      await sleep(500);
    });

    // ---- PIM on the unlock screen: off by default, switched on in Settings → View, then shown when locked
    // (last check: it locks the app and unlocks it again with the PIN)
    await step('pimlock', async () => {
      if (config.get().pimOnLock) fail('pimlock', 'PIM on the unlock screen is on by default');
      await openViewSettings();
      await js('document.querySelector("dialog[open] .view-settings .seg[aria-label=\'PIM beim Entsperren\'] button")?.click()');
      for (let i = 0; i < 10 && !config.get().pimOnLock; i++) await sleep(200);
      if (!config.get().pimOnLock) fail('pimlock', `Settings → View did not switch it on (${await js('JSON.stringify({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.querySelector("h3")?.textContent), rows: [...document.querySelectorAll("dialog[open] .view-settings .seg")].map((s) => s.getAttribute("aria-label")), menu: !!document.querySelector(".menu-btn"), opened: !!document.querySelector(".shell") })')})`);
      await closeDialogs();
      await api.lock();
      let shown = false;
      for (let i = 0; i < 15 && !shown; i++) {
        await sleep(300);
        shown = await js('!!document.querySelector(".pim-lock")');
      }
      if (!shown) fail('pimlock', 'no PIM button on the unlock screen');
      config.update({ pimOnLock: false });
      await api.verifyPin(await ctx.ensurePin());
      await api.unlock({ entra: true });
      changed();
      await sleep(800);
    });
  } finally {
    await cleanUp();
    config.update({ adminTools: false, theme: 'system', transparency: 'light' });
    changed();
    await sleep(500);
  }
}
