// API: Windows passkey provider and AI agents (MCP).

import { shell } from 'electron';
import { launchPath } from '../../bridge.js';
import { MCP_TOOLS, mcpClientConfig } from '../../mcp.js';
import { providerStatus, registerProvider } from '../../windows-provider.js';
import { config, mcp, windows } from '../state.js';
import { mcpScriptPath, mcpTrusted, questions } from '../agents.js';
import { restoreAfterWindowsRequest } from '../windows-passkeys.js';

export const integrationsApi = {
  // Windows passkey provider
  windowsRequests: () => windows.list(),
  windowsDecision: async (id, decision) => {
    await windows.decide(id, decision);
    if (!windows.pending.size) restoreAfterWindowsRequest();
  },
  windowsProviderStatus: () => providerStatus(),
  async windowsProviderRegister() {
    const r = await registerProvider();
    await windows.sync().catch(() => {});
    return r;
  },
  openWindowsPasskeySettings: () => shell.openExternal('ms-settings:savedpasskeys'),
  mcpInfo: () => ({
    enabled: !!config.get().mcpEnabled,
    tools: MCP_TOOLS.map((x) => x.title),
    agents: config.get().approvedAgents,
    rules: config.get().agentRules || {},
    sessions: mcp?.activeSessions() || [],
    ...mcpClientConfig({ command: launchPath(), script: mcpScriptPath() }),
  }),
  mcpRemoveAgent: (agent) => {
    const rules = { ...config.get().agentRules };
    delete rules[agent];
    config.update({ approvedAgents: config.get().approvedAgents.filter((x) => x !== agent), agentRules: rules, mcpTrusted: mcpTrusted().filter((x) => x.agent !== agent) });
    mcp?.revoke(agent);
    return true;
  },
  /** Entries agents read without asking ("never ask again"): [{ agent, vaultId, entryId, title }]. */
  mcpTrusted: () => mcpTrusted(),
  /** Context menu "Freigabe entziehen": the entry needs a confirmation again, for every agent. */
  mcpUntrust: (vaultId, entryId) => {
    config.update({ mcpTrusted: mcpTrusted().filter((x) => !(x.vaultId === vaultId && x.entryId === entryId)) });
    return true;
  },
  /** Rights of an agent: write yes/no, approval for `days` days (0 = until removed). */
  /** Answer to a question from askInApp (agent approvals). */
  answerQuestion: (id, value) => {
    const resolve = questions.get(id);
    if (!resolve) return false;
    questions.delete(id);
    resolve(String(value));
    return true;
  },
  mcpAgentRule: (agent, { write, days }) => {
    const current = config.get().agentRules?.[agent] || { write: true, until: null };
    const rule = {
      write: typeof write === 'boolean' ? write : current.write,
      until: days === undefined ? current.until : (Number(days) > 0 ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null),
    };
    config.update({ agentRules: { ...config.get().agentRules, [agent]: rule } });
    if (rule.write === false) mcp?.revoke(agent);
    return rule;
  },
};
