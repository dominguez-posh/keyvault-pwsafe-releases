// The second Key Vault of the demo as the target of the move checks (#452, #467). The protection flow at the start of a
// full run (desktop/main/smoke.js) protects the first demo Key Vault ("Persönlich") with KV_PROTECTION_PASSWORD and
// leaves it locked; a partial run finds it open. The checks open it for their time and lock it again afterwards, so
// the checks after them see the same state as before.

export const KV_PROTECTION_PASSWORD = 'kv-passwort-1';

/** → { target, done } – target: a writable Key Vault other than `kvc` (null if the demo has none), done(): restores. */
export async function secondVault({ vault, api, kvc }) {
  const writable = (c) => c.kind === 'keyvault' && c.id !== kvc.id && !c.personal && !c.error && c.access?.write !== false;
  const all = await vault.containers();
  const target = all.find((c) => writable(c) && !c.locked);
  if (target) return { target, done: async () => {} };
  const locked = all.find((c) => writable(c) && c.locked);
  if (!locked) return { target: null, seen: all.map((c) => ({ name: c.name, kind: c.kind, locked: !!c.locked, error: !!c.error, access: c.access })), done: async () => {} };
  await api.unlockContainer(locked.id, { password: KV_PROTECTION_PASSWORD });
  const opened = (await vault.containers()).find((c) => c.id === locked.id);
  return { target: opened && !opened.locked ? opened : null, done: () => api.lockContainer(locked.id).catch(() => {}) };
}
