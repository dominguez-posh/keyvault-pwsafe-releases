// AI agents: vaults and folders released to them, entries read without asking.

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';

// Entries AI agents read without asking ("never ask again"): item key → agent names, for the context menu.
export let agentTrust = new Map();
export async function loadAgentTrust() {
  const map = new Map();
  for (const x of await call('mcpTrusted').catch(() => [])) {
    const key = `${x.vaultId}/${x.entryId}`;
    map.set(key, [...(map.get(key) || []), x.agent]);
  }
  agentTrust = map;
}

export const mcpScopes = () => (Array.isArray(st.settings.mcpScopes) ? st.settings.mcpScopes : []);
export const mcpShared = (vaultId, folder) => mcpScopes().some((x) => x.vaultId === vaultId && (x.folder || '') === folder);

export async function setMcpScopes(next) {
  await call('updateSettings', { mcpScopes: next });
  st.settings.mcpScopes = next;
}

async function toggleMcpScope(vaultId, folder) {
  const shared = mcpShared(vaultId, folder);
  await setMcpScopes(shared ? mcpScopes().filter((x) => !(x.vaultId === vaultId && (x.folder || '') === folder)) : [...mcpScopes(), { vaultId, folder }]);
  toast(shared ? t('Freigabe für KI-Agenten aufgehoben') : t('Für KI-Agenten freigegeben'));
}

/** Context menu entry (vault: folder ''), only while agents are on and limited to released areas. */
export const mcpScopeAction = (vaultId, folder) => (st.settings.mcpEnabled && st.settings.mcpScope !== 'all'
  ? { action: 'mcp-scope', icon: 'link', label: mcpShared(vaultId, folder) ? t('Freigabe für KI-Agenten aufheben') : t('Für KI-Agenten freigeben'), onClick: () => toggleMcpScope(vaultId, folder) }
  : null);
