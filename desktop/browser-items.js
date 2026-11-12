// #464: the commands of the browser extension for version history, linked assets and moving (the same functions as in
// the app, with the same checks). No Electron here, so unit tests can load it. Rules for everything that leaves here:
//  - no private passkey key goes to the browser (older versions and moved entries are handed out without; #439),
//  - a move needs the write right in the source and in the target, like the app's own move dialog,
//  - a move into another vault is confirmed by the user in the app window first (source, target, entries, passkeys); no confirmation, no move,
//  - a passkey moves only inside one vault,
//  - answers carry only the fields the extension shows.

import { t } from '../extension/core/i18n.js';
import { moveRefusal, moveWithAssets, planMoveWithAssets } from '../extension/core/move-assets.js';
import { withoutPasskeyKeys } from './passkey-keys.js';

const text = (v, what) => {
  if (typeof v !== 'string' || !v || v.length > 300) throw new Error(t('Ungültige Angabe: {what}', { what }));
  return v;
};

/**
 * `deps`: vault (VaultSession), requireOpen(), changed(), movePasskey(args) (the app's function, keys stay inside),
 * checkMove(fromId, toId) (the app's vault rules, e.g. the export lock; main/vault-rules.js).
 * → handlers for the bridge (only for approved browser clients, see browser.js).
 */
export function browserItemHandlers({ vault, requireOpen, changed, movePasskey, confirm, checkMove = async () => {} }) {
  // Moving into another vault: the user confirms in the app (info: { from, to, entries: [{ title, passkey }] }); without a way to ask: refused.
  const confirmed = async (info) => {
    if (typeof confirm !== 'function' || (await confirm(info)) !== true) throw new Error(t('Das Verschieben wurde im Keevault-Fenster nicht bestätigt'));
  };
  const CHANGED = t('Die Einträge haben sich geändert, seit die Bestätigung angezeigt wurde. Es wurde nichts verschoben. Bitte die Verschiebung neu starten.');
  // What the card names: { from, to, entries: [{ title, passkey }] } – all entries, the card shortens the list.
  const cardInfo = async (fromId, toId, entries) => ({
    from: (await vault.container(fromId)).name, to: (await vault.container(toId)).name,
    entries: entries.map((e) => ({ title: e.title, passkey: (e.passkeys || []).length > 0 })),
  });
  const signature = (plan) => plan.order.map((id) => `${id}@${plan.items.get(id).version}`).join('|');
  const both = async (fromId, toId) => {
    const [from, to] = await Promise.all([vault.container(text(fromId, 'from')), vault.container(text(toId, 'to'))]);
    await checkMove(fromId, toId);
    const refused = moveRefusal(from, to);
    if (refused) throw new Error(refused);
  };
  const writable = async (containerId) => {
    const c = await vault.container(text(containerId, 'container'));
    if (c.access?.write === false) throw new Error(t('Im Tresor „{vault}“ fehlt das Schreibrecht', { vault: c.name }));
  };
  const moveArgs = (msg) => ({ fromId: text(msg.fromId, 'from'), toId: text(msg.toId, 'to'), itemId: text(msg.itemId, 'entry') });
  const folderOf = (msg) => (typeof msg.folder === 'string' && msg.folder.length <= 1000 ? { folder: msg.folder } : {});

  return {
    // Reading only. Version list: no more than the fields the timeline shows.
    history: async ({ containerId, itemId }) => {
      requireOpen();
      const list = await vault.history(text(containerId, 'container'), text(itemId, 'entry'));
      return list.map((v) => ({ version: v.version, updated: v.updated, enabled: v.enabled !== false, updatedBy: v.updatedBy || '' }));
    },
    // An older version, never with the private passkey key.
    version: async ({ containerId, itemId, version }) => {
      requireOpen();
      const v = typeof version === 'number' && Number.isFinite(version) ? version : text(version, 'version'); // file vaults number their versions
      return withoutPasskeyKeys(await vault.getVersion(text(containerId, 'container'), text(itemId, 'entry'), v));
    },
    linkedEntries: async ({ containerId, itemId }) => {
      requireOpen();
      const list = await vault.linkedEntries(text(containerId, 'container'), text(itemId, 'entry'));
      return list.map((e) => ({ key: e.key, containerId: e.containerId, id: e.id, title: e.title, type: e.type, uses: e.uses }));
    },
    // What a move would take along; changes nothing.
    planMove: async (msg) => {
      requireOpen();
      const { fromId, toId, itemId } = moveArgs(msg);
      await checkMove(fromId, toId);
      const { items, order, ...plan } = await planMoveWithAssets(vault, fromId, toId, itemId);
      return plan;
    },
    // Writing: the same refusals as in the app (rights on both sides, shared → personal).
    move: async (msg) => {
      requireOpen();
      const { fromId, toId, itemId } = moveArgs(msg);
      await both(fromId, toId);
      if (fromId !== toId) {
        // The card shows this version of the entry: another one after the confirmation (or in the browser's request) → nothing moves.
        const item = await vault.getItem(fromId, itemId, { fresh: true });
        if (msg.expectedVersion !== undefined && msg.expectedVersion !== item.version) throw new Error(CHANGED);
        await confirmed(await cardInfo(fromId, toId, [item]));
        if ((await vault.getItem(fromId, itemId, { fresh: true })).version !== item.version) throw new Error(CHANGED);
      }
      const saved = await vault.moveItem(fromId, toId, itemId, folderOf(msg));
      changed();
      return withoutPasskeyKeys(saved);
    },
    moveWithAssets: async (msg) => {
      requireOpen();
      const { fromId, toId, itemId } = moveArgs(msg);
      await both(fromId, toId);
      // The plan the user confirms is the one that moves: the browser must name exactly its entries, and after the
      // confirmation the plan is calculated again and must be the same (same entries, same versions).
      const plan = await planMoveWithAssets(vault, fromId, toId, itemId);
      if (plan.refused) throw new Error(plan.refused);
      const expected = plan.order;
      const named = msg.expected;
      if (!Array.isArray(named) || named.length !== expected.length || !named.every((e) => typeof e === 'string' && expected.includes(e))) throw new Error(CHANGED);
      let checked = plan;
      if (fromId !== toId) {
        await confirmed(await cardInfo(fromId, toId, plan.members.map((m) => plan.items.get(m.id))));
        checked = await planMoveWithAssets(vault, fromId, toId, itemId);
        if (checked.refused || signature(checked) !== signature(plan)) throw new Error(CHANGED);
      }
      try {
        // #474: exactly the plan just compared moves – no third calculation between the check and the writes.
        const { saved, moved, dropped } = await moveWithAssets(vault, fromId, toId, itemId, { ...folderOf(msg), expected, plan: checked });
        return { saved: withoutPasskeyKeys(saved), moved, dropped };
      } finally {
        changed();
      }
    },
    // The passkey moves inside the app (its key never leaves it); the browser names only the credential and the entries.
    movePasskey: async ({ from, to, credentialId }) => {
      requireOpen();
      const ref = (x) => ({ containerId: text(x?.containerId, 'container'), id: text(x?.id, 'entry') });
      const source = ref(from);
      const target = ref(to);
      if (source.containerId !== target.containerId) throw new Error(t('Ein Passkey lässt sich aus dem Browser nur innerhalb desselben Tresors verschieben'));
      await writable(source.containerId);
      await writable(target.containerId);
      const moved = await movePasskey({ from: source, to: target, credentialId: text(credentialId, 'passkey') });
      changed();
      return !!moved;
    },
  };
}

export const ITEM_CAPS = ['history', 'linkedEntries', 'move', 'movePasskey'];
