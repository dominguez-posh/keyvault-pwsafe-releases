// Smoke check (#476) "Nur für mich": only in admin mode; in a subfolder the menu item is greyed out with the tooltip;
// in the root: notice → entry at the very top with its marker. A second (demo) member's private entry stays hidden from
// the list and from what the extension, the bridge and MCP read (vault.summaries without `others`); the Verwalter switch
// "Auch private Einträge anderer Benutzer anzeigen" (off by default) shows it with the owner's name, and "Öffentlich für
// alle" sets it back. Moving a private entry into a folder is refused (drag/Ctrl+X/V save, move dialog).
// Part of the feature checks (desktop/smoke-features.js).

import { until } from './smoke-wait.js';

const ROOT_ONLY = 'Nur im Root-Ordner möglich – bitte verschieben, wenn die Funktion gewünscht ist.';
const NOTICE = 'Der Eintrag wird nur dir angezeigt und für die anderen Mitglieder ausgeblendet.';
const FOLDER = 'Smoke Privat-Ordner';
const OWN_ONLY = 'Nur für eigene Einträge möglich';
const VERSIONS = 'Auch frühere Versionen des Eintrags werden für alle sichtbar.';

// The title of a list row without its badges ("Nur für mich", the owner's name, passkey …), which sit in .row-title too.
const TITLE_OF = '((r) => r.querySelector(".row-title")?.firstChild?.textContent.trim())';

export async function privateCheck({ js, sleep, fail, save, openItem, vault, api, kvc, config, changed, setAdmin, isAdmin }) {
  const wasAdmin = isAdmin();
  const row = (title) => `[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => ${TITLE_OF}(r) === ${JSON.stringify(title)})`;
  const menuFor = async (title) => {
    await js('document.querySelector(".context-menu")?.remove()');
    await js(`(() => { const r = ${row(title)}; const b = r?.getBoundingClientRect(); r?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: (b?.left || 0) + 40, clientY: (b?.top || 0) + 10 })); })()`);
    await until(() => js('!!document.querySelector(".context-menu")'), 1500);
    return JSON.parse(await js(`JSON.stringify([...document.querySelectorAll(".context-menu button[data-action^=private]")].map((b) => ({ action: b.dataset.action, disabled: b.disabled, title: b.title || "", label: b.textContent.trim() })))`));
  };
  const listTitles = () => js(`JSON.stringify([...document.querySelectorAll(".list li.row-item[data-key]")].map(${TITLE_OF}))`).then(JSON.parse);
  const showOthers = async (on) => {
    await js('document.querySelector(".main-menu")?.remove(); document.querySelector(".menu-btn")?.click()');
    if (!(await until(() => js('!!document.querySelector(".main-menu .private-others-row")'), 1500))) return false;
    await js(`[...document.querySelectorAll(".main-menu .private-others-row .seg button")].find((b) => /^(${on ? 'An|On' : 'Aus|Off'})$/.test(b.textContent.trim()))?.click()`);
    await sleep(800);
    await js('document.querySelector(".main-menu")?.remove()');
    return true;
  };
  const backToRoot = async () => { await js('document.querySelector(".folder-crumb .icon-btn")?.click()'); await sleep(300); };
  // The vault's own view (root folder): private entries stand above the folders there.
  const toVault = async () => { await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(kvc.name)}))?.click()`); await sleep(500); await backToRoot(); };

  const root = await save({ type: 'login', title: 'Smoke Privat', username: 'privat@kunde.example', password: 'Pv-1' });
  await save({ type: 'login', title: 'Smoke Privat im Ordner', username: 'ordner', password: 'Pv-2', folder: FOLDER });
  const other = await save({ type: 'login', title: 'Smoke Privat Bob', username: 'bob@kunde.example', password: 'Pv-3' });
  try {
    // Outside admin mode the menu item does not exist.
    await setAdmin(false);
    await openItem('Smoke Privat');
    if ((await menuFor('Smoke Privat')).length) fail('"Nur für mich" offered outside admin mode');
    await setAdmin(true);
    await toVault();

    // Subfolder: greyed out with exactly this tooltip.
    await openItem('Smoke Privat im Ordner', FOLDER);
    const inFolder = (await menuFor('Smoke Privat im Ordner')).find((a) => a.action === 'private-on');
    if (!inFolder) fail('subfolder: no "Nur für mich" in the entry menu');
    else if (!inFolder.disabled || inFolder.title !== ROOT_ONLY) fail(`subfolder: menu item not greyed out with the tooltip ${JSON.stringify(inFolder)}`);
    await js('document.querySelector(".context-menu")?.remove()');
    await backToRoot();

    // Root: active → notice → on top with its marker.
    await openItem('Smoke Privat');
    const inRoot = (await menuFor('Smoke Privat')).find((a) => a.action === 'private-on');
    if (!inRoot || inRoot.disabled) fail(`root: "Nur für mich" not active ${JSON.stringify(inRoot)}`);
    await js('document.querySelector(".context-menu button[data-action=private-on]")?.click()');
    if (!(await until(() => js(`(document.querySelector("dialog[open]")?.textContent || "").includes(${JSON.stringify(NOTICE)})`), 2000))) fail('no notice window before "Nur für mich"');
    await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
    if (!(await until(async () => (await vault.getItem(kvc.id, root.id, { fresh: true })).privateOwner !== '', 4000))) fail('the entry was not set to "Nur für mich"');
    await toVault();
    const first = await js(`(() => { const r = document.querySelector(".list li.row-item[data-key]"); return JSON.stringify({ title: r && ${TITLE_OF}(r), badge: r?.querySelector(".badge.private")?.textContent.trim() || "", me: r?.querySelector(".badge.private")?.dataset.owner }); })()`).then(JSON.parse);
    if (first.title !== 'Smoke Privat' || !/^(Nur für mich|Only for me)$/.test(first.badge) || first.me !== 'me') fail(`private entry not at the very top with its marker ${JSON.stringify(first)}`);

    // Refused: into a folder by save (drag, Ctrl+X/V) and by the move dialog.
    const mine = await vault.getItem(kvc.id, root.id, { fresh: true });
    if (await api.save(kvc.id, { ...mine, folder: FOLDER }, mine.version).then(() => true, () => false)) fail('a private entry was moved into a folder (save)');
    if (await api.move(kvc.id, kvc.id, root.id, { folder: FOLDER }).then(() => true, () => false)) fail('a private entry was moved into a folder (move)');
    if ((await vault.getItem(kvc.id, root.id, { fresh: true })).folder) fail('the private entry is no longer in the root folder');

    // #476 review: someone else's public entry – a member without "Verwalten" gets the item greyed out with the tooltip,
    // and the main process refuses it too; a Verwalter may set it.
    const foreign = await save({ type: 'login', title: 'Smoke Privat fremd', username: 'fremd', password: 'Pv-4', createdBy: 'jemand.anders@contoso.example' });
    const storedContainers = await vault.store.get('containers');
    await vault.store.set('containers', storedContainers.map((x) => (x.id === kvc.id ? { ...x, access: { ...x.access, manage: false } } : x)));
    try {
      if ((await vault.container(kvc.id)).access?.manage) fail('could not take "Verwalten" away for the check');
      changed();
      await sleep(800);
      await openItem('Smoke Privat fremd');
      const foreignItem = (await menuFor('Smoke Privat fremd')).find((a) => a.action === 'private-on');
      if (!foreignItem || !foreignItem.disabled || foreignItem.title !== OWN_ONLY) fail(`someone else's entry: menu item not greyed out with the tooltip ${JSON.stringify(foreignItem)}`);
      await js('document.querySelector(".context-menu")?.remove()');
      if (await api.setPrivate(kvc.id, foreign.id, true).then(() => true, () => false)) fail('someone else\'s entry was set to "Nur für mich" by a member without "Verwalten"');
      if ((await vault.getItem(kvc.id, foreign.id, { fresh: true })).privateOwner) fail('someone else\'s entry is private after the refusal');
    } finally {
      await vault.store.set('containers', storedContainers);
      changed();
    }
    if (!(await api.setPrivate(kvc.id, foreign.id, true).then(() => true, () => false))) fail('a Verwalter could not set someone else\'s entry to "Nur für mich"');
    else await api.setPrivate(kvc.id, foreign.id, false).catch((e) => fail(`back to public: ${e.message}`));
    await sleep(500);

    // A second member's private entry: hidden from the list and from everything without the admin view.
    const bob = await vault.getItem(kvc.id, other.id, { fresh: true });
    await vault.saveItem(kvc.id, bob, { expectedVersion: bob.version, privacy: { owner: 'u-bob-smoke', name: 'Bob Demo' } });
    changed();
    await sleep(800);
    if ((await listTitles()).includes('Smoke Privat Bob')) fail('another member\'s private entry is in the list');
    if ((await vault.summaries()).some((s) => s.id === other.id)) fail('another member\'s private entry reaches extension, bridge and MCP');
    if ((await api.items()).some((s) => s.id === other.id)) fail('another member\'s private entry is in the window\'s list (switch off)');

    // Verwalter switch on: shown with the owner's name, then back to "Öffentlich für alle".
    if (!(await showOthers(true))) fail('admin mode: no switch "Auch private Einträge anderer Benutzer anzeigen" for the Verwalter');
    else {
      if (!(await until(async () => (await listTitles()).includes('Smoke Privat Bob'), 3000))) fail('switch on: the other member\'s private entry is not shown');
      const badge = await js(`(${row('Smoke Privat Bob')})?.querySelector(".badge.private")?.textContent || ""`);
      if (!badge.includes('Bob Demo')) fail(`switch on: no owner's name at the entry ("${badge}")`);
      const back = (await menuFor('Smoke Privat Bob')).find((a) => a.action === 'private-off');
      if (!back || back.disabled) fail('switch on: no "Öffentlich für alle" for the other member\'s entry');
      await js('document.querySelector(".context-menu button[data-action=private-off]")?.click()');
      if (!(await until(() => js(`(document.querySelector("dialog[open]")?.textContent || "").includes(${JSON.stringify(VERSIONS)})`), 2000))) fail('no notice window with the earlier versions before "Öffentlich für alle"');
      await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
      if (!(await until(async () => (await vault.summaries()).some((s) => s.id === other.id && !s.privateOwner), 4000))) fail('"Öffentlich für alle" did not set the entry back');
      await showOthers(false);
      if (config.get().showOthersPrivate) fail('the switch did not go off');
    }
    // Off again with admin mode.
    await setAdmin(false);
    if (config.get().showOthersPrivate) fail('"Auch private Einträge anderer Benutzer anzeigen" stays on after admin mode');
  } finally {
    await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".main-menu")?.remove()');
    await setAdmin(wasAdmin);
  }
}
