// #484: the entry API refuses the vault's own secrets (keyring, container marker, policy) as entry IDs, so an agent or
// a crafted save can't overwrite them. Runs with the refused-deletion check (desktop/smoke-delete-refused.js).
const AREA = 'internalsecrets';

export async function internalSecretsCheck({ fail, vault, kvc }) {
  for (const id of ['pws-keyring', 'pws-container', 'pws-policy']) {
    const read = await vault.getItem(kvc.id, id, { fresh: true }).then(() => 'read', (e) => e.message);
    if (!/Eintrags-ID|entry ID/.test(read)) fail(AREA, `${id}: read not refused (${read})`);
    const saved = await vault.saveItem(kvc.id, { id, type: 'login', title: 'Smoke internal', password: 'x' }).then(() => 'saved', (e) => e.message);
    if (!/Eintrags-ID|entry ID/.test(saved)) fail(AREA, `${id}: save not refused (${saved})`);
  }
}
