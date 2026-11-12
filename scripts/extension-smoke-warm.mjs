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
      // #533: the entry, so the popup can open it while the fresh list is still on its way.
      item: { id: 'warm-1', containerId: 'warm-vault', type: 'login', title: 'Warmstart', username: 'u', password: 'p', urls: ['https://example.com'], fields: [], passkeys: [], tags: [], attachments: [], version: '1' },
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
  const polled = await waitFor(() => evaluate(popup.sessionId, `document.querySelector('.row-item') ? Math.round(performance.now()) : 0`));
  // #530: the time the popup put the rows into the page (kvMarks.list), not the time this check, polling every 250 ms,
  // happened to look – that one says more about the poll than about the popup. Same limit, measured where it happens.
  const marks = JSON.parse(await evaluate(popup.sessionId, 'JSON.stringify(window.kvMarks || {})') || '{}');
  const ms = marks.list;
  console.log(`Warmstart (#505): Popup-Liste nach ${ms} ms (Module ${marks.module} ms, letzte Liste ${marks.peek} ms, gesehen nach ${polled} ms)`);
  check(polled && ms && ms < POPUP_LIST_MS, `Warmstart (#505): Popup-Liste nach ${ms} ms (Grenze ${POPUP_LIST_MS} ms)`);
  // #530: the QR decoder is no longer loaded before the list, and still loads on first use (script from the extension
  // itself, allowed by its CSP). The entry views loaded on first use are covered by the popup's detail checks of the demo.
  check(await evaluate(popup.sessionId, 'typeof window.jsQR') === 'undefined', 'Warmstart (#530): jsQR wird vor der Liste geladen');
  check(await evaluate(popup.sessionId, `import(new URL('lazy.js', location.href).href).then((m) => m.qrDecoder()).then((f) => typeof f, (e) => 'Fehler ' + e.message)`) === 'function', 'Warmstart (#530): QR-Decoder lädt bei Bedarf nicht');
  await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  await checkOpenedStays({ send, evaluate, waitFor, check, sleep, ext });
}

/** In this popup page only: the fresh "state" answer comes 1.5 s late, the last list (peek) at once. */
const slowState = `(() => {
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (m, ...rest) => (m?.cmd === 'state' ? new Promise((r) => setTimeout(r, 1500)).then(() => send(m, ...rest)) : send(m, ...rest));
})()`;

/**
 * #533: an entry opened from the cached list stays open when the fresh list comes in later (before: reload() drew the
 * list over it). Back in the list, the fresh list is there.
 */
async function checkOpenedStays({ send, evaluate, waitFor, check, sleep, ext }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: slowState }, sessionId);
  await send('Page.navigate', { url: `${ext}/popup/popup.html` }, sessionId);
  try {
    const cached = await waitFor(() => evaluate(sessionId, '!!document.querySelector(".row-item") && !!document.querySelector(".refreshing") && !window.kvLoadTimes.state'), 3000);
    check(cached, '#533: Popup zeigt die zwischengespeicherte Liste nicht vor der frischen');
    if (!cached) return;
    await evaluate(sessionId, 'document.querySelector(".row-item").click(), true');
    check(await waitFor(() => evaluate(sessionId, '!!document.querySelector(".view.detail")'), 3000), '#533: Eintrag aus der zwischengespeicherten Liste öffnet sich nicht');
    check(await waitFor(() => evaluate(sessionId, 'window.kvLoadTimes.items >= 0'), 5000), '#533: frische Liste kommt nicht an');
    await sleep(300);
    check(await evaluate(sessionId, '!!document.querySelector(".view.detail") && !document.querySelector(".row-item")'), '#533: frische Liste überschreibt den geöffneten Eintrag');
    await evaluate(sessionId, 'document.querySelector(".back button").click(), true');
    check(await waitFor(() => evaluate(sessionId, '!!document.querySelector(".row-item") && !document.querySelector(".refreshing")'), 3000), '#533: zurück in der Liste fehlt die frische Liste');
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}
