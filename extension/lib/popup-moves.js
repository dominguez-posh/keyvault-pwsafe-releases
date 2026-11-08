// Popup commands for linked assets and moving (#464): with the app they go through its bridge, in the developer demo
// the same core functions run on the demo's own session.

import { movePasskeyBetween, moveWithAssets, planMoveWithAssets } from '../core/move-assets.js';

/** `getVault()` is the current vault object (the demo's session), `app` the app client, `isDemo()` whether the demo runs. */
export function moveHandlers({ getVault, app, isDemo }) {
  return {
    linkedEntries: ({ containerId, id }) => getVault().linkedEntries(containerId, id),
    planMove: async ({ fromId, toId, id }) => {
      if (!isDemo()) return app.planMove(fromId, toId, id);
      const { items, order, ...plan } = await planMoveWithAssets(getVault(), fromId, toId, id);
      return plan;
    },
    move: ({ fromId, toId, id, folder, expectedVersion }) => getVault().moveItem(fromId, toId, id, { folder, expectedVersion }),
    moveWithAssets: ({ fromId, toId, id, folder, expected }) => (isDemo()
      ? moveWithAssets(getVault(), fromId, toId, id, { folder, expected }) : app.moveWithAssets(fromId, toId, id, { folder, expected })),
    movePasskey: ({ from, to, credentialId }) => (isDemo() ? movePasskeyBetween(getVault(), { from, to, credentialId }) : app.movePasskey({ from, to, credentialId })),
  };
}
