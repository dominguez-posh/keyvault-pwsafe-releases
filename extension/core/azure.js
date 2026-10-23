// Azure Resource Manager + Microsoft Graph: discovering containers (Key Vaults tagged kvpwsafe=container),
// effective permissions, sharing through Azure RBAC role assignments and creating new containers.

import { sleep, mapLimit } from './util.js';
import { normalizeVaultUrl } from './keyvault.js';
import { t } from './i18n.js';

export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const CONTAINER_TAG = 'kvpwsafe';
export const CONTAINER_NAME_TAG = 'kvpwsafe-name';

// Built-in Azure role definitions.
export const ROLES = {
  secretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
  secretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
  dataAccessAdmin: '8b54135c-b56d-4d72-a534-26097cfdc8d8',
  kvAdministrator: '00482a5a-887f-4fb3-b363-3b7fe8e74483',
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7',
  owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
  userAccessAdmin: '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
  rbacAdmin: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168',
};

export const ROLE_LABELS = {
  [ROLES.secretsUser]: 'Lesen',
  [ROLES.secretsOfficer]: 'Bearbeiten',
  [ROLES.dataAccessAdmin]: 'Freigaben verwalten',
  [ROLES.kvAdministrator]: 'Key Vault Administrator',
  [ROLES.reader]: 'Sichtbar (Reader)',
  [ROLES.owner]: 'Besitzer',
  [ROLES.userAccessAdmin]: 'Benutzerzugriffsadministrator',
  [ROLES.rbacAdmin]: 'RBAC-Administrator',
};

// Access levels offered when sharing a container, mapped to role assignments.
export const ACCESS_LEVELS = {
  read: { label: 'Lesen', roles: [ROLES.secretsUser] },
  write: { label: 'Bearbeiten', roles: [ROLES.secretsOfficer] },
  manage: { label: 'Verwalten', roles: [ROLES.secretsOfficer, ROLES.dataAccessAdmin] },
};

const DATA_ROLES = new Set([ROLES.secretsUser, ROLES.secretsOfficer, ROLES.dataAccessAdmin, ROLES.kvAdministrator]);
const SHOWN_ROLES = new Set([...DATA_ROLES, ROLES.owner, ROLES.userAccessAdmin, ROLES.rbacAdmin]);

export class AzureError extends Error {
  constructor(status, code, message) {
    super(message || `Azure Fehler ${status}`);
    this.name = 'AzureError';
    this.status = status;
    this.code = code;
  }
}

const roleGuid = (roleDefinitionId) => String(roleDefinitionId).split('/').pop().toLowerCase();
const subscriptionOf = (resourceId) => String(resourceId).split('/')[2];

function actionRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function allowed(permissions, action, data) {
  const key = data ? 'dataActions' : 'actions';
  const notKey = data ? 'notDataActions' : 'notActions';
  return permissions.some((p) => (p[key] || []).some((a) => actionRegex(a).test(action))
    && !(p[notKey] || []).some((a) => actionRegex(a).test(action)));
}

/** Reduces an ARM permissions list to what the app needs. */
export function accessFromPermissions(permissions) {
  return {
    read: allowed(permissions, 'Microsoft.KeyVault/vaults/secrets/getSecret/action', true),
    write: allowed(permissions, 'Microsoft.KeyVault/vaults/secrets/setSecret/action', true),
    manage: allowed(permissions, 'Microsoft.Authorization/roleAssignments/write', false),
  };
}

export class AzureClient {
  constructor({ getArmToken, getGraphToken, fetch: fetchImpl }) {
    this.getArmToken = getArmToken;
    this.getGraphToken = getGraphToken;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async request(getToken, method, url, body, headers = {}) {
    let forceRefresh = false;
    for (let attempt = 0; ; attempt++) {
      const token = await getToken({ forceRefresh });
      const h = { Authorization: `Bearer ${token}`, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      const res = await this.fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new AzureError(res.status, data?.error?.code, data?.error?.message || res.statusText);
      return data;
    }
  }

  arm(method, path, apiVersion, body) {
    const sep = path.includes('?') ? '&' : '?';
    return this.request(this.getArmToken, method, `${ARM}${path}${sep}api-version=${apiVersion}`, body);
  }

  graph(method, path, body, headers) {
    return this.request(this.getGraphToken, method, `${GRAPH}${path}`, body, headers);
  }

  async armList(path, apiVersion) {
    const all = [];
    let data = await this.arm('GET', path, apiVersion);
    all.push(...(data?.value || []));
    while (data?.nextLink) {
      data = await this.request(this.getArmToken, 'GET', data.nextLink);
      all.push(...(data?.value || []));
    }
    return all;
  }

  async resourceGraph(query) {
    const data = await this.arm('POST', '/providers/Microsoft.ResourceGraph/resources', '2022-10-01', {
      query,
      options: { resultFormat: 'objectArray', $top: 1000 },
    });
    return data?.data || [];
  }

  /** All Key Vaults tagged as containers that the signed-in user can see in ARM. */
  async discoverContainers() {
    const rows = await this.resourceGraph(
      `resources | where type =~ 'microsoft.keyvault/vaults' | where tags['${CONTAINER_TAG}'] =~ 'container' ` +
      `| project id, name, location, resourceGroup, subscriptionId, vaultUri = tostring(properties.vaultUri), ` +
      `displayName = tostring(tags['${CONTAINER_NAME_TAG}']), rbac = tobool(properties.enableRbacAuthorization), tenantId`,
    );
    return rows.map((r) => ({
      name: r.displayName || r.name,
      vaultUrl: normalizeVaultUrl(r.vaultUri || r.name),
      resourceId: r.id,
      location: r.location,
      rbac: r.rbac !== false,
      tenantId: r.tenantId || null,
    }));
  }

  /** Every Key Vault the signed-in user can see in ARM, for picking one as a container. */
  async listVaults() {
    const rows = await this.resourceGraph(
      `resources | where type =~ 'microsoft.keyvault/vaults' ` +
      `| project id, name, resourceGroup, vaultUri = tostring(properties.vaultUri), ` +
      `tagged = tostring(tags['${CONTAINER_TAG}']) =~ 'container', displayName = tostring(tags['${CONTAINER_NAME_TAG}']), tenantId | order by name asc`,
    );
    return rows.map((r) => ({
      name: r.displayName || r.name,
      vaultUrl: normalizeVaultUrl(r.vaultUri || r.name),
      resourceId: r.id,
      resourceGroup: r.resourceGroup,
      container: !!r.tagged,
      tenantId: r.tenantId || null,
    }));
  }

  /** Directories (tenants) the signed-in account belongs to. */
  async listTenants() {
    const all = await this.armList('/tenants', '2022-12-01');
    return all.map((x) => ({ tenantId: x.tenantId, name: x.displayName || x.defaultDomain || x.tenantId, domain: x.defaultDomain || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findVault(vaultUrl) {
    const host = new URL(normalizeVaultUrl(vaultUrl)).hostname;
    const name = host.split('.')[0];
    const rows = await this.resourceGraph(
      `resources | where type =~ 'microsoft.keyvault/vaults' and name =~ '${name.replace(/'/g, '')}' ` +
      `| project id, name, displayName = tostring(tags['${CONTAINER_NAME_TAG}'])`,
    );
    return rows[0] ? { resourceId: rows[0].id, name: rows[0].displayName || rows[0].name } : null;
  }

  async myAccess(resourceId) {
    const perms = await this.armList(`${resourceId}/providers/Microsoft.Authorization/permissions`, '2022-04-01');
    return accessFromPermissions(perms);
  }

  listSubscriptions() {
    return this.armList('/subscriptions', '2022-12-01');
  }

  listResourceGroups(subscriptionId) {
    return this.armList(`/subscriptions/${subscriptionId}/resourcegroups`, '2021-04-01');
  }

  async listLocations(subscriptionId) {
    const all = await this.armList(`/subscriptions/${subscriptionId}/locations`, '2022-12-01');
    return all.filter((l) => l.metadata?.regionType !== 'Logical')
      .map((l) => ({ name: l.name, displayName: l.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async checkVaultName(subscriptionId, name) {
    return this.arm('POST', `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/checkNameAvailability`,
      '2023-07-01', { name, type: 'Microsoft.KeyVault/vaults' });
  }

  /**
   * Creates a container (RBAC Key Vault) and grants the creator edit + share rights.
   * Returns { container, warnings }.
   */
  async createContainer({ subscriptionId, resourceGroup, location, name, displayName, tenantId, creatorObjectId, purgeProtection = true }) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(name) || name.includes('--')) {
      throw new Error(t('Name: 3–24 Zeichen, Buchstaben, Ziffern und Bindestriche, beginnt mit einem Buchstaben'));
    }
    const check = await this.checkVaultName(subscriptionId, name);
    if (check && check.nameAvailable === false) throw new Error(check.message || t('Name ist bereits vergeben'));

    const id = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.KeyVault/vaults/${name}`;
    const properties = {
      tenantId,
      sku: { family: 'A', name: 'standard' },
      enableRbacAuthorization: true,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 90,
      publicNetworkAccess: 'Enabled',
    };
    if (purgeProtection) properties.enablePurgeProtection = true;
    let vault = await this.arm('PUT', id, '2023-07-01', {
      location,
      tags: { [CONTAINER_TAG]: 'container', [CONTAINER_NAME_TAG]: displayName || name },
      properties,
    });
    for (let i = 0; i < 30 && vault?.properties?.provisioningState !== 'Succeeded'; i++) {
      await sleep(2000);
      vault = await this.arm('GET', id, '2023-07-01');
    }
    const warnings = [];
    if (creatorObjectId) {
      for (const role of ACCESS_LEVELS.manage.roles) {
        try {
          await this.assignRole(id, creatorObjectId, 'User', role);
        } catch (e) {
          warnings.push(t('Rolle „{role}“ konnte nicht zugewiesen werden: {message}', { role: t(ROLE_LABELS[role]), message: e.message }));
        }
      }
    }
    return {
      container: { name: displayName || name, vaultUrl: normalizeVaultUrl(vault.properties.vaultUri || name), resourceId: id },
      warnings,
    };
  }

  async assignRole(resourceId, principalId, principalType, role) {
    const assignmentId = crypto.randomUUID();
    // A just invited guest takes a moment to reach Azure RBAC (PrincipalNotFound).
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.arm('PUT', `${resourceId}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`, '2022-04-01', {
          properties: {
            roleDefinitionId: `/subscriptions/${subscriptionOf(resourceId)}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
            principalId,
            principalType,
          },
        });
      } catch (e) {
        if (e.code !== 'PrincipalNotFound' || attempt >= 8) throw e;
        await sleep(this.retryDelay ?? 4000);
      }
    }
  }

  /**
   * A vault trusts exactly one tenant (properties.tenantId). If that is not the tenant its subscription belongs
   * to (typical when created through Azure Lighthouse), role assignments can never take effect.
   */
  async vaultTenantCheck(resourceId) {
    const v = await this.arm('GET', resourceId, '2023-07-01');
    const sub = await this.arm('GET', `/subscriptions/${subscriptionOf(resourceId)}`, '2022-12-01');
    const vaultTenant = v?.properties?.tenantId || null;
    const subscriptionTenant = sub?.tenantId || null;
    return { vaultTenant, subscriptionTenant, mismatch: !!vaultTenant && !!subscriptionTenant && vaultTenant !== subscriptionTenant, rbac: v?.properties?.enableRbacAuthorization !== false };
  }

  /** Lets the vault trust the tenant of its subscription (Microsoft's procedure after a subscription move). */
  setVaultTenant(resourceId, tenantId) {
    return this.arm('PATCH', resourceId, '2023-07-01', { properties: { tenantId } });
  }

  /** Key Vaults of one resource group (for "use an existing empty vault"). */
  async listVaultsInGroup(subscriptionId, resourceGroup) {
    const all = await this.armList(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.KeyVault/vaults`, '2023-07-01');
    return all.map((v) => ({
      name: v.tags?.[CONTAINER_NAME_TAG] || v.name, vaultName: v.name, vaultUrl: normalizeVaultUrl(v.properties?.vaultUri || v.name),
      resourceId: v.id, rbac: v.properties?.enableRbacAuthorization !== false, tenantId: v.properties?.tenantId || null,
    }));
  }

  /** May the user create Key Vaults and assign roles in this resource group? */
  async groupPermissions(subscriptionId, resourceGroup) {
    const perms = await this.armList(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Authorization/permissions`, '2022-04-01');
    return {
      createVault: allowed(perms, 'Microsoft.KeyVault/vaults/write', false),
      assignRoles: allowed(perms, 'Microsoft.Authorization/roleAssignments/write', false),
    };
  }

  /**
   * Owner of the subscription (or equivalent: any action incl. role assignments at subscription scope, also via
   * groups or inherited from a management group). Required for backup and restore.
   */
  async subscriptionOwner(subscriptionId) {
    const perms = await this.armList(`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/permissions`, '2022-04-01');
    return allowed(perms, 'Microsoft.Authorization/roleAssignments/write', false)
      && allowed(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write', false)
      && allowed(perms, 'Microsoft.KeyVault/vaults/write', false);
  }

  /** Display name of a container = tag on the vault (needs write access on the vault resource). */
  async setVaultDisplayName(resourceId, name) {
    const v = await this.arm('GET', resourceId, '2023-07-01');
    await this.arm('PATCH', resourceId, '2023-07-01', { tags: { ...(v?.tags || {}), [CONTAINER_NAME_TAG]: name } });
  }

  /** The signed-in account as principal of this tenant (as guest: its guest object). */
  async me() {
    const u = await this.graph('GET', '/me?$select=id,displayName,userPrincipalName');
    return { id: u.id, type: 'User', displayName: u.displayName, detail: u.userPrincipalName };
  }

  /** Invites an external person as guest into this tenant (B2B) and returns them as principal. */
  async inviteGuest(email) {
    let r;
    try {
      r = await this.graph('POST', '/invitations', {
        invitedUserEmailAddress: email, inviteRedirectUrl: 'https://myapps.microsoft.com', sendInvitationMessage: true,
      });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        throw new Error(t('Einladen nicht erlaubt: Dein Konto darf in diesem Tenant keine Gäste einladen oder der Anmeldung fehlt die Berechtigung „User.Invite.All“. Lade die Person im Entra Admin Center als Gast ein und füge sie danach hier hinzu.'));
      }
      throw e;
    }
    return { id: r.invitedUser.id, type: 'User', displayName: r.invitedUserDisplayName || email, detail: email, invited: true };
  }

  /** Members of a container: role assignments on the vault (direct and inherited) with names. */
  async listMembers(resourceId) {
    const assignments = await this.armList(
      `${resourceId}/providers/Microsoft.Authorization/roleAssignments?$filter=atScope()`, '2022-04-01');
    const byPrincipal = new Map();
    for (const a of assignments) {
      const role = roleGuid(a.properties.roleDefinitionId);
      if (!SHOWN_ROLES.has(role)) continue;
      const inherited = a.properties.scope.toLowerCase() !== resourceId.toLowerCase();
      const entry = byPrincipal.get(a.properties.principalId) || {
        principalId: a.properties.principalId,
        principalType: a.properties.principalType,
        assignments: [],
      };
      entry.assignments.push({ id: a.id, role, label: t(ROLE_LABELS[role]), inherited, scope: a.properties.scope });
      byPrincipal.set(entry.principalId, entry);
    }
    const members = [...byPrincipal.values()];
    await this.resolvePrincipals(members);
    for (const m of members) {
      const roles = new Set(m.assignments.map((a) => a.role));
      m.level = roles.has(ROLES.dataAccessAdmin) || roles.has(ROLES.kvAdministrator) ? 'manage'
        : roles.has(ROLES.secretsOfficer) ? 'write'
          : roles.has(ROLES.secretsUser) ? 'read' : 'none';
      m.removable = m.assignments.some((a) => !a.inherited && DATA_ROLES.has(a.role));
    }
    return members.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  }

  async resolvePrincipals(members) {
    const chunks = [];
    for (let i = 0; i < members.length; i += 20) chunks.push(members.slice(i, i + 20));
    try {
      await mapLimit(chunks, 2, async (chunk) => {
        const requests = chunk.map((m, i) => {
          const kind = m.principalType === 'Group' ? 'groups' : m.principalType === 'User' ? 'users' : 'servicePrincipals';
          const select = kind === 'users' ? 'displayName,userPrincipalName,mail' : 'displayName,mail';
          return { id: String(i), method: 'GET', url: `/${kind}/${m.principalId}?$select=${select}` };
        });
        const res = await this.graph('POST', '/$batch', { requests });
        for (const r of res.responses || []) {
          const m = chunk[Number(r.id)];
          if (r.status === 200) {
            m.displayName = r.body.displayName;
            m.detail = r.body.userPrincipalName || r.body.mail || '';
          }
        }
      });
    } catch {
      // Names are cosmetic; without Graph consent the object IDs are shown.
    }
    for (const m of members) if (!m.displayName) m.displayName = m.principalId;
  }

  /**
   * Shares a container. Also tries to grant the Reader role so the container shows up for the member
   * automatically (needs Owner/User Access Administrator; failing that, send them the invite link).
   */
  async addMember(resourceId, principal, level) {
    const def = ACCESS_LEVELS[level];
    if (!def) throw new Error(t('Unbekannte Berechtigung'));
    const existing = await this.listMembers(resourceId).catch(() => []);
    const current = existing.find((m) => m.principalId === principal.id);
    const have = new Set((current?.assignments || []).filter((a) => !a.inherited).map((a) => a.role));
    for (const role of def.roles) if (!have.has(role)) await this.assignRole(resourceId, principal.id, principal.type, role);
    // Downgrade: drop direct data roles that the new level does not include.
    for (const a of current?.assignments || []) {
      if (!a.inherited && DATA_ROLES.has(a.role) && !def.roles.includes(a.role)) await this.removeAssignment(a.id);
    }
    let discoverable = have.has(ROLES.reader);
    if (!discoverable) {
      try {
        await this.assignRole(resourceId, principal.id, principal.type, ROLES.reader);
        discoverable = true;
      } catch {
        discoverable = false;
      }
    }
    return { discoverable };
  }

  async removeMember(resourceId, principalId) {
    const members = await this.listMembers(resourceId);
    const m = members.find((x) => x.principalId === principalId);
    for (const a of m?.assignments || []) {
      if (!a.inherited && (DATA_ROLES.has(a.role) || a.role === ROLES.reader)) await this.removeAssignment(a.id);
    }
  }

  removeAssignment(assignmentId) {
    return this.arm('DELETE', assignmentId, '2022-04-01');
  }

  /** People picker: users and security groups. */
  async searchPrincipals(query) {
    const q = String(query || '').trim().replace(/"/g, '');
    if (q.length < 2) return [];
    const headers = { ConsistencyLevel: 'eventual' };
    const out = [];
    const users = await this.graph('GET',
      `/users?$search="displayName:${encodeURIComponent(q)}" OR "mail:${encodeURIComponent(q)}"&$select=id,displayName,userPrincipalName,mail&$top=8`,
      undefined, headers).catch(() => ({ value: [] }));
    for (const u of users.value || []) out.push({ id: u.id, type: 'User', displayName: u.displayName, detail: u.userPrincipalName || u.mail });
    if (q.includes('@') && !out.length) {
      const u = await this.graph('GET', `/users/${encodeURIComponent(q)}?$select=id,displayName,userPrincipalName`).catch(() => null);
      if (u) out.push({ id: u.id, type: 'User', displayName: u.displayName, detail: u.userPrincipalName });
    }
    const groups = await this.graph('GET',
      `/groups?$search="displayName:${encodeURIComponent(q)}"&$select=id,displayName,mail,securityEnabled&$top=8`,
      undefined, headers).catch(() => ({ value: [] }));
    for (const g of groups.value || []) {
      if (g.securityEnabled) out.push({ id: g.id, type: 'Group', displayName: g.displayName, detail: g.mail || t('Sicherheitsgruppe') });
    }
    return out;
  }
}

/** Invite links: kvpwsafe://add?vault=<url>&name=<display name>. Plain vault URLs work as well. */
export function buildInvite(container) {
  const u = new URL('kvpwsafe://add');
  u.searchParams.set('vault', container.vaultUrl);
  u.searchParams.set('name', container.name);
  return u.toString();
}

export function parseInvite(text) {
  const s = String(text || '').trim();
  const m = s.match(/kvpwsafe:\/\/add\?[^\s]+/i);
  if (m) {
    const params = new URLSearchParams(m[0].slice(m[0].indexOf('?') + 1));
    return { vaultUrl: normalizeVaultUrl(params.get('vault')), name: params.get('name') || '' };
  }
  const v = s.match(/https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/?/i);
  return { vaultUrl: normalizeVaultUrl(v ? v[0] : s), name: '' };
}
