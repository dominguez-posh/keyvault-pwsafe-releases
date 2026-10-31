// Vault session shared by the extension service worker and the desktop app. Container kinds:
//   keyvault  Azure Key Vault, optionally with extra protection (keyring secret + encrypted entries)
//   file      local file container (desktop app, adapter)
//   remote    file containers of the desktop app, seen from the extension (adapter over native messaging)
// State lives in a pluggable async store (chrome.storage.session in the extension, memory in the desktop app).

import { KeyVaultClient, KV_SCOPE, normalizeVaultUrl, vaultHost } from './keyvault.js';
import { AzureClient, ARM_SCOPE, GRAPH_SCOPE } from './azure.js';
import { serializeItem, summaryFromSecret, parseItem, isItemSecret, newItemId } from './model.js';
import { itemMatchesHost } from './match.js';
import { filterPasskeys } from './webauthn.js';
import { mapLimit, sleep, truncateBytes } from './util.js';
import { t } from './i18n.js';
import { normalizeFolder, requireFolderDepth } from './model.js';
import { FREE_LIMIT, LicenseLimitError, requestCode, verifyLicense } from './license.js';
import { isImageDataUrl } from './image.js';
import {
  ContainerKey, ContainerLockedError, setupKeyring, unlockKeyring, applyKeyringOp, describeKeyring, passkeyEntries, mergeKeyrings,
} from './protect.js';

export const KEYRING_SECRET = 'pws-keyring';
const KEYRING_TYPE = 'application/vnd.kvpwsafe.keyring+json; v=1';
const SEALED_TAGS = ['n', 'u', 'h', 'rp', 'f', 'fav', 'otp', 'ic'];
import { INDEX_SECRET, INDEX_TYPE, INDEX_TAG, shardName, isIndexSecret, encodeIndex, decodeIndex, sameSummaries } from './fastindex.js';

const SEALED = 'kvpwsafe-sealed';
const FAST_INDEX_DELAY = 1500; // ms: changes in quick succession become one index write
const FAST_INDEX_JITTER = 20_000; // ms: random extra delay so that many apps do not write the same index at once (the
// listing stays the truth; the index only speeds up the next start, so a few seconds later do not matter)
const FOLDERS_SECRET = 'pws-folders';
const LOGO_SECRET = 'pws-logo'; // up to 0.4: logo only; now part of pws-container
// Marks a Key Vault as password container (unique ID, name, logo). Readable only with data access, so finding
// it proves both: the vault is a container and the user may use it.
export const CONTAINER_SECRET = 'pws-container';
export const CONTAINER_FORMAT = 'kvpwsafe-container';
const CONTAINER_TYPE = 'application/vnd.kvpwsafe.container+json; v=1';
const LOGO_TYPE = 'application/vnd.kvpwsafe.logo; v=1';
const FOLDERS_TYPE = 'application/vnd.kvpwsafe.folders+json; v=1';

// Vault settings of the admins (Key Vault Administrator): which functions everyone else may use. Restrictive by
// default – everything off until an admin turns it on. Enforced by the app; Azure roles still apply on top.
export const POLICY_SECRET = 'pws-policy';
const POLICY_TYPE = 'application/vnd.kvpwsafe.policy+json; v=1';
export const POLICY_FEATURES = ['folders', 'rename', 'logo', 'import', 'export', 'protection', 'purge'];
export const DEFAULT_POLICY = Object.fromEntries(POLICY_FEATURES.map((f) => [f, false]));
export const POLICY_LABELS = {
  folders: 'Ordner anlegen, umbenennen und löschen',
  rename: 'Tresor umbenennen',
  logo: 'Logo des Tresors ändern',
  import: 'Einträge importieren',
  export: 'Einträge exportieren (unverschlüsselt, CSV)',
  protection: 'Zusätzlichen Schutz ein- oder ausschalten',
  purge: 'Einträge endgültig aus dem Papierkorb löschen',
};

export class ConflictError extends Error {
  constructor() {
    super(t('Der Eintrag wurde inzwischen von jemand anderem geändert. Bitte neu laden und erneut speichern.'));
    this.name = 'ConflictError';
  }
}

export class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key);
  }
  async set(key, value) {
    this.map.set(key, structuredClone(value));
  }
  async remove(key) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async clear() {
    this.map.clear();
  }
}

const isSealedValue = (value) => typeof value === 'string' && value.startsWith(`{"${SEALED}"`);

export class VaultSession {
  /**
   * @param {{ getToken, store, fetch?, actor, adapters?: Record<string, object> }} options
   * adapters (per kind): containers(), summaries(id), getItem(id, itemId), saveItem(id, item, opts), deleteItem(id, itemId),
   * trash(id), restore(id, itemId), purge(id, itemId), history(id, itemId), getVersion(id, itemId, v),
   * passkeyCandidates(rpId), protectionInfo(id, rpId), unlock(id, params), lock(id), updateKeyring(id, op)
   */
  constructor({ getToken, store, fetch: fetchImpl, actor, adapters = {}, multiTenant = false, onBusy = null, onProgress = null }) {
    // onProgress(containerId, done, total): listing progress of a full refresh (total = size of the last index,
    // 0 when unknown) – the desktop shows it as a progress card for big vaults.
    this.onProgress = onProgress;
    this.multiTenant = multiTenant;
    this.getToken = getToken;
    this.store = store;
    this.fetch = fetchImpl;
    this.actor = actor;
    this.adapters = adapters;
    // onBusy(containerId, busy): called when a vault's listing/index load starts and ends (sidebar spinner).
    this.onBusy = onBusy;
    this.busyCount = new Map();
    this.keys = new Map();
    this.mutex = Promise.resolve();
    this.azure = new AzureClient({
      getArmToken: (o) => this.getToken(ARM_SCOPE, o),
      getGraphToken: (o) => this.getToken(GRAPH_SCOPE, o),
      fetch: fetchImpl,
    });
  }

  locked(fn) {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => {});
    return run;
  }

  kv(container) {
    return new KeyVaultClient({
      vaultUrl: container.vaultUrl,
      tenantId: container.tenantId,
      getToken: (o) => this.getToken(KV_SCOPE, o),
      onTenant: (tenantId) => this.learnTenant(container.id, tenantId),
      fetch: this.fetch,
    });
  }

  /** Azure Resource Manager / Graph in the tenant of a container (customer vaults, guest access). */
  azureFor(container) {
    if (!container?.tenantId) return this.azure;
    const { tenantId, silentOnly } = container;
    return new AzureClient({
      getArmToken: (o) => this.getToken(ARM_SCOPE, { ...o, tenantId, ...(silentOnly ? { silentOnly } : {}) }),
      getGraphToken: (o) => this.getToken(GRAPH_SCOPE, { ...o, tenantId, ...(silentOnly ? { silentOnly } : {}) }),
      fetch: this.fetch,
    });
  }

  async azureForId(containerId) {
    return this.azureFor(await this.container(containerId));
  }

  /**
   * Access level for containers whose rights are not known yet – e.g. added by hand (no resource ID) or in a
   * tenant that was only learned from the vault's answer. Looks the vault up in its own tenant.
   */
  async refreshAccess() {
    const stored = (await this.store.get('containers')) || [];
    let changed = false;
    await mapLimit(stored.filter((c) => !c.access), 4, async (c) => {
      try {
        const azure = this.azureFor(c);
        if (!c.resourceId) c.resourceId = (await azure.findVault(c.vaultUrl))?.resourceId || null;
        if (c.resourceId) {
          c.access = await azure.myAccess(c.resourceId);
          changed = true;
        }
      } catch {
        // Still unknown (no ARM read access).
      }
    });
    if (changed) await this.store.set('containers', stored);
    return changed;
  }

  /** Remembers the tenant of a vault (learned from a Key Vault challenge). */
  async learnTenant(containerId, tenantId) {
    const known = (await this.store.get('vaultTenants')) || {};
    if (known[containerId] === tenantId) return;
    await this.store.set('vaultTenants', { ...known, [containerId]: tenantId });
    const stored = (await this.store.get('containers')) || [];
    await this.store.set('containers', stored.map((c) => (c.id === containerId ? { ...c, tenantId } : c)));
  }

  /** Discovery in the default tenant plus (desktop) every other tenant the account belongs to, silently. */
  /** tenants=false: only the home tenant (fast start; other tenants follow in a second run). */
  async discoverAll({ tenants: otherTenants = true } = {}) {
    const found = [...(await this.azure.discoverContainers())];
    if (!this.multiTenant || !otherTenants) return found;
    let tenants = [];
    try {
      tenants = await this.azure.listTenants();
    } catch {
      return found;
    }
    await mapLimit(tenants, 3, async (x) => {
      const azure = new AzureClient({
        getArmToken: (o) => this.getToken(ARM_SCOPE, { ...o, tenantId: x.tenantId, silentOnly: true }),
        getGraphToken: (o) => this.getToken(GRAPH_SCOPE, { ...o, tenantId: x.tenantId, silentOnly: true }),
        fetch: this.fetch,
      });
      try {
        for (const c of await azure.discoverContainers()) found.push({ ...c, tenantId: c.tenantId || x.tenantId });
      } catch {
        // Tenant needs an interactive sign-in (MFA, consent) or blocks the client: skip.
      }
    });
    return found;
  }

  adapter(container) {
    const a = this.adapters[container.kind];
    if (!a) throw new Error(t('Tresor nicht gefunden'));
    return a;
  }

  // ---------------------------------------------------------------- containers

  async adapterContainers() {
    const out = [];
    for (const [kind, adapter] of Object.entries(this.adapters)) {
      try {
        for (const c of await adapter.containers()) out.push({ ...c, kind });
      } catch {
        // Adapter not available (e.g. desktop app not running).
      }
    }
    return out;
  }

  /** All containers: Key Vault (with protection state from the index) and adapter containers. */
  async containers() {
    const stored = (await this.store.get('containers')) || [];
    const index = await this.index();
    const kv = stored.map((c) => ({ ...c, kind: 'keyvault', protected: !!index[c.id]?.protected, locked: !!index[c.id]?.locked }));
    return [...kv, ...(await this.adapterContainers())];
  }

  async container(id) {
    const c = (await this.containers()).find((x) => x.id === id);
    if (!c) throw new Error(t('Tresor nicht gefunden'));
    return c;
  }

  /** Rebuilds the Key Vault container list from configured entries (policy, manual) and ARM discovery. */
  /**
   * tenants=false: discovery in the home tenant only; access=false: no role check per vault (refreshAccess() later).
   * Both make the first view after unlocking fast; the desktop app runs the full refresh right after in the background.
   */
  async refreshContainers({ configured = [], hidden = [], discover = true, tenants = true, access = true } = {}) {
    const map = new Map();
    const learned = (await this.store.get('vaultTenants')) || {};
    // What the last run found out (resource ID looked up for hand-added vaults, the user's rights) stays until
    // this run replaces it – otherwise admin functions flicker away after every unlock and ARM is asked again.
    const known = new Map(((await this.store.get('containers')) || []).map((c) => [c.id, c]));
    const add = (c, source) => {
      const vaultUrl = normalizeVaultUrl(c.vaultUrl);
      const id = vaultHost(vaultUrl);
      const prev = map.get(id);
      const old = known.get(id);
      map.set(id, {
        id,
        vaultUrl,
        name: prev?.sources.includes('manual') && prev.name ? prev.name : c.name || prev?.name || id.split('.')[0],
        resourceId: c.resourceId || prev?.resourceId || old?.resourceId || null,
        tenantId: c.tenantId || prev?.tenantId || old?.tenantId || learned[id] || null,
        rbac: c.rbac ?? prev?.rbac ?? old?.rbac ?? null,
        sources: [...new Set([...(prev?.sources || []), source])],
        access: prev?.access ?? old?.access ?? null,
      });
    };
    for (const c of configured) {
      try {
        add(c, c.source || 'manual');
      } catch {
        // Invalid configured entries are skipped.
      }
    }
    let discoverError = null;
    if (discover) {
      try {
        for (const c of await this.discoverAll({ tenants })) add(c, 'discovered');
      } catch (e) {
        discoverError = e.message;
      }
    }
    const list = [...map.values()]
      .filter((c) => !(hidden.includes(c.id) && c.sources.every((s) => s === 'discovered')))
      .sort((a, b) => a.name.localeCompare(b.name));
    await mapLimit(list, 4, async (c) => {
      if (!c.resourceId || !access) return;
      try {
        c.access = await this.azureFor(c).myAccess(c.resourceId);
      } catch (e) {
        c.access = null;
        c.accessError = e.message;
      }
    });
    await this.store.set('containers', list);
    return { containers: await this.containers(), discoverError };
  }

  // ---------------------------------------------------------------- protection of Key Vault containers

  /** Forgets all container keys but keeps containers and index: protected vaults need their passkey again. */
  async lockKeys() {
    this.keys.clear();
    for (const key of await this.store.keys()) {
      if (key.startsWith('ck:')) await this.store.remove(key);
    }
  }

  async containerKey(containerId) {
    const raw = await this.store.get(`ck:${containerId}`);
    if (!raw) return null;
    const cached = this.keys.get(containerId);
    if (cached?.exported === raw) return cached;
    const key = await ContainerKey.fromRaw(raw);
    this.keys.set(containerId, key);
    return key;
  }

  async requireKey(containerId) {
    const key = await this.containerKey(containerId);
    if (!key) throw new ContainerLockedError();
    return key;
  }

  async readKeyring(container) {
    try {
      return JSON.parse((await this.kv(container).getSecret(KEYRING_SECRET)).value);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async writeKeyring(container, keyring) {
    const current = await this.readKeyring(container);
    const merged = current && current.id === keyring.id ? mergeKeyrings(keyring, current) : keyring;
    await this.kv(container).setSecret(KEYRING_SECRET, JSON.stringify(merged), { contentType: KEYRING_TYPE, tags: { kvpwsafe: 'keyring' } });
    return merged;
  }

  /** Container metadata of a vault (or null if it is not marked as container). */
  async readContainerMeta(client) {
    try {
      const meta = JSON.parse((await client.getSecret(CONTAINER_SECRET)).value);
      return meta?.format === CONTAINER_FORMAT ? meta : null;
    } catch (e) {
      if (e.status === 404 || e instanceof SyntaxError) return null;
      throw e;
    }
  }

  async writeContainerMeta(client, patch) {
    const current = (await this.readContainerMeta(client).catch(() => null))
      || { format: CONTAINER_FORMAT, v: 1, id: crypto.randomUUID(), created: new Date().toISOString() };
    const next = { ...current, ...patch, updated: new Date().toISOString() };
    await client.setSecret(CONTAINER_SECRET, JSON.stringify(next), { contentType: CONTAINER_TYPE, tags: { kvpwsafe: 'container' } });
    return next;
  }

  /** Key Vault client for a vault that is not (yet) a container of this session; silent tokens only. */
  probeClient({ vaultUrl, tenantId }) {
    return new KeyVaultClient({
      vaultUrl, tenantId, fetch: this.fetch,
      getToken: (o) => this.getToken(KV_SCOPE, { ...o, ...(o?.tenantId || tenantId ? { tenantId: o?.tenantId || tenantId } : {}), silentOnly: true }),
    });
  }

  /** Is the vault a password container the user can read? → its metadata, otherwise null. */
  async probeVault(v) {
    return this.readContainerMeta(this.probeClient(v)).catch(() => null);
  }

  /** For "use an existing empty vault": readable, marked as container, empty. */
  async inspectVault(v) {
    try {
      const secrets = await this.probeClient(v).listSecrets();
      return { readable: true, marked: secrets.some((s) => s.name === CONTAINER_SECRET), empty: secrets.length === 0 };
    } catch (e) {
      return { readable: false, marked: false, empty: false, error: e.message };
    }
  }

  /** Marks a vault as container (needs write access on its secrets). */
  async initVault({ vaultUrl, tenantId, name }) {
    return this.writeContainerMeta(this.probeClient({ vaultUrl, tenantId }), name ? { name } : {});
  }

  /** Logo of a container (data URL) or null. */
  async containerLogo(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).logo ? this.adapter(c).logo(containerId) : null;
    const meta = await this.readContainerMeta(this.kv(c)).catch(() => null);
    if (meta && 'logo' in meta) {
      let logo = meta.logo;
      if (logo?.sealed) {
        const key = await this.containerKey(containerId);
        logo = key ? await key.decrypt(logo.sealed, `${containerId}/${CONTAINER_SECRET}/logo`).catch(() => null) : null;
      }
      return isImageDataUrl(logo) ? logo : null;
    }
    let value;
    try {
      value = (await this.kv(c).getSecret(LOGO_SECRET)).value;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (isSealedValue(value)) {
      const key = await this.containerKey(containerId);
      if (!key) return null;
      value = await key.decrypt(JSON.parse(value)[SEALED], `${containerId}/${LOGO_SECRET}`);
    }
    return isImageDataUrl(value) ? value : null;
  }

  async setContainerLogo(containerId, dataUrl) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).setLogo(containerId, dataUrl);
    if (dataUrl && !isImageDataUrl(dataUrl)) throw new Error(t('Das Bild ist zu groß'));
    let logo = dataUrl || null;
    if (logo && (await this.readKeyring(c))) logo = { sealed: await (await this.requireKey(containerId)).encrypt(logo, `${containerId}/${CONTAINER_SECRET}/logo`) };
    await this.writeContainerMeta(this.kv(c), { logo, name: c.name });
    return null;
  }

  /** Explicitly created (possibly still empty) folders of a container, e.g. "Kunden/Contoso". */
  async folders(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).folders ? this.adapter(c).folders(containerId) : [];
    let value;
    try {
      value = (await this.kv(c).getSecret(FOLDERS_SECRET)).value;
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
    if (isSealedValue(value)) value = await (await this.requireKey(containerId)).decrypt(JSON.parse(value)[SEALED], `${containerId}/${FOLDERS_SECRET}`);
    return JSON.parse(value).folders || [];
  }

  async writeFolders(c, list) {
    let value = JSON.stringify({ folders: [...new Set(list)].sort() });
    if (await this.readKeyring(c)) value = JSON.stringify({ [SEALED]: await (await this.requireKey(c.id)).encrypt(value, `${c.id}/${FOLDERS_SECRET}`) });
    await this.kv(c).setSecret(FOLDERS_SECRET, value, { contentType: FOLDERS_TYPE, tags: { kvpwsafe: 'folders' } });
  }

  async addFolder(containerId, path) {
    const c = await this.container(containerId);
    requireFolderDepth(path);
    if (c.kind !== 'keyvault') return this.adapter(c).addFolder(containerId, path);
    const clean = normalizeFolder(path);
    if (!clean) throw new Error(t('Bitte einen Ordnernamen eingeben'));
    return this.writeFolders(c, [...(await this.folders(containerId)), clean]);
  }

  // ---------------------------------------------------------------- vault settings (admins)

  /** { features: { folders, rename, … }, updated, updatedBy } – defaults when nothing is stored (Key Vault only). */
  async policy(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return null;
    const cached = this.policyCache?.get(containerId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    let stored = {};
    try {
      stored = JSON.parse((await this.kv(c).getSecret(POLICY_SECRET)).value);
    } catch (e) {
      if (e.status !== 404 && !(e instanceof SyntaxError)) throw e;
    }
    const value = {
      features: { ...DEFAULT_POLICY, ...Object.fromEntries(POLICY_FEATURES.map((f) => [f, stored.features?.[f] === true])) },
      updated: stored.updated || '',
      updatedBy: stored.updatedBy || '',
    };
    (this.policyCache ||= new Map()).set(containerId, { at: Date.now(), value });
    return value;
  }

  async setPolicy(containerId, features) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') throw new Error(t('Tresor-Einstellungen gibt es nur für Tresore in Azure Key Vault'));
    const doc = {
      v: 1,
      features: Object.fromEntries(POLICY_FEATURES.map((f) => [f, features?.[f] === true])),
      updated: new Date().toISOString(),
      updatedBy: await this.actor(),
    };
    await this.kv(c).setSecret(POLICY_SECRET, JSON.stringify(doc), { contentType: POLICY_TYPE, tags: { kvpwsafe: 'policy' } });
    this.policyCache?.delete(containerId);
    return this.policy(containerId);
  }

  async removeFolder(containerId, path) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).removeFolder(containerId, path);
    return this.writeFolders(c, (await this.folders(containerId)).filter((f) => f !== path && !f.startsWith(`${path}/`)));
  }

  async sealTags(key, aad, tags) {
    const out = { kvpwsafe: tags.kvpwsafe, t: tags.t, e: '1' };
    for (const k of SEALED_TAGS) {
      if (tags[k] != null) out[k] = await key.encrypt(truncateBytes(tags[k], 160), `${aad}#${k}`);
    }
    return out;
  }

  async openTags(key, aad, tags) {
    const out = { ...tags };
    for (const k of SEALED_TAGS) if (tags[k]) out[k] = await key.decrypt(tags[k], `${aad}#${k}`);
    return out;
  }

  /** { kind, protected, locked, methods, passkeys (usable by rpId) } */
  async protectionInfo(containerId, rpId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).protectionInfo(containerId, rpId);
    const keyring = await this.readKeyring(c);
    return {
      kind: c.kind,
      protected: !!keyring,
      locked: !!keyring && !(await this.containerKey(containerId)),
      methods: keyring ? describeKeyring(keyring, rpId) : null,
      passkeys: keyring ? passkeyEntries(keyring, rpId) : [],
    };
  }

  /** params: { password } | { credentialId, prfOutput } | { code } → { via, entryId } */
  async unlockContainer(containerId, params) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).unlock(containerId, params);
    const keyring = await this.readKeyring(c);
    if (!keyring) throw new Error(t('Dieser Tresor ist nicht zusätzlich geschützt'));
    const r = await unlockKeyring(keyring, params);
    await this.store.set(`ck:${containerId}`, r.ck.exported);
    await this.refreshIndex([containerId]);
    return { via: r.entry.type, entryId: r.entry.id };
  }

  async lockContainer(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).lock(containerId);
    await this.store.remove(`ck:${containerId}`);
    this.keys.delete(containerId);
    await this.dropItemCache(containerId);
    await this.refreshIndex([containerId]);
    return undefined;
  }

  async dropItemCache(containerId) {
    if (!this.store.keys) return;
    for (const k of await this.store.keys()) if (k.startsWith(`item:${containerId}/`)) await this.store.remove(k);
  }

  async updateProtection(containerId, op) {
    const c = await this.container(containerId);
    const actor = await this.actor();
    if (c.kind !== 'keyvault') return this.adapter(c).updateKeyring(containerId, op, actor);
    const key = await this.requireKey(containerId);
    const keyring = await this.readKeyring(c);
    const { keyring: next, ...extra } = await applyKeyringOp(keyring, key, op, actor);
    await this.writeKeyring(c, next);
    return extra;
  }

  /**
   * Turns on the extra protection for a Key Vault container: { password?, passkey? } → { recoveryKey, migrated, failed }.
   * Existing entries are re-created encrypted (new IDs); the old plaintext secrets are deleted and purged where allowed.
   */
  async enableProtection(containerId, methods, onProgress = () => {}) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') throw new Error(t('Datei-Tresore sind immer verschlüsselt'));
    if (await this.readKeyring(c)) throw new Error(t('Der Tresor ist bereits geschützt'));
    const actor = await this.actor();
    const kv = this.kv(c);
    const plain = (await kv.listSecrets()).filter((s) => isItemSecret(s));
    const items = await mapLimit(plain, 4, async (s) => parseItem(await kv.getSecret(s.name), containerId));
    const { keyring, ck, recoveryKey } = await setupKeyring(containerId, methods, actor);
    await this.writeKeyring(c, keyring);
    await this.store.set(`ck:${containerId}`, ck.exported);
    await this.refreshIndex([containerId]);
    const failed = [];
    let done = 0;
    await mapLimit(items, 3, async (item) => {
      try {
        await this.saveItem(containerId, { ...item, id: '' });
        await kv.deleteSecret(item.id);
        await this.purgeWhenDeleted(kv, item.id);
      } catch (e) {
        failed.push(`${item.title}: ${e.message}`);
      }
      onProgress(++done, items.length);
    });
    // The plaintext index parts go the way of the plaintext entries; the sealed index follows right away.
    await this.purgeFastIndex(kv);
    await this.refreshIndex([containerId]);
    await this.writeFastIndex(containerId).catch(() => {});
    return { recoveryKey, migrated: items.length - failed.length, failed };
  }

  async purgeWhenDeleted(kv, name) {
    for (let i = 0; i < 5; i++) {
      try {
        await kv.purgeDeletedSecret(name);
        return true;
      } catch (e) {
        if (e.status !== 409 && e.status !== 404) return false; // 403: purge protection or no right.
        await sleep(1500);
      }
    }
    return false;
  }

  /** Turns the extra protection off again (entries are stored in plain form in place). */
  async disableProtection(containerId, onProgress = () => {}) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') throw new Error(t('Datei-Tresore sind immer verschlüsselt'));
    const key = await this.requireKey(containerId);
    const kv = this.kv(c);
    const secrets = (await kv.listSecrets()).filter((s) => isItemSecret(s));
    const failed = [];
    let done = 0;
    await mapLimit(secrets, 3, async (s) => {
      try {
        const bundle = await kv.getSecret(s.name);
        const value = isSealedValue(bundle.value) ? await key.decrypt(JSON.parse(bundle.value).data, `${containerId}/${s.name}`) : bundle.value;
        const item = parseItem({ ...bundle, value }, containerId);
        const ser = serializeItem(item, await this.actor());
        await kv.setSecret(s.name, ser.value, { contentType: ser.contentType, tags: ser.tags });
      } catch (e) {
        failed.push(`${s.tags?.n || s.name}: ${e.message}`);
      }
      onProgress(++done, secrets.length);
    });
    if (failed.length) return { failed };
    await kv.deleteSecret(KEYRING_SECRET);
    await this.purgeWhenDeleted(kv, KEYRING_SECRET);
    await this.store.remove(`ck:${containerId}`);
    this.keys.delete(containerId);
    await this.dropItemCache(containerId);
    await this.refreshIndex([containerId]);
    // Readers must not keep seeing a sealed index of a vault that is open again.
    await this.writeFastIndex(containerId).catch(() => {});
    return { failed };
  }

  /** Deletes and purges the index secrets (before protection seals them, so no plaintext list stays behind). */
  async purgeFastIndex(kv) {
    for (const secret of (await kv.listSecrets()).filter((x) => isIndexSecret(x.name))) {
      try {
        await kv.deleteSecret(secret.name);
        await this.purgeWhenDeleted(kv, secret.name);
      } catch {
        // Without purge rights the name stays in the recycle bin; the index is then rebuilt after the retention.
      }
    }
  }

  // ---------------------------------------------------------------- index (Key Vault) and items

  async index() {
    return (await this.store.get('index')) || {};
  }

  async kvContainers() {
    return ((await this.store.get('containers')) || []).map((c) => ({ ...c, kind: 'keyvault' }));
  }

  /** Nested loads (fast path falling back to the listing) count up and down; the callback sees only the edges. */
  busy(containerId, delta) {
    if (!this.onBusy) return;
    const n = (this.busyCount.get(containerId) || 0) + delta;
    this.busyCount.set(containerId, Math.max(n, 0));
    if (delta > 0 && n === 1) this.onBusy(containerId, true);
    if (delta < 0 && n <= 0) this.onBusy(containerId, false);
  }

  async refreshIndex(containerIds) {
    const containers = await this.kvContainers();
    const targets = containerIds ? containers.filter((c) => containerIds.includes(c.id)) : containers;
    const fresh = {};
    const sizes = this.onProgress ? await this.index() : {};
    await mapLimit(targets, 4, async (c) => {
      this.busy(c.id, 1);
      try {
        // Progress against the previous size of the vault (the listing itself does not know its total).
        const expected = sizes[c.id]?.items?.length || 0;
        const secrets = await this.kv(c).listSecrets(this.onProgress ? (n) => this.onProgress(c.id, n, Math.max(expected, n)) : null);
        if (!secrets.some((s) => s.name === CONTAINER_SECRET)) this.writeContainerMeta(this.kv(c), { name: c.name }).catch(() => {});
        const isProtected = secrets.some((s) => s.name === KEYRING_SECRET);
        const key = isProtected ? await this.containerKey(c.id) : null;
        const items = [];
        if (!isProtected || key) {
          for (const s of secrets) {
            if (!isItemSecret(s) || s.attributes?.enabled === false) continue;
            const sealed = s.tags?.e === '1';
            const tags = sealed ? await this.openTags(key, `${c.id}/${s.name}`, s.tags).catch(() => null) : s.tags;
            if (!tags) continue;
            items.push({ ...summaryFromSecret({ ...s, tags }, c.id), unprotected: isProtected && !sealed });
          }
        }
        fresh[c.id] = { items, loadedAt: Date.now(), error: null, protected: isProtected, locked: isProtected && !key, fast: false };
        // Reconcile: what the index secrets claim vs. what the vault really holds.
        if (!isProtected || key) {
          const before = (await this.index())[c.id];
          const known = before && !before.error && !before.locked ? before.items : null;
          if (!known || !sameSummaries(known, items) || !before.fast && !before.indexed) this.scheduleFastIndex(c.id);
        }
      } catch (e) {
        fresh[c.id] = { items: [], loadedAt: Date.now(), error: { status: e.status || 0, message: e.message, code: e.code || e.name, tenantId: e.tenantId, detail: e.detail || '' } };
      } finally {
        this.busy(c.id, -1);
      }
    });
    return this.locked(async () => {
      const index = { ...(await this.index()), ...fresh };
      for (const id of Object.keys(index)) if (!containers.some((c) => c.id === id)) delete index[id];
      await this.store.set('index', index);
      return index;
    });
  }

  /**
   * Fast path: the index secrets instead of the listing (a few GETs, whatever the size). Containers without an
   * index, with a damaged one, or protected ones without their key fall back to the full listing.
   */
  async refreshIndexFast(containerIds) {
    const containers = await this.kvContainers();
    const targets = containerIds ? containers.filter((c) => containerIds.includes(c.id)) : containers;
    const fresh = {};
    const slow = [];
    await mapLimit(targets, 4, async (c) => {
      this.busy(c.id, 1);
      try {
        const entry = await this.loadFastIndex(c);
        if (entry) fresh[c.id] = entry;
        else slow.push(c.id);
      } catch {
        slow.push(c.id);
      } finally {
        this.busy(c.id, -1);
      }
    });
    if (Object.keys(fresh).length) {
      await this.locked(async () => {
        const index = { ...(await this.index()), ...fresh };
        await this.store.set('index', index);
      });
    }
    if (slow.length) await this.refreshIndex(slow);
    return this.index();
  }

  async loadFastIndex(c) {
    const kv = this.kv(c);
    let header;
    try {
      header = JSON.parse((await kv.getSecret(INDEX_SECRET)).value);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (header?.v !== 1) return null;
    const key = header.protected ? await this.containerKey(c.id) : null;
    if (header.protected && !key) return { items: [], loadedAt: Date.now(), error: null, protected: true, locked: true, fast: true, gen: header.gen };
    const shards = await mapLimit(Array.from({ length: header.shards }, (_, i) => i), 4, async (i) => {
      let value = (await kv.getSecret(shardName(i))).value;
      if (isSealedValue(value)) value = await key.decrypt(JSON.parse(value)[SEALED], `${c.id}/${shardName(i)}`);
      return value;
    });
    const items = await decodeIndex(c.id, header, shards);
    return { items, loadedAt: Date.now(), error: null, protected: !!header.protected, locked: false, fast: true, gen: header.gen };
  }

  /** Writes the index secrets from the local index (debounced; skipped without write access or when locked). */
  scheduleFastIndex(containerId) {
    this.fastIndexTimers ||= new Map();
    clearTimeout(this.fastIndexTimers.get(containerId));
    // Jitter: with many users every app notices a change at its next reconcile – spread out, the first one writes
    // and the others find the vault's index already current (writeFastIndex compares before writing).
    const timer = setTimeout(() => {
      this.fastIndexTimers.delete(containerId);
      this.writeFastIndex(containerId).catch(() => {});
    }, FAST_INDEX_DELAY + Math.floor(Math.random() * FAST_INDEX_JITTER));
    timer.unref?.();
    this.fastIndexTimers.set(containerId, timer);
  }

  /** Tests and shutdown: write pending indexes now. */
  async flushFastIndex() {
    for (const [id, timer] of this.fastIndexTimers || []) {
      clearTimeout(timer);
      this.fastIndexTimers.delete(id);
      await this.writeFastIndex(id).catch(() => {});
    }
  }

  async writeFastIndex(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault' || c.access?.write === false) return false;
    const entry = (await this.index())[containerId];
    if (!entry || entry.error || entry.locked) return false;
    const key = entry.protected ? await this.containerKey(containerId) : null;
    if (entry.protected && !key) return false;
    const { header, shards } = await encodeIndex(entry.items, { by: await this.actor(), isProtected: !!entry.protected });
    const kv = this.kv(c);
    // Already current in the vault (another app wrote the same content): no write – with 50 users otherwise every
    // app would rewrite the index after each change. The hash covers the content, not who wrote it or when.
    const remote = await kv.getSecret(INDEX_SECRET).then((s) => JSON.parse(s.value), () => null);
    if (remote?.v === header.v && remote.hash === header.hash && remote.shards === header.shards && !!remote.protected === !!header.protected) {
      await this.locked(async () => {
        const index = await this.index();
        if (index[containerId]) index[containerId] = { ...index[containerId], indexed: true, gen: remote.gen };
        await this.store.set('index', index);
      });

      return false;
    }
    this.indexWrites = (this.indexWrites || 0) + 1;
    await mapLimit(shards.map((text, i) => [i, text]), 4, async ([i, text]) => {
      const value = key ? JSON.stringify({ [SEALED]: await key.encrypt(text, `${containerId}/${shardName(i)}`) }) : text;
      await kv.setSecret(shardName(i), value, { contentType: INDEX_TYPE, tags: { kvpwsafe: INDEX_TAG } });
    });
    await kv.setSecret(INDEX_SECRET, JSON.stringify(header), { contentType: INDEX_TYPE, tags: { kvpwsafe: INDEX_TAG } });
    await this.locked(async () => {
      const index = await this.index();
      if (index[containerId]) index[containerId] = { ...index[containerId], indexed: true, gen: header.gen };
      await this.store.set('index', index);
    });
    return true;
  }

  async updateIndex(containerId, change) {
    await this.locked(async () => {
      const index = await this.index();
      const entry = index[containerId] || { items: [], loadedAt: Date.now(), error: null };
      index[containerId] = { ...entry, items: change(entry.items) };
      await this.store.set('index', index);
    });
    this.scheduleFastIndex(containerId);
  }

  /** All item summaries; Key Vault indexes older than maxAgeMs are reloaded, adapters are asked live. */
  async summaries({ maxAgeMs = 5 * 60_000 } = {}) {
    let index = await this.index();
    const kv = await this.kvContainers();
    const stale = kv.filter((c) => !index[c.id] || Date.now() - index[c.id].loadedAt > maxAgeMs).map((c) => c.id);
    if (stale.length) index = await this.refreshIndexFast(stale);
    const out = kv.flatMap((c) => index[c.id]?.items || []);
    for (const c of await this.adapterContainers()) {
      if (c.locked) continue;
      try {
        out.push(...(await this.adapters[c.kind].summaries(c.id)));
      } catch {
        // Container became unavailable.
      }
    }
    return out;
  }

  async summary(containerId, id) {
    return (await this.index())[containerId]?.items.find((i) => i.id === id) || null;
  }

  async decodeBundle(container, bundle) {
    if (!isSealedValue(bundle.value)) return parseItem(bundle, container.id);
    const key = await this.requireKey(container.id);
    const value = await key.decrypt(JSON.parse(bundle.value).data, `${container.id}/${bundle.name}`);
    return parseItem({ ...bundle, value }, container.id);
  }

  async getItem(containerId, id, { fresh = false } = {}) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).getItem(containerId, id);
    const key = `item:${containerId}/${id}`;
    const summary = await this.summary(containerId, id);
    if (!fresh) {
      const cached = await this.store.get(key);
      if (cached && (!summary || cached.updated === summary.updated)) return cached.item;
    }
    const bundle = await this.kv(c).getSecret(id);
    const item = await this.decodeBundle(c, bundle);
    const updated = (bundle.attributes?.updated || 0) * 1000;
    await this.store.set(key, { item, updated });
    if (summary && summary.updated !== updated) {
      const current = { ...summaryFromSecret({ name: id, tags: serializeItem(item).tags, attributes: { updated: updated / 1000 } }, containerId), unprotected: summary.unprotected };
      await this.updateIndex(containerId, (list) => list.map((x) => (x.id === id ? current : x)));
    }
    return item;
  }

  async isProtected(container) {
    const entry = (await this.index())[container.id];
    if (entry?.protected) return true;
    // Another client may have turned protection on since the last refresh.
    return !!(await this.readKeyring(container));
  }

  /** Creates or updates an item. expectedVersion enables the conflict check. */
  // ---------------------------------------------------------------- licensing (per vault)

  /** License key stored in the vault (Key Vault: container metadata; file: inside the file). */
  async containerLicenseKey(c) {
    if (c.kind === 'keyvault') return (await this.readContainerMeta(this.kv(c)).catch(() => null))?.license || null;
    return this.adapter(c).license ? this.adapter(c).license(c.id) : null;
  }

  /** { licensed, code, vault, count, limit, to?, issued?, reason? } */
  async licenseState(containerId) {
    const c = await this.container(containerId);
    const key = await this.containerLicenseKey(c).catch(() => null);
    const check = key ? await verifyLicense(key, c.id) : { valid: false };
    const count = (await this.summaries({ maxAgeMs: 60_000 })).filter((s) => s.containerId === containerId).length;
    return {
      licensed: check.valid, code: await requestCode(c.id), vault: c.id, count, limit: FREE_LIMIT,
      to: check.payload?.to || '', issued: check.payload?.issued || '', reason: key && !check.valid ? check.reason : null,
      // Limited licenses (v2): end date, trial flag, already expired.
      expires: check.payload?.v === 2 ? check.payload.expires : '', trial: !!check.payload?.trial, expired: !!check.expired,
    };
  }

  async setContainerLicense(containerId, key) {
    const c = await this.container(containerId);
    const check = await verifyLicense(key, c.id);
    if (!check.valid) throw new Error(check.reason);
    // A trial must not replace a permanent license that is still valid.
    if (check.payload.v === 2) {
      const current = await this.licenseState(containerId);
      if (current.licensed && !current.expires) throw new Error(t('Der Tresor hat bereits eine dauerhafte Lizenz'));
    }
    if (c.kind === 'keyvault') await this.writeContainerMeta(this.kv(c), { license: String(key).replace(/\s+/g, '') });
    else await this.adapter(c).setLicense(c.id, String(key).replace(/\s+/g, ''));
    return this.licenseState(containerId);
  }

  /** New entries beyond the free limit need a license (edits and deletions never do). */
  async requireLicenseForNew(c) {
    if (c.kind === 'remote') return; // the desktop app checks
    const count = (await this.summaries({ maxAgeMs: 60_000 })).filter((s) => s.containerId === c.id).length;
    if (count < FREE_LIMIT) return;
    const key = await this.containerLicenseKey(c).catch(() => null);
    if (!key || !(await verifyLicense(key, c.id)).valid) throw new LicenseLimitError();
  }

  async saveItem(containerId, item, { expectedVersion } = {}) {
    const c = await this.container(containerId);
    requireFolderDepth(item.folder);
    const actor = await this.actor();
    if (!item.id) await this.requireLicenseForNew(c);
    if (c.kind !== 'keyvault') return this.adapter(c).saveItem(containerId, item, { expectedVersion, actor });
    const kv = this.kv(c);
    const id = item.id || newItemId();
    if (item.id && expectedVersion) {
      let current = null;
      try {
        current = await kv.getSecret(id);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (current && current.version !== expectedVersion) throw new ConflictError();
    }
    const plain = serializeItem({ ...item, id }, actor);
    let { value, contentType, tags } = plain;
    if (await this.isProtected(c)) {
      const key = await this.requireKey(containerId);
      value = JSON.stringify({ [SEALED]: 1, data: await key.encrypt(value, `${containerId}/${id}`) });
      contentType = `${contentType}; enc=1`;
      tags = await this.sealTags(key, `${containerId}/${id}`, tags);
    }
    const bundle = await kv.setSecret(id, value, { contentType, tags });
    const saved = parseItem({ ...bundle, value: plain.value }, containerId);
    const summary = summaryFromSecret({ ...bundle, name: id, tags: plain.tags }, containerId);
    await this.updateIndex(containerId, (list) => [...list.filter((i) => i.id !== id), summary]);
    await this.store.set(`item:${containerId}/${id}`, { item: saved, updated: summary.updated });
    return saved;
  }

  async deleteItem(containerId, id) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).deleteItem(containerId, id, await this.actor());
    await this.kv(c).deleteSecret(id);
    await this.updateIndex(containerId, (list) => list.filter((i) => i.id !== id));
    await this.store.remove(`item:${containerId}/${id}`);
    return undefined;
  }

  async moveItem(fromId, toId, id) {
    const item = await this.getItem(fromId, id, { fresh: true });
    const saved = await this.saveItem(toId, { ...item, id: '' });
    await this.deleteItem(fromId, id);
    return saved;
  }

  /** Copy of an entry in the same container and folder ("… (Kopie)"); passkeys are not copied (they are unique). */
  async duplicateItem(containerId, id) {
    const item = await this.getItem(containerId, id, { fresh: true });
    return this.saveItem(containerId, {
      ...item, id: '', title: t('{title} (Kopie)', { title: item.title }), passkeys: [], favorite: false, created: '', createdBy: '',
    });
  }

  // ---------------------------------------------------------------- backup (Key Vault containers, raw secrets)

  /** All secrets of a Key Vault container as stored (protected containers stay sealed). */
  async backupSecrets(containerId, onProgress = () => {}) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') throw new Error(t('Backups gibt es nur für Tresore in Azure Key Vault'));
    const kv = this.kv(c);
    const list = (await kv.listSecrets()).filter((s) => s.attributes?.enabled !== false && !s.managed && !isIndexSecret(s.name));
    let done = 0;
    const secrets = await mapLimit(list, 4, async (s) => {
      const full = await kv.getSecret(s.name);
      onProgress(++done, list.length);
      return { name: s.name, value: full.value, contentType: full.contentType || '', tags: full.tags || {} };
    });
    return { vault: c.id, secrets, isProtected: secrets.some((s) => s.name === KEYRING_SECRET) };
  }

  /**
   * Writes backed-up secrets into a Key Vault container: missing and deleted ones come back, changed ones get the
   * backup state as a new version (the current one stays in the history), identical ones are skipped.
   * Into another vault only unprotected backups, without the container marker (license and ID stay the target's).
   */
  async restoreSecrets(containerId, { vault, secrets, isProtected }, onProgress = () => {}) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') throw new Error(t('Backups gibt es nur für Tresore in Azure Key Vault'));
    const sameVault = vault === c.id;
    if (isProtected && !sameVault) throw new Error(t('Ein zusätzlich verschlüsselter Tresor lässt sich nur in denselben Key Vault zurückspielen ({vault})', { vault }));
    const kv = this.kv(c);
    const todo = secrets.filter((s) => sameVault || s.name !== CONTAINER_SECRET);
    const result = { restored: 0, recovered: 0, unchanged: 0, failed: [] };
    let done = 0;
    await mapLimit(todo, 3, async (s) => {
      try {
        let current = null;
        try {
          current = await kv.getSecret(s.name);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
        if (current && current.value === s.value && (current.contentType || '') === s.contentType) {
          result.unchanged++;
          return;
        }
        try {
          await kv.setSecret(s.name, s.value, { contentType: s.contentType || undefined, tags: s.tags });
        } catch (e) {
          if (e.status !== 409) throw e;
          // Soft-deleted: recover first, then write the backup state.
          await kv.recoverDeletedSecret(s.name);
          result.recovered++;
          for (let i = 0; ; i++) {
            try {
              await kv.getSecret(s.name);
              break;
            } catch (err) {
              if (err.status !== 404 || i > 20) throw err;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          await kv.setSecret(s.name, s.value, { contentType: s.contentType || undefined, tags: s.tags });
        }
        result.restored++;
      } catch (e) {
        result.failed.push({ name: s.name, error: e.message });
      } finally {
        onProgress(++done, todo.length);
      }
    });
    await this.dropItemCache(containerId);
    await this.refreshIndex([containerId]);
    return result;
  }

  async matchesForHost(host) {
    const all = await this.summaries();
    return all.filter((s) => s.type === 'login' && itemMatchesHost(s.hosts, host));
  }

  /** Passkeys for an RP: [{ containerId, itemId, title, passkey }]. */
  async passkeyCandidates(rpId, allowCredentialIds = []) {
    const out = [];
    const index = await this.summaries();
    for (const s of index.filter((x) => x.rpIds.includes(rpId))) {
      const c = (await this.containers()).find((x) => x.id === s.containerId);
      if (!c) continue;
      if (c.kind !== 'keyvault' && this.adapters[c.kind].passkeyCandidates) continue;
      let item;
      try {
        item = await this.getItem(s.containerId, s.id);
      } catch {
        continue;
      }
      for (const passkey of filterPasskeys(item.passkeys, rpId, allowCredentialIds)) {
        out.push({ containerId: s.containerId, itemId: s.id, title: item.title, urls: item.urls || [], passkey });
      }
    }
    for (const adapter of Object.values(this.adapters)) {
      if (!adapter.passkeyCandidates) continue;
      try {
        for (const c of await adapter.passkeyCandidates(rpId)) {
          if (filterPasskeys([c.passkey], rpId, allowCredentialIds).length) out.push(c);
        }
      } catch {
        // Adapter not available.
      }
    }
    return out;
  }

  async trash(containerId) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).trash(containerId);
    const deleted = await this.kv(c).listDeletedSecrets();
    const key = await this.containerKey(containerId);
    const out = [];
    for (const s of deleted.filter(isItemSecret)) {
      let tags = s.tags || {};
      if (tags.e === '1') {
        if (!key) continue;
        tags = await this.openTags(key, `${containerId}/${s.name}`, tags).catch(() => ({ n: s.name }));
      }
      out.push({
        id: s.name,
        title: tags.n || s.name,
        username: tags.u || '',
        deletedDate: (s.deletedDate || 0) * 1000,
        scheduledPurgeDate: (s.scheduledPurgeDate || 0) * 1000,
      });
    }
    return out.sort((a, b) => b.deletedDate - a.deletedDate);
  }

  async restore(containerId, id) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).restore(containerId, id, await this.actor());
    const kv = this.kv(c);
    await kv.recoverDeletedSecret(id);
    // Recovery is asynchronous in Key Vault; wait until the secret is readable again.
    for (let i = 0; i < 15; i++) {
      try {
        await kv.getSecret(id);
        break;
      } catch (e) {
        if (e.status !== 404) throw e;
        await sleep(2000);
      }
    }
    await this.refreshIndex([containerId]);
    return undefined;
  }

  async purge(containerId, id) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).purge(containerId, id);
    return this.kv(c).purgeDeletedSecret(id);
  }

  async history(containerId, id) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).history(containerId, id);
    const versions = await this.kv(c).listSecretVersions(id);
    return versions
      .map((v) => ({ version: v.version, updated: (v.attributes?.updated || 0) * 1000, enabled: v.attributes?.enabled !== false }))
      .sort((a, b) => b.updated - a.updated);
  }

  async getVersion(containerId, id, version) {
    const c = await this.container(containerId);
    if (c.kind !== 'keyvault') return this.adapter(c).getVersion(containerId, id, version);
    return this.decodeBundle(c, await this.kv(c).getSecret(id, version));
  }

  async restoreVersion(containerId, id, version) {
    const old = await this.getVersion(containerId, id, version);
    const current = await this.getItem(containerId, id, { fresh: true });
    return this.saveItem(containerId, { ...old, id, created: current.created, createdBy: current.createdBy });
  }

  async clear() {
    this.keys.clear();
    await this.store.clear();
  }
}
