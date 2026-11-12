// Extension smoke, part (#505): warm start. A lost native host (an app update ends it) is started again by the worker
// itself, without any page asking, and with a warm worker the popup shows the list within 300 ms. Runs against an imitated
// open app (the demo has no native port), after the PIN part and before the demo starts.

const POPUP_LIST_MS = 300;

/** An open app with one entry; counts the ports the worker opens and can end the current one like a lost host. */
const openApp = `(() => {
  const state = globalThis.__kvWarm = { connects: 0, lose: null };
  chrome.runtime.connectNative = () => {
    state.connects++;
    const message = [];
    const disconnect = [];
    const answers = {
      hello: { version: '0.0.0', opened: true, caps: [] },
      snapshot: {
        version: '0.0.0', opened: true, pinSet: false,
        containers: [{ id: 'warm-vault', name: 'Warm' }],
        summaries: [{ id: 'warm-1', containerId: 'warm-vault', type: 'login', title: 'Warmstart', username: 'u', hosts: ['example.com'], rpIds: [], favorite: false }],
      },
    };
    state.lose = () => disconnect.forEach((fn) => fn());
    setTimeout(() => message.forEach((fn) => fn({ event: 'online' })), 0);
    return {
      onMessage: { addListener: (fn) => message.push(fn) },
      onDisconnect: { addListener: (fn) => disconnect.push(fn) },
      postMessage: ({ id, cmd }) => setTimeout(() => {
        const reply = cmd in answers ? { id, ok: true, result: answers[cmd] } : { id, ok: false, error: { message: 'Unknown command ' + cmd } };
        message.forEach((fn) => fn(reply));
      }, 0),
    };
  };
  return true;
})()`;

export async function checkWarmStart({ send, evaluate, open, waitFor, check, sleep, ext, workerSession }) {
  await evaluate(workerSession, openApp);
  // The PIN part left a port to its own imitation open: end it like a lost host, then the worker must reconnect alone.
  await evaluate(workerSession, '((globalThis.__kvApp?.disconnect || []).forEach((fn) => fn()), true)');
  const reconnected = await waitFor(() => evaluate(workerSession, '__kvWarm.connects >= 1'), 70_000);
  check(reconnected, 'Warmstart (#505): Worker verbindet sich nach verlorenem Host nicht selbst neu');
  // A second loss right after "online": back to the short wait (1 s, plus the next growth step at most 2 s).
  await sleep(200);
  await evaluate(workerSession, '(__kvWarm.connects = 0, __kvWarm.lose(), true)');
  const t0 = Date.now();
  check(await waitFor(() => evaluate(workerSession, '__kvWarm.connects >= 1'), 5000), 'Warmstart (#505): kein neuer Port innerhalb von 5 s nach "online"');
  console.log(`Warmstart (#505): neuer Port nach ${Date.now() - t0} ms`);
  await sleep(300);
  // Warm worker and port: the popup's list from its own start.
  const popup = await open(`${ext}/popup/popup.html`);
  const ms = await waitFor(() => evaluate(popup.sessionId, `document.querySelector('.row-item') ? Math.round(performance.now()) : 0`));
  console.log(`Warmstart (#505): Popup-Liste nach ${ms} ms`);
  check(ms && ms < POPUP_LIST_MS, `Warmstart (#505): Popup-Liste nach ${ms} ms (Grenze ${POPUP_LIST_MS} ms)`);
  await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
}
