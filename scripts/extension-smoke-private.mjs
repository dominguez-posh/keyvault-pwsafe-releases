// Extension smoke, part (#476): "Nur für mich" is set and taken back only in the app's admin mode. A save from the
// extension that carries privateOwner (a manipulated or older popup) is stored public: the entry stays in the list,
// in search and autofill for everyone. Hiding other people's private entries is checked in the vault session itself
// (test/private-476.test.js) and in the app's smoke run (desktop/smoke-private.js), which feeds the extension too.

export async function checkPrivateFromExtension({ sw, check, sessionId, personal }) {
  const saved = await sw(sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Smoke Privat Erweiterung', username: 'privat-ext', password: 'Pv-Ext-1',
    urls: ['https://privat.smoke.example'], privateOwner: 'u-alex', privateOwnerName: 'Alex Demo' } });
  try {
    const item = await sw(sessionId, 'item', { containerId: personal.id, id: saved.id, fresh: true });
    check(!item?.privateOwner, `Nur für mich (#476): die Erweiterung hat einen Eintrag privat gemacht ${JSON.stringify({ owner: item?.privateOwner })}`);
    const list = await sw(sessionId, 'items');
    check(Array.isArray(list) && list.some((s) => s.id === saved.id && !s.privateOwner), 'Nur für mich (#476): Eintrag aus der Erweiterung fehlt in der Liste oder ist privat');
  } finally {
    await sw(sessionId, 'delete', { containerId: personal.id, id: saved.id }).catch(() => {});
  }
}
