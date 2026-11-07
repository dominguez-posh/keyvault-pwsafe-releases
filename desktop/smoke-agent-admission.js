// Smoke check of #369 on the real wiring of the app (McpService as started in main.js, settings, API): an agent that
// is already connected loses its access with its approval. Part of the feature checks (desktop/smoke-features.js),
// which have reached their size limit.

const NOT_ADMITTED = /nicht mehr zugelassen|no longer approved/;
const READ_ONLY = /nur lesen|read-only/i;

export async function agentAdmissionCheck({ fail, sleep, config, api, mcpService }) {
  const area = 'agentrevoke';
  const agent = 'smoke-revoke';
  const client = { agent };
  const before = { mcpEnabled: config.get().mcpEnabled, approvedAgents: config.get().approvedAgents, agentRules: config.get().agentRules };
  const admit = (rule) => config.update({ mcpEnabled: true, approvedAgents: [...before.approvedAgents, agent], agentRules: { ...before.agentRules, ...(rule ? { [agent]: rule } : {}) } });
  // → 'ok' or the refusal. Without the fix a write would wait for its question: the step's end closes that dialog.
  const result = (tool, args = {}) => Promise.race([
    mcpService.call(client, tool, args).then(() => 'ok', (e) => e.message),
    sleep(1500).then(() => 'asks the user'),
  ]);
  try {
    admit({ write: false, until: null });
    const running = await result('list_vaults');
    if (running !== 'ok') fail(area, `an approved agent was refused: ${running}`);

    // Revoked in the settings while it runs.
    await api.mcpRemoveAgent(agent);
    const revoked = await result('list_vaults');
    if (!NOT_ADMITTED.test(revoked)) fail(area, `revoked agent: next call got "${revoked}"`);

    // The approval ran out while it runs.
    admit({ write: false, until: new Date(Date.now() - 1000).toISOString() });
    const expired = await result('list_vaults');
    if (!NOT_ADMITTED.test(expired)) fail(area, `expired approval: next call got "${expired}"`);

    // The function is switched off while it runs.
    admit({ write: false, until: null });
    config.update({ mcpEnabled: false });
    const off = await result('list_vaults');
    if (!NOT_ADMITTED.test(off)) fail(area, `function switched off: next call got "${off}"`);

    // Without a saved rule an agent can only read.
    admit(null);
    const noRule = await result('create_entry', { vaultId: 'smoke', title: 'Smoke Revoke' });
    if (!READ_ONLY.test(noRule)) fail(area, `agent without a rule: writing got "${noRule}"`);
  } finally {
    config.update(before);
  }
}
