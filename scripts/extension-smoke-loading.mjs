// Extension smoke, part (#495): the popup's loading state. Without the app the popup ends in a readable state with
// "Erneut versuchen" (never an endless loading state), and the retry goes through the loading state again. With a
// slow answer (developer demo, devDemoDelay) the loading state from popup.html – on screen with the first paint – shows
// "Verbinde mit Keevault …", then the list follows and the loading state is gone.

const LOADING = 'document.querySelector("#view > .loading-state")';
const NO_APP = /Keevault-App (läuft nicht|fehlt)|Keevault app is not running|Keevault app is missing/;

/** Without the app: the offline view offers "Erneut versuchen"; it loads again and ends in the offline view again. */
export async function checkPopupOffline({ evaluate, waitFor, check, popup }) {
  const p = popup.sessionId;
  check(await waitFor(() => evaluate(p, '!!document.querySelector(".load-retry")')), 'Ladezustand (#495): ohne App kein „Erneut versuchen“');
  check(await evaluate(p, `!${LOADING}`), 'Ladezustand (#495): ohne App bleibt der Ladezustand stehen');
  await evaluate(p, `(() => { document.querySelector(".load-retry").click(); return true; })()`);
  // The retry shows the loading state at once (synchronously in load()), then the offline view again.
  const after = JSON.parse(await evaluate(p, `JSON.stringify({ loading: !!${LOADING} })`) || '{}');
  check(after.loading || (await waitFor(() => evaluate(p, '!!document.querySelector(".load-retry")'), 3000)), 'Ladezustand (#495): „Erneut versuchen“ ohne Wirkung');
  const text = await waitFor(async () => {
    const tx = await evaluate(p, `!${LOADING} && document.querySelector(".load-retry") ? document.body.innerText : ""`);
    return NO_APP.test(tx) && tx;
  }, 5000);
  check(text, 'Ladezustand (#495): nach „Erneut versuchen“ ohne App kein lesbarer Fehlerzustand');
}

/** Slow answer (demo): loading state from the page with the step text at once, then the list. → popup times */
export async function checkPopupLoading({ open, evaluate, waitFor, check, sleep, ext, sessionId }) {
  await evaluate(sessionId, 'chrome.storage.local.set({ devDemoDelay: 1500 }).then(() => true)');
  try {
    const popup = await open(`${ext}/popup/popup.html`);
    const p = popup.sessionId;
    const first = JSON.parse(await evaluate(p, `JSON.stringify({ loading: !!${LOADING}, fromPage: ${LOADING}?.dataset.fromPage === "1",
      step: document.querySelector("#view > .loading-state .loading-step")?.textContent || "", rows: document.querySelectorAll(".row-item").length,
      paint: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1) })`) || '{}');
    check(first.loading && first.rows === 0, `Ladezustand (#495): nicht sofort da (${JSON.stringify(first)})`);
    check(first.fromPage, 'Ladezustand (#495): nicht der aus popup.html (erst nach dem Skript sichtbar)');
    check(/Verbinde mit Keevault|Connecting to Keevault/.test(first.step), `Ladezustand (#495): Schritt-Text „${first.step}“`);
    check(await waitFor(() => evaluate(p, `document.querySelectorAll(".row-item").length > 0 && !${LOADING}`), 8000), 'Ladezustand (#495): danach keine Liste');
    const times = JSON.parse(await evaluate(p, 'JSON.stringify(window.kvLoadTimes || {})') || '{}');
    check(times.state >= 1400, `Ladezustand (#495): Verzögerung nicht gemessen (${JSON.stringify(times)})`);
    await sleep(100);
    return { firstPaintMs: first.paint, ...times };
  } finally {
    await evaluate(sessionId, 'chrome.storage.local.remove("devDemoDelay").then(() => true)');
  }
}
