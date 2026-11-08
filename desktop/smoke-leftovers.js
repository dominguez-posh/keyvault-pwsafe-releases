// Keeps the areas of the feature checks (desktop/smoke-features.js) apart: an area that leaves entries behind in the demo
// vault is named, and the entries go, so the next areas start with the same vault. Without a license the demo vault
// holds 10 entries; one leftover login of "cutpaste" made "devices" fail much later with the license message.

/** → async (area, fail): after each area, reports and deletes entries in `kvc` that were not there at the start. */
export async function leftoverGuard({ vault, kvc, changed }) {
  const ids = async () => (await vault.summaries()).filter((x) => x.containerId === kvc.id);
  const start = new Set((await ids()).map((x) => x.id));
  return async (area, fail) => {
    const left = (await ids()).filter((x) => !start.has(x.id));
    if (!left.length) return;
    fail(area, `left entries behind in "${kvc.name}": ${left.map((x) => x.title).join(', ')}`);
    // Newest last in the list: assets go before the logins they use (those cannot be deleted while in use).
    for (const x of [...left].reverse()) await vault.deleteItem(kvc.id, x.id).catch(() => {});
    for (const x of (await ids()).filter((y) => !start.has(y.id))) await vault.deleteItem(kvc.id, x.id).catch(() => {});
    changed();
  };
}
