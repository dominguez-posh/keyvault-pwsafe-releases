// #495: what the popup can show at once while it loads. The last list the app sent – entry metadata only, exactly what
// the service worker already holds in memory (lib/desktop.js), no secrets and nothing stored anywhere – marked
// "wird aktualisiert" until the fresh state is there. Null without such a list: worker just started, app locked or
// offline (every app event clears it), developer demo.

/** Vaults of a snapshot with their entry counts (null for a locked one). */
export const withCounts = (snap) => snap.containers.map((c) => ({ ...c, count: c.locked ? null : snap.summaries.filter((x) => x.containerId === c.id).length }));

/** → { state, items } in the shape of the "state" and "items" commands, or null. */
export function peekState(snap, { settings, features, extensionId, version }) {
  if (!snap?.opened || !Array.isArray(snap.summaries) || !Array.isArray(snap.containers)) return null;
  return {
    state: {
      demo: false,
      canHistory: features.history, canAssets: features.assets, canMove: features.move, canMovePasskey: features.passkeyMove,
      desktop: { connected: true, version: snap.version, opened: true, pinSet: !!snap.pinSet },
      open: true,
      containers: withCounts(snap),
      settings,
      extensionId,
      version,
      cached: true,
    },
    items: snap.summaries,
  };
}

/** Developer demo only (automated tests): the "state" answer waits chrome.storage.local devDemoDelay ms (at most 5 s), so
 * the smoke test can see the popup's loading state. */
export async function devDemoDelay() {
  const { devDemoDelay: ms } = await chrome.storage.local.get('devDemoDelay');
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(Number(ms), 5000)));
}
