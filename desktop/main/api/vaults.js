// API: Key Vault vaults – adding and creating them, access and members, tenants and subscriptions, vault settings,
// license, logo.

import { app } from 'electron';
import { LockedError } from '../../auth.js';
import { buildInvite, parseInvite, ROLES } from '../../../extension/core/azure.js';
import { vaultHost, KV_SCOPE } from '../../../extension/core/keyvault.js';
import { mapLimit, decodeJwtPayload } from '../../../extension/core/util.js';
import { t } from '../../../extension/core/i18n.js';
import { ensureProvider, machineSetupStatus, runMachineSetup } from '../../windows-provider.js';
import { demo } from '../boot.js';
import { auth, config, files, opened, vault, win } from '../state.js';
import { api } from './index.js';
import { diag } from '../diag.js';
import { requireFeature, requireOpen } from '../guards.js';
import { changed, cleanEmail, containerResource, refreshAll, refreshing, send, signedIn } from '../session.js';

/** ARM/Graph for a subscription's tenant: own tenant directly, customer tenants with the guest account. */
const azureForSubscription = (tenantId) => (!tenantId || tenantId === auth.account?.tenantId ? vault.azure : vault.azureFor({ tenantId }));

export const vaultsApi = {
  /** Reloads one container (file from disk, Key Vault from the service). */
  async refreshContainer(containerId) {
    requireOpen();
    const c = await vault.container(containerId);
    if (c.kind === 'file') {
      send({ type: 'busy', containerId, busy: true });
      try {
        await files.get(containerId).load();
      } finally {
        send({ type: 'busy', containerId, busy: false });
      }
    } else {
      // Fast first: the index secrets (a few GETs, however many secrets the vault holds) – the list is current
      // right away. The full listing (pages of 25, slow with thousands of secrets) and the permissions follow in
      // the background, with a progress card; nothing waits for them.
      const id = `refresh:${containerId}`;
      const run = { name: c.name, started: Date.now(), pages: 0, secrets: 0 };
      send({ type: 'progress', id, label: t('„{name}“ wird abgeglichen …', { name: c.name }), step: 'fast', detail: t('Schnell-Index wird geladen …') });
      await vault.refreshIndexFast([containerId]);
      changed();
      refreshing.set(containerId, run);
      send({ type: 'progress', id, step: 'list', detail: t('Secrets werden aufgelistet …') });
      const session = vault;
      (async () => {
        try {
          await session.refreshIndex([containerId]);
          const listed = Date.now();
          // Diagnostics: many pages with few secrets point to a vault full of deleted or disabled secrets.
          if (listed - run.started > 3000) diag(`LIST ${containerId} pages=${run.pages} secrets=${run.secrets} ${listed - run.started}ms`);
          send({ type: 'progress', id, step: 'access', detail: t('Zugriffsrechte werden geprüft …'), total: 0 });
          await session.refreshAccess().catch(() => {});
          const entries = (await session.index())[containerId]?.items?.length ?? 0;
          send({ type: 'progress', id, step: 'done', detail: t('Fertig – {n} Einträge', { n: entries }) });
        } finally {
          refreshing.delete(containerId);
          send({ type: 'progress', id, end: true });
        }
        if (session === vault && opened) changed();
      })().catch(() => {});
    }
    changed();
    return api.state();
  },

  // Key Vault containers
  async addContainer(input, name) {
    const invite = parseInvite(input);
    const id = vaultHost(invite.vaultUrl);
    const s = config.get();
    const containers = s.containers.filter((c) => vaultHost(c.vaultUrl) !== id);
    containers.push({ name: name || invite.name || id.split('.')[0], vaultUrl: invite.vaultUrl });
    config.update({ containers, hiddenContainers: s.hiddenContainers.filter((x) => x !== id) });
    if (opened) await refreshAll();
    return id;
  },
  async removeContainer(id) {
    const c = await vault.container(id).catch(() => null);
    if (c?.kind === 'file') {
      files.remove(id);
      return;
    }
    const s = config.get();
    config.update({
      containers: s.containers.filter((x) => vaultHost(x.vaultUrl) !== id),
      hiddenContainers: [...new Set([...s.hiddenContainers, id])],
    });
    if (opened) await refreshAll();
  },
  async invite(containerId) {
    return buildInvite(await vault.container(containerId));
  },
  members: async (containerId) => (await vault.azureForId(containerId)).listMembers(await containerResource(containerId)),
  /** Info dialog: Azure facts of the vault plus who administers it. */
  vaultInfo: async (containerId) => {
    requireOpen();
    const azure = await vault.azureForId(containerId);
    const resourceId = await containerResource(containerId);
    const [details, members] = await Promise.all([azure.vaultDetails(resourceId), azure.listMembers(resourceId).catch(() => [])]);
    return { ...details, admins: members.filter((m) => m.level === 'manage').map((m) => ({ displayName: m.displayName, detail: m.detail || '' })) };
  },
  addMember: async (containerId, principal, level) => (await vault.azureForId(containerId)).addMember(await containerResource(containerId), principal, level),
  removeMember: async (containerId, principalId) => (await vault.azureForId(containerId)).removeMember(await containerResource(containerId), principalId),
  /** People picker in the directory of the container's tenant (guests included). */
  searchPrincipals: async (query, containerId) => (containerId ? await vault.azureForId(containerId) : vault.azure).searchPrincipals(query),
  machineSetupStatus: () => machineSetupStatus(),
  /** Elevated device setup (UAC), then retry the per-user provider installation. */
  async runMachineSetup() {
    const code = await runMachineSetup();
    if (code) throw new Error(t('Die Einrichtung meldet Fehler (Code {code}) – Details im Protokoll setup.log unter ProgramData › Keevault', { code }));
    const status = config.get().windowsProvider ? await ensureProvider(`${app.getVersion()}.0`) : null;
    return { status, machine: await machineSetupStatus() };
  },
  vaultTenantCheck: async (containerId) => vault.azure.vaultTenantCheck(await containerResource(containerId)),
  async fixVaultTenant(containerId) {
    const resourceId = await containerResource(containerId);
    const check = await vault.azure.vaultTenantCheck(resourceId);
    if (!check.mismatch) return api.state();
    await vault.azure.setVaultTenant(resourceId, check.subscriptionTenant);
    await vault.learnTenant(containerId, check.subscriptionTenant);
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Diagnosis: the identity Key Vault sees (claims of the token for the vault's tenant). */
  async vaultIdentity(containerId) {
    const c = await vault.container(containerId);
    const claims = decodeJwtPayload(await auth.getToken(KV_SCOPE, c.tenantId ? { tenantId: c.tenantId } : {}));
    const name = claims.upn || claims.unique_name || claims.email || claims.preferred_username || '';
    return {
      tenantId: claims.tid,
      objectId: claims.oid,
      name,
      // acct 1 = guest; external identities also carry an idp claim pointing to their home tenant.
      guest: claims.acct === 1 || /#EXT#/i.test(name) || (!!claims.idp && !String(claims.idp).toLowerCase().includes(String(claims.tid).toLowerCase())),
      homeTenant: claims.idp?.match(/[0-9a-f-]{36}/)?.[0] || claims.tid,
    };
  },
  /** Owner of a vault without a data role (e.g. Owner on the subscription): grant yourself access. */
  /** Vault settings for the dialog: { admin, canBecomeAdmin, features, updated, updatedBy } */
  async policyState(containerId) {
    const c = await vault.container(containerId);
    const p = await vault.policy(containerId);
    return { admin: !!c.access?.admin, canBecomeAdmin: !c.access?.admin && !!c.access?.manage, ...p };
  },
  async setPolicy(containerId, features) {
    const c = await vault.container(containerId);
    if (!c.access?.admin) throw new Error(t('Nur Key Vault-Administratoren können die Tresor-Einstellungen ändern.'));
    const r = await vault.setPolicy(containerId, features);
    changed();
    return r;
  },
  /** Whoever may assign roles (Manage) can make themselves Key Vault Administrator. */
  async makeMeAdmin(containerId) {
    const azure = await vault.azureForId(containerId);
    await azure.assignRole(await containerResource(containerId), (await azure.me()).id, 'User', ROLES.kvAdministrator);
    await new Promise((r) => setTimeout(r, demo ? 0 : 8000));
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  async grantMyself(containerId, level = 'write') {
    const azure = await vault.azureForId(containerId);
    await azure.addMember(await containerResource(containerId), await azure.me(), level);
    // Azure RBAC takes a moment to apply.
    await new Promise((r) => setTimeout(r, demo ? 0 : 8000));
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Invites an external person as guest into the container's tenant and grants the chosen level. */
  async inviteGuest(containerId, email, level) {
    const azure = await vault.azureForId(containerId);
    const guest = await azure.inviteGuest(cleanEmail(email));
    const r = await azure.addMember(await containerResource(containerId), guest, level);
    return { ...r, guest };
  },
  tenants: () => vault.azure.listTenants(),
  async signInTenant(tenantId) {
    await auth.signInTenant(tenantId, KV_SCOPE);
    win?.show();
    win?.focus();
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /**
   * Key Vaults for the picker, from the own tenant and every guest tenant. Default: only vaults set up as
   * password containers on which the user has data access; all: every visible vault (no access check).
   */
  async vaults({ all = false } = {}) {
    const known = new Set((await vault.containers()).map((c) => c.id));
    const home = auth.account?.tenantId;
    const found = new Map();
    const collect = async (azure, tenantId) => {
      for (const v of await azure.listVaults()) {
        const id = vaultHost(v.vaultUrl);
        if (!found.has(id)) found.set(id, { ...v, tenantId: v.tenantId || tenantId, added: known.has(id) });
      }
    };
    await collect(vault.azure, home);
    const tenants = await vault.azure.listTenants().catch(() => []);
    await mapLimit(tenants.filter((x) => x.tenantId !== home), 3, (x) => collect(vault.azureFor({ tenantId: x.tenantId, silentOnly: true }), x.tenantId).catch(() => {}));
    let list = [...found.values()];
    if (!all) {
      // Only vaults with a readable container marker (pws-container): proves set-up + data access in one go.
      await mapLimit(list, 8, async (v) => {
        v.meta = v.added ? { name: v.name } : await vault.probeVault(v);
      });
      list = list.filter((v) => v.meta).map(({ meta, ...v }) => ({ ...v, name: meta.name || v.name, container: true }));
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  },
  /** Switches the directory (tenant) of the signed-in account; '' = the account's home directory. */
  async switchTenant(tenantId) {
    config.update({ tenantId });
    if (!signedIn()) return api.state();
    await auth.switchTenant();
    const discoverError = await refreshAll();
    changed();
    return { ...(await api.state()), discoverError };
  },
  /**
   * Subscriptions for new containers: those of the signed-in tenant and of every tenant where the account is a
   * guest. via: 'home' (own tenant), 'guest' (customer tenant with guest account) or 'lighthouse' (only
   * visible through Azure Lighthouse – no data roles, no guests possible there).
   */
  async subscriptions() {
    const home = auth.account?.tenantId;
    const out = new Map();
    for (const s of await vault.azure.listSubscriptions()) {
      if (s.state !== 'Enabled') continue;
      // Lighthouse: the subscription belongs to the customer's tenant but is reached with tokens of the home tenant –
      // so ARM calls (resource groups, locations) use the home tenant; customerTenantId only for display.
      const lighthouse = !!s.tenantId && s.tenantId !== home;
      out.set(s.subscriptionId, { id: s.subscriptionId, name: s.displayName, tenantId: home, customerTenantId: lighthouse ? s.tenantId : null, via: lighthouse ? 'lighthouse' : 'home' });
    }
    const tenants = await vault.azure.listTenants().catch(() => []);
    await mapLimit(tenants.filter((x) => x.tenantId !== home), 3, async (x) => {
      try {
        for (const s of await vault.azureFor({ tenantId: x.tenantId, silentOnly: true }).listSubscriptions()) {
          if (s.state === 'Enabled') out.set(s.subscriptionId, { id: s.subscriptionId, name: s.displayName, tenantId: x.tenantId, via: 'guest', tenantName: x.name });
        }
      } catch {
        // No silent token for that tenant: its subscriptions stay as seen from home (if at all).
      }
    });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
  resourceGroups: async (subscriptionId, tenantId) => (await azureForSubscription(tenantId).listResourceGroups(subscriptionId))
    .map((g) => ({ name: g.name, location: g.location }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  locations: (subscriptionId, tenantId) => azureForSubscription(tenantId).listLocations(subscriptionId),
  /** Rights in a resource group: may a new vault be created / roles be assigned there? */
  groupPermissions: (subscriptionId, tenantId, resourceGroup) => azureForSubscription(tenantId).groupPermissions(subscriptionId, resourceGroup),
  /** Vaults of a resource group with their state (readable, already a container, empty). */
  async groupVaults(subscriptionId, tenantId, resourceGroup) {
    const vaults = await azureForSubscription(tenantId).listVaultsInGroup(subscriptionId, resourceGroup);
    const known = new Set((await vault.containers()).map((c) => c.id));
    return mapLimit(vaults, 6, async (v) => ({ ...v, added: known.has(vaultHost(v.vaultUrl)), ...(await vault.inspectVault({ ...v, tenantId: v.tenantId || tenantId })) }));
  },
  /**
   * Uses an existing, empty vault as container: marks it (pws-container), names it and grants access.
   * opts: { subscriptionId, tenantId, via, vaultUrl, resourceId, displayName, members, guests }
   */
  async adoptVault(opts) {
    if (!signedIn()) throw new LockedError();
    if (opts.via === 'lighthouse') throw new Error(t('Über Azure Lighthouse lässt sich hier kein nutzbarer Tresor anlegen (siehe Hinweis).'));
    const tenantId = opts.tenantId || auth.account.tenantId;
    const azure = azureForSubscription(tenantId);
    const state = await vault.inspectVault({ vaultUrl: opts.vaultUrl, tenantId });
    if (!state.readable) throw new Error(t('Auf diesen Key Vault hast du keinen Datenzugriff ({message})', { message: state.error || '403' }));
    if (!state.empty && !state.marked) throw new Error(t('Der Key Vault ist nicht leer – bitte einen leeren wählen oder einen neuen anlegen'));
    await vault.initVault({ vaultUrl: opts.vaultUrl, tenantId, name: opts.displayName });
    const warnings = [];
    await azure.setVaultDisplayName(opts.resourceId, opts.displayName).catch(() => {});
    for (const m of opts.members || []) {
      await azure.addMember(opts.resourceId, m.principal, m.level).catch((e) => warnings.push(t('{who}: {message}', { who: m.principal.displayName, message: e.message })));
    }
    for (const g of opts.guests || []) {
      try {
        await azure.addMember(opts.resourceId, await azure.inviteGuest(cleanEmail(g.email)), g.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: g.email, message: e.message }));
      }
    }
    const s = config.get();
    const id = vaultHost(opts.vaultUrl);
    config.update({ containers: [...s.containers.filter((c) => vaultHost(c.vaultUrl) !== id), { name: opts.displayName, vaultUrl: opts.vaultUrl, tenantId }] });
    await refreshAll();
    return { id, warnings };
  },
  /** People picker in a given tenant (new container in a customer tenant). */
  searchPrincipalsIn: (query, tenantId) => azureForSubscription(tenantId).searchPrincipals(query),
  /**
   * opts: { subscriptionId, tenantId, via, resourceGroup, location, name, displayName, purgeProtection,
   *   members: [{ principal, level }], guests: [{ email, level }] }
   */
  async createContainer(opts) {
    if (!signedIn()) throw new LockedError();
    if (opts.via === 'lighthouse') {
      throw new Error(t('Diese Subscription siehst du nur über Azure Lighthouse. Ein Key Vault, auf den ihr zugreifen könnt, muss im Kunden-Tenant angelegt werden: Lass dich dort als Gast einladen und gib deinem Gastkonto Besitzer (oder Mitwirkender + Benutzerzugriffsadministrator) auf der Ressourcengruppe.'));
    }
    // The vault must trust the tenant the subscription belongs to; in a customer tenant we act as guest.
    const sub = await azureForSubscription(opts.tenantId).arm('GET', `/subscriptions/${opts.subscriptionId}`, '2022-12-01');
    const tenantId = sub?.tenantId || opts.tenantId || auth.account.tenantId;
    const foreign = tenantId !== auth.account.tenantId;
    const azure = azureForSubscription(tenantId);
    const creatorObjectId = foreign ? (await azure.me()).id : auth.account.localAccountId;
    const result = await azure.createContainer({ ...opts, tenantId, creatorObjectId });
    const warnings = [...result.warnings];
    for (const m of opts.members || []) {
      try {
        await azure.addMember(result.container.resourceId, m.principal, m.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: m.principal.displayName, message: e.message }));
      }
    }
    for (const g of opts.guests || []) {
      try {
        await azure.addMember(result.container.resourceId, await azure.inviteGuest(cleanEmail(g.email)), g.level);
      } catch (e) {
        warnings.push(t('{who}: {message}', { who: g.email, message: e.message }));
      }
    }
    const s = config.get();
    config.update({ containers: [...s.containers, { name: result.container.name, vaultUrl: result.container.vaultUrl, ...(foreign ? { tenantId } : {}) }] });
    // New role assignments take a few minutes: mark the vault as container (pws-container) in the background.
    (async () => {
      for (let i = 0; i < 20; i++) {
        try {
          await vault.initVault({ vaultUrl: result.container.vaultUrl, tenantId, name: result.container.name });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    })();
    await refreshAll();
    const id = vaultHost(result.container.vaultUrl);
    if (foreign) await vault.learnTenant(id, tenantId);
    return { id, warnings };
  },

  /**
   * Renames a container: file → inside the file (everyone sees it); Key Vault → tag on the vault if the rights
   * allow (everyone sees it), in any case for this app.
   */
  async renameContainer(containerId, name) {
    await requireFeature(containerId, 'rename');
    const clean = String(name || '').trim();
    if (!clean) throw new Error(t('Bitte einen Namen eingeben'));
    const c = await vault.container(containerId);
    let warning = null;
    if (c.kind === 'file') {
      await files.rename(containerId, clean);
    } else {
      try {
        await vault.azureFor(c).setVaultDisplayName(await containerResource(containerId), clean);
      } catch (e) {
        warning = t('Nur für dich umbenannt – für alle bräuchte es Schreibrechte auf der Key-Vault-Ressource ({message})', { message: e.message });
      }
      const s = config.get();
      const others = s.containers.filter((x) => vaultHost(x.vaultUrl) !== containerId);
      const own = s.containers.find((x) => vaultHost(x.vaultUrl) === containerId);
      config.update({ containers: [...others, { ...(own || {}), name: clean, vaultUrl: c.vaultUrl, ...(c.tenantId ? { tenantId: c.tenantId } : {}) }] });
      await refreshAll();
    }
    changed();
    return { warning };
  },

  licenseState: (containerId) => vault.licenseState(containerId),
  async setLicense(containerId, key) {
    const r = await vault.setContainerLicense(containerId, key);
    changed();
    return r;
  },
  containerLogo: (containerId) => vault.containerLogo(containerId),
  async setContainerLogo(containerId, dataUrl) {
    await requireFeature(containerId, 'logo');
    await vault.setContainerLogo(containerId, dataUrl);
    changed();
  },
};
