// #480: vault settings ("Tresor-Vorgaben") – only a Verwalter writes them (refused in the main process), the look shows in
// the sidebar, the vault head and for the extension, the folder order is the vault's. Each group adds its check below.
import { totpCode } from '../extension/core/totp.js';
import { until } from './smoke-wait.js';

const refresh = (js) => js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');

/** Runs fn as Verwalter (manage) or as plain member of the vault; the stored access comes back afterwards. */
async function asRole(vault, kvc, manage, fn) {
  const stored = (await vault.store.get('containers')) || [];
  const own = stored.find((x) => x.id === kvc.id);
  const saved = own?.access;
  if (own) own.access = { ...(saved || {}), read: true, write: true, manage, admin: false };
  await vault.store.set('containers', stored);
  try {
    return await fn();
  } finally {
    const again = (await vault.store.get('containers')) || [];
    const back = again.find((x) => x.id === kvc.id);
    if (back) back.access = saved;
    await vault.store.set('containers', again);
  }
}

export async function vaultProfileCheck({ js, fail, vault, api, kvc, bridge, save, openItem, ensurePin }) {
  const fail480 = (msg) => fail('vault-profile', msg);
  // A member is refused by the main process, whatever the window does.
  await asRole(vault, kvc, false, async () => {
    const why = await api.setVaultSettings(kvc.id, { look: { color: 'blue' } }).then(() => 'written', (e) => e.message);
    if (!/Verwaltungsrechte|manage rights/.test(why)) fail480(`a member wrote the vault settings (${why})`);
  });
  const before = (await api.vaultSettings(kvc.id)).settings;
  try {
    await asRole(vault, kvc, true, async () => {
      await lookCheck({ js, fail480, vault, api, kvc, bridge });
      for (const check of GROUP_CHECKS) await check({ js, fail480, vault, api, kvc, bridge, save, openItem, ensurePin });
    });
  } finally {
    await asRole(vault, kvc, true, () => api.setVaultSettings(kvc.id, before).catch((e) => fail480(`restore: ${e.message}`)));
    await refresh(js);
  }
}

/** Checks of the later groups (contact, rules, protection) – appended by their commits. */
export const GROUP_CHECKS = [contactCheck, rulesCheck, protectCheck];

// Group 2: an invalid address is refused, the contact shows at "Kein Zugriff" and opens only mailto: with the stored address.
async function contactCheck({ js, fail480, vault, api, kvc }) {
  const bad = await api.setVaultSettings(kvc.id, { contact: { name: 'Max', email: 'javascript:alert(1)' } }).then(() => 'saved', (e) => e.message);
  if (bad === 'saved') fail480('contact: an invalid mail address was saved');
  // Review 0.9.33: no mailto: header fields through the address.
  const badMail = await api.setVaultSettings(kvc.id, { contact: { name: 'x', email: 'it?bcc=evil@example.test' } }).then(() => 'saved', (e) => e.message);
  if (badMail === 'saved') fail480('contact: an address with "?" was saved');
  await api.setVaultSettings(kvc.id, { contact: { name: 'Smoke Kontakt', email: 'kontakt@example.test' } });
  const index = await vault.index();
  const saved = index[kvc.id];
  index[kvc.id] = { ...saved, error: { status: 403, message: 'Forbidden', code: 'Forbidden' } };
  await vault.store.set('index', index);
  try {
    await refresh(js);
    await js(`document.querySelector(${JSON.stringify(`.sidebar .nav-row[data-vault="${kvc.id}"] button.nav`)})?.click(); true`);
    const shown = await until(() => js('(document.querySelector(".list-pane .vault-contact")?.textContent || "").includes("Smoke Kontakt")'), 5000);
    if (!shown) fail480('contact: not shown at "Kein Zugriff"');
    globalThis.kvSmokeMailto = '';
    await js('document.querySelector(".list-pane .vault-contact button")?.click(); true');
    if (!(await until(() => globalThis.kvSmokeMailto === 'mailto:kontakt@example.test', 3000))) fail480(`contact: mail not opened with the stored address (${globalThis.kvSmokeMailto})`);
  } finally {
    const again = await vault.index();
    again[kvc.id] = saved;
    await vault.store.set('index', again);
    await refresh(js);
  }
}

async function lookCheck({ js, fail480, api, kvc, bridge }) {
  const tops = [...new Set((await api.items()).filter((i) => i.containerId === kvc.id && i.folder).map((i) => i.folder.split('/')[0]))];
  const order = [...tops].sort((a, b) => b.localeCompare(a)); // reverse of the alphabetical default
  const saved = await api.setVaultSettings(kvc.id, { look: { color: 'green', icon: 'server', description: 'Smoke Beschreibung', folderOrder: order } });
  if (saved.look.color !== 'green' || saved.look.icon !== 'server') fail480(`look not saved (${JSON.stringify(saved.look)})`);
  // A value nobody may set is dropped (an insider could write it into the secret directly).
  const odd = await api.setVaultSettings(kvc.id, { look: { color: 'url(javascript:x)', icon: 'server', description: 'Smoke Beschreibung', folderOrder: order } });
  if (odd.look.color !== '') fail480('a colour outside the palette was kept');
  await api.setVaultSettings(kvc.id, { look: { color: 'green', icon: 'server', description: 'Smoke Beschreibung', folderOrder: order } });
  await refresh(js);
  const row = `.sidebar .nav-row[data-vault="${kvc.id}"]`;
  const inSidebar = await until(() => js(`!!document.querySelector(${JSON.stringify(`${row} .vault-symbol[data-vault-color="green"]`)})`), 5000);
  if (!inSidebar) fail480('sidebar: the vault symbol does not carry the vault colour');
  await js(`document.querySelector(${JSON.stringify(`${row} button.nav`)})?.click(); true`);
  const head = await until(() => js('document.querySelector(".list-title .vault-description")?.textContent === "Smoke Beschreibung"'), 5000);
  if (!head) fail480('vault head: the short description is missing');
  if (order.length > 1) {
    // The vault's root: an earlier check may have left a folder open.
    for (let i = 0; i < 3 && (await js('!!document.querySelector(".list-pane .folder-crumb .icon-btn")')); i++) {
      await js('document.querySelector(".list-pane .folder-crumb .icon-btn").click(); true');
      await until(() => false, 300);
    }
    const shown = await until(() => js(`(() => { const f = [...document.querySelectorAll(".list-pane li.folder-row")].map((e) => e.dataset.folder); return f.length > 1 && f[0] === ${JSON.stringify(order[0])}; })()`), 5000);
    if (!shown) fail480(`folder order of the vault not applied (${await js('[...document.querySelectorAll(".list-pane li.folder-row")].map((e) => e.dataset.folder).join("|")')})`);
  }
  // The extension gets colour, symbol and description of the vault – nothing else of the settings.
  const hello = await bridge.hello();
  const forExt = hello.containers.find((c) => c.id === kvc.id);
  if (forExt?.look?.color !== 'green' || forExt.look.description !== 'Smoke Beschreibung') fail480(`extension: look missing (${JSON.stringify(forExt?.look)})`);
  if (forExt && ('vaultSettings' in forExt || 'protect' in (forExt.look || {}))) fail480('extension: more of the settings than the look');
}

// Group 3: age notice, required fields (refused in the main process), template without secrets in the "New" menu,
// generator defaults in the editor.
async function rulesCheck({ js, fail480, vault, api, kvc, save, openItem }) {
  // A save always stamps today's date (#500 never takes passwordChanged from the input), so the old password is a demo
  // entry with an old date (extension/core/demo.js, "Firewall Admin"); the entry saved here is the counter-check.
  const old = await save({ type: 'login', title: 'Smoke Alt', username: 'alt', password: 'Smoke-Geheim-480', urls: ['https://alt.example.test'] });
  await api.setVaultSettings(kvc.id, { rules: { generator: { length: 40, lower: true, upper: true, digits: true, symbols: false }, maxAgeMonths: 3 } });
  await refresh(js);
  const limit = Date.now() - 4 * 31 * 24 * 3600 * 1000;
  let aged = null;
  for (const s of (await vault.summaries()).filter((x) => x.containerId === kvc.id && x.type === 'login')) {
    const item = await vault.getItem(kvc.id, s.id).catch(() => null);
    if (item?.password && Date.parse(item.passwordChanged || '') < limit) { aged = item; break; }
  }
  if (!aged) fail480('rules: the demo vault has no entry with an old password (extension/core/demo.js)');
  else {
    await openItem(aged.title, aged.folder || undefined);
    if (!(await until(() => js('!!document.querySelector(".detail-pane .password-age")'), 5000))) fail480(`rules: no notice for a password older than the vault allows (${aged.title})`);
  }
  await openItem('Smoke Alt');
  await new Promise((r) => setTimeout(r, 800));
  if (await js('!!document.querySelector(".detail-pane .password-age")')) fail480('rules: notice for a password changed today');
  // Template from that entry: its password never goes in.
  await api.addVaultTemplate(kvc.id, old.id, 'Smoke Vorlage');
  const tpl = (await api.vaultSettings(kvc.id)).settings.rules.templates.find((x) => x.name === 'Smoke Vorlage');
  if (!tpl) fail480('rules: template not saved');
  else if (JSON.stringify(tpl).includes('Smoke-Geheim-480')) fail480('rules: the template holds the password');
  await refresh(js);
  await js(`document.querySelector(${JSON.stringify(`.sidebar .nav-row[data-vault="${kvc.id}"] button.nav`)})?.click(); true`);
  // The menu is built from the vault list of the window: open it again until the redraw after saving has the template.
  const offered = await until(() => js(`(() => {
    document.querySelector(".context-menu")?.remove();
    document.querySelector(".new-split .new-more")?.click();
    return [...document.querySelectorAll(".context-menu [data-action=new-template]")].some((b) => b.textContent.includes("Smoke Vorlage"));
  })()`), 6000, 300);
  if (!offered) fail480('rules: the vault template is missing in the "New" menu');
  else {
    await js('[...document.querySelectorAll(".context-menu [data-action=new-template]")].find((b) => b.textContent.includes("Smoke Vorlage")).click(); true');
    if (!(await until(() => js('document.querySelector(".detail-pane input[name=username]")?.value === "alt"'), 4000))) fail480('rules: the template does not fill the new entry');
    if (await js('document.querySelector(".detail-pane input[name=password]")?.value !== ""')) fail480('rules: a password came from the template');
    await js('[...document.querySelectorAll(".detail-pane button")].find((b) => /Passwort generieren|Generate password/.test(b.title))?.click(); true');
    const length = await until(() => js('document.querySelector(".detail-pane .generator input[type=range]")?.value'), 3000);
    if (length !== '40') fail480(`rules: the generator does not start with the vault's length (${length})`);
    await js('[...document.querySelectorAll(".detail-pane button")].find((b) => /^(Abbrechen|Cancel)$/.test(b.textContent.trim()))?.click(); true');
  }
  // Required fields: a save without them is refused by the main process, with the field names.
  await api.setVaultSettings(kvc.id, { rules: { required: { login: ['username', 'urls', 'notes'] } } });
  const why = await api.save(kvc.id, { type: 'login', title: 'Smoke Pflicht', password: 'x' }).then(async (s) => { await api.delete(kvc.id, s.id).catch(() => {}); return 'saved'; }, (e) => e.message);
  if (!/Pflichtfelder|Required fields/.test(why)) fail480(`rules: a login without its required fields was saved (${why})`);
}

// Group 4: copy without the app PIN, export and "Nur für mich" are refused by the main process – also from the browser.
async function protectCheck({ js, fail480, api, vault, kvc, bridge, save, ensurePin }) {
  const entry = await save({ type: 'login', title: 'Smoke Schutz', username: 'schutz', password: 'Smoke-Schutz-480', urls: ['https://schutz.example.test'], notes: 'n' });
  await api.setVaultSettings(kvc.id, { rules: {}, protect: { pinCopy: true, pinExport: true, noExport: true, private: 'forbid' } });
  const shown = await api.item(kvc.id, entry.id); // what the window gets – its secrets now need the PIN to be copied
  const fromWindow = await api.copy(shown.password, kvc.id).then(() => 'copied', (e) => e.name);
  if (!['CopyPinRequired', 'AppPinMissing'].includes(fromWindow)) fail480(`protect: copy from the window without the app PIN (${fromWindow})`);
  const unnamed = await api.copy(shown.password).then(() => 'copied', (e) => e.name);
  if (!['CopyPinRequired', 'AppPinMissing'].includes(unnamed)) fail480(`protect: copy without naming the vault went through (${unnamed})`);
  await bridge.item({ containerId: kvc.id, itemId: entry.id });
  const fromBrowser = await bridge.copy({ text: shown.password }).then(() => 'copied', (e) => e.message);
  if (fromBrowser === 'copied') fail480('protect: the extension copied a password of the vault without the app PIN');
  // Review 0.9.33: a TOTP code the extension computes itself needs the PIN as well.
  const otp = await save({ type: 'login', title: 'Smoke Schutz OTP', username: 'otp', password: 'Smoke-Otp-480', urls: ['https://schutz.example.test'], notes: 'n', totp: 'JBSWY3DPEHPK3PXP' });
  const served = await bridge.item({ containerId: kvc.id, itemId: otp.id });
  const code = (await totpCode(served.totp)).code;
  const otpCopy = await bridge.copy({ text: code }).then(() => 'copied', (e) => e.message);
  if (otpCopy === 'copied') fail480('protect: the extension copied a TOTP code of the vault without the app PIN');
  await api.delete(kvc.id, otp.id).catch(() => {});
  // Review 0.9.33: the export lock holds through the personal vault (moving there is refused with the reason).
  const personal = (await vault.containers()).find((c) => c.personal);
  if (personal) {
    const moved = await api.move(kvc.id, personal.id, entry.id).then(() => 'moved', (e) => e.message);
    if (!/sperrt den Export|locks export/.test(moved)) fail480(`protect: move into the personal vault not refused for the export lock (${moved})`);
  }
  // With the app PIN confirmed, the lock of the vault still refuses the export.
  const token = await api.confirmExportPin(kvc.id, await ensurePin()).catch(() => null);
  const exported = await api.exportItems(kvc.id, token).then(() => 'exported', (e) => e.message);
  if (!/gesperrt|locked/.test(exported)) fail480(`protect: export not refused (${exported})`);
  const priv = await api.setPrivate(kvc.id, entry.id, true).then(() => 'private', (e) => e.message);
  if (!/nicht erlaubt|not allowed/.test(priv)) fail480(`protect: "Nur für mich" not refused (${priv})`);
  await refresh(js);
  await js(`document.querySelector(${JSON.stringify(`.sidebar .nav-row[data-vault="${kvc.id}"] button.nav`)})?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50 })); true`);
  if (await until(() => js('!!document.querySelector(".context-menu [data-action=export]")'), 1500)) fail480('protect: the vault menu still offers the export');
  await js('document.querySelector(".context-menu")?.remove(); true');
  await api.setVaultSettings(kvc.id, { protect: {} });
}
