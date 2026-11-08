// #479: renaming a Key Vault is for managers only (refused in the main process); no raw Azure text in the window.
import { until } from './smoke-wait.js';

export async function renameCheck({ js, fail, vault, api, kvc }) {
  const stored = (await vault.store.get('containers')) || [];
  const own = stored.find((x) => x.id === kvc.id);
  if (!own) return;
  const savedAccess = own.access;
  // The admin of the vault enabled renaming (vault settings), so the refusal comes from the manager check in the session
  // (renameInVault), not from the vault settings that block a non-admin before it.
  const savedPolicy = (await vault.policy(kvc.id))?.features || {};
  await vault.setPolicy(kvc.id, { ...savedPolicy, rename: true });
  own.access = { ...(savedAccess || {}), manage: false, admin: false };
  await vault.store.set('containers', stored);
  let reason = 'renamed';
  try {
    reason = await api.renameContainer(kvc.id, 'Smoke Name').then(() => 'renamed', (e) => e.message);
    if (!/Verwaltungsrechte|manage rights/.test(reason)) fail('rename', `a non-manager was not refused (${reason})`);
    if ((await vault.container(kvc.id)).name === 'Smoke Name') fail('rename', 'a non-manager renamed the vault');
  } finally {
    own.access = savedAccess;
    await vault.store.set('containers', stored);
    await vault.setPolicy(kvc.id, savedPolicy);
  }
  if (await js('document.body.innerText.includes("/subscriptions/")')) fail('rename', '/subscriptions/ visible in the window');
  await sameNameCheck({ js, fail, vault, kvc });
}

// #479 review: two vaults with the same display name show their host in the sidebar, so a copied name can't pose as the other.
async function sameNameCheck({ js, fail, vault, kvc }) {
  const stored = (await vault.store.get('containers')) || [];
  const other = stored.find((x) => x.id !== kvc.id);
  if (!other) return;
  const savedName = other.name;
  const savedMeta = other.metaName;
  other.name = kvc.name;
  other.metaName = null;
  await vault.store.set('containers', stored);
  try {
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    const hosts = `[...document.querySelectorAll(".sidebar .nav-host")].map((e) => e.textContent)`;
    const shown = await until(() => js(`${hosts}.includes(${JSON.stringify(kvc.id)}) && ${hosts}.includes(${JSON.stringify(other.id)})`), 5000);
    if (!shown) fail('rename', `same display name: hosts not shown in the sidebar (${await js(`${hosts}.join("|")`)})`);
  } finally {
    other.name = savedName;
    other.metaName = savedMeta;
    await vault.store.set('containers', stored);
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
  }
  const otherHost = `[...document.querySelectorAll(".sidebar .nav-host")].some((e) => e.textContent === ${JSON.stringify(other.id)})`;
  if (!savedMeta && await until(async () => !(await js(otherHost)), 5000) === false) fail('rename', 'host label stays after the names differ again');
  // The vault choice of the new-entry editor lists only vaults one can write to (helpers.js writable: no read-only access,
  // no error, not locked). When the other vault is not one of them in this run, the choice is checked on this one.
  const choosable = async (id) => { const c = await vault.container(id); return c.access?.write !== false && !c.error && !c.locked; };
  const otherChoosable = await choosable(other.id);
  await vaultNameHostCheck({ js, fail, vault, other, choice: otherChoosable });
  if (!otherChoosable) {
    if (!(await choosable(kvc.id))) fail('rename', 'no Key Vault in the demo that the vault choice lists');
    else await vaultNameHostCheck({ js, fail, vault, other: kvc, choice: true });
  }
}

// #479 review: a name that comes from the vault (metaName) and differs from the Key Vault's own name always shows the
// host, in the sidebar and in the vault choice of the new-entry editor.
async function vaultNameHostCheck({ js, fail, vault, other, choice }) {
  const stored = (await vault.store.get('containers')) || [];
  const own = stored.find((x) => x.id === other.id);
  if (!own) return;
  const saved = { name: own.name, metaName: own.metaName };
  own.name = 'Smoke Fremdname';
  own.metaName = 'Smoke Fremdname';
  await vault.store.set('containers', stored);
  try {
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    const host = JSON.stringify(other.id);
    const inSidebar = await until(() => js(`[...document.querySelectorAll(".sidebar .nav-host")].some((e) => e.textContent === ${host})`), 5000);
    if (!inSidebar) fail('rename', 'name from the vault: host not shown in the sidebar');
    await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".new-split .new-more")?.click(); document.querySelector(".context-menu [data-action=new-login]")?.click(); true');
    const options = `[...(document.querySelector(".detail-pane select[name=container]")?.options || [])].map((o) => o.value + "=" + o.textContent)`;
    const listed = await until(() => js(`${options}.length > 0`), 4000);
    if (!listed) fail('rename', 'new-entry editor without vault choice');
    else if (choice && !(await js(`${options}.includes(${JSON.stringify(`${other.id}=Smoke Fremdname (${other.id})`)})`))) {
      fail('rename', `name from the vault: host missing in the vault choice (${await js(`${options}.join("|")`)})`);
    }
    await js('[...document.querySelectorAll(".detail-pane button")].find((b) => /^(Abbrechen|Cancel)$/.test(b.textContent.trim()))?.click(); true');
  } finally {
    own.name = saved.name;
    own.metaName = saved.metaName;
    await vault.store.set('containers', stored);
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
  }
}
