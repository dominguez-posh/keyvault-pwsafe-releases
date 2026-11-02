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
  // Admin mode the way a person switches it: menu → "Activate admin mode …" → app PIN; "End admin mode" without.
  const setAdmin = async (on) => {
    const pin = on ? await ctx.ensurePin() : '';
    await js('document.querySelector(".main-menu")?.remove(); document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-tab=main]")?.click()');
    await sleep(300);
    await js(`document.querySelector(".main-menu [data-action=${on ? 'admin-on' : 'admin-off'}]")?.click()`);
    await sleep(400);
    if (on) {
      await js(`(() => { const p = document.querySelector("dialog[open] .admin-pin"); if (p) { p.value = ${JSON.stringify(pin)}; } document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(); })()`);
    }
    for (let i = 0; i < 10 && config.get().adminTools !== on; i++) await sleep(300);
    await sleep(600);
    if (config.get().adminTools !== on) fail('admin', `menu did not switch admin mode ${on ? 'on' : 'off'}`);
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
  // The window is drawn completely (sidebar and list) – slow machines (GitHub runners) are still redrawing otherwise.
  const uiReady = async () => {
    for (let i = 0; i < 40; i++) {
      if (await js('!!document.querySelector(".sidebar .nav") && !!document.querySelector(".list-pane .list-scroll")')) return;
      await sleep(250);
    }
    if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log('[features] UI not ready:', await js('JSON.stringify({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.slice(0, 200)), body: document.body.innerText.slice(0, 300) })'));
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
        if (action === 'settings' && !(await js('!!document.querySelector("dialog[open] select[name=updateChannel] option[value=beta]")'))) fail('mainmenu', 'settings without the update channel (Stable / Early Access)');
        await closeDialogs();
        await sleep(200);
      }
      const segClick = async (label, text) => {
        await openMenu();
        await js('document.querySelector(".main-menu [data-tab=view]")?.click()');
        await js(`[...document.querySelectorAll('.main-menu .seg[aria-label="${label}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
        await sleep(400);
      };
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
      await sleep(200);
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
      for (const a of ['new-server', 'new-microsoft', 'new-ad']) if (items.includes(a)) fail('newmenu', `"${a}" offered without admin mode`);
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
      if (r.side > 240) fail('narrowsidebar', );
      if (r.side > 240) fail('narrowsidebar', `dragging the splitter did not narrow the sidebar (${r.side}px)`);
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

    // ---- Bastion: the VM account of an AD login always signs in with the FQDN (user@contoso.local)
    await step('bastionfqdn', async () => {
      const adLogin = await save({ type: 'login', title: 'Smoke AD', username: 'CONTOSO\\admin', password: 'Ad-1',
        fields: [{ name: 'Domäne (NT)', value: 'CONTOSO' }, { name: 'Domäne (FQDN)', value: 'contoso.local' }] });
      const vm = await save({ type: 'server', title: 'Smoke BASTION', server: { kind: 'azurevm', host: '10.9.0.9', bastionUrl: 'https://portal.azure.com/#@contoso.com/resource/vm/bastionHost', bastionVmLink: `${kvc.id}/${adLogin.id}` } });
      ctx.clearSignIns();
      await api.connectServer({ containerId: kvc.id, id: vm.id, method: 'bastion' });
      const job = await ctx.signInFor('x.bastion.azure.com');
      if (job?.username !== 'admin@contoso.local') fail('bastionfqdn', `Bastion gets "${job?.username}" instead of admin@contoso.local`);
      ctx.clearSignIns();
    });
  } finally {
    await cleanUp();
    config.update({ adminTools: false, theme: 'system', transparency: 'light' });
    changed();
    await sleep(500);
  }
}
