// Extension smoke, part (#506): the main button of a popup state shows its content centred – icon and label together
// within ±2 px of the button's middle – and an icon in it is visible (not in the button's own background colour). The
// state "Keevault-App läuft nicht" ("Keevault starten") comes from an imitated app that drops the connection at once:
// no host error, so the popup takes it as a stopped app, not a missing one.

/** The service worker's native port: opens and drops at once without an error (the app is not running). */
export const stoppedApp = `(() => {
  chrome.runtime.connectNative = () => {
    const gone = [];
    setTimeout(() => { for (const fn of gone) fn(); }, 0);
    return { onMessage: { addListener: () => {} }, onDisconnect: { addListener: (fn) => gone.push(fn) }, postMessage: () => {}, disconnect: () => {} };
  };
  return true;
})()`;

/** Where the button's content sits against the button, and the colours of its icons against its background. */
export const buttonLayout = (selector) => `JSON.stringify((() => {
  const b = document.querySelector(${JSON.stringify(selector)});
  if (!b) return null;
  const box = b.getBoundingClientRect();
  const bg = getComputedStyle(b).backgroundColor;
  const unseen = (n) => n.nodeType === Node.ELEMENT_NODE && getComputedStyle(n).color === bg; // takes space, shows nothing
  const parts = [];
  for (const n of b.childNodes) {
    if ((n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) || unseen(n)) continue; // what a person sees counts
    const r = document.createRange();
    r.selectNodeContents(n);
    const rect = n.nodeType === Node.TEXT_NODE ? r.getBoundingClientRect() : n.getBoundingClientRect();
    if (rect.width) parts.push(rect);
  }
  if (!parts.length) return { text: b.textContent.trim(), offsetX: null };
  const left = Math.min(...parts.map((p) => p.left));
  const right = Math.max(...parts.map((p) => p.right));
  const top = Math.min(...parts.map((p) => p.top));
  const bottom = Math.max(...parts.map((p) => p.bottom));
  return {
    text: b.textContent.trim(),
    offsetX: Math.round(((left + right) / 2 - (box.left + box.right) / 2) * 10) / 10,
    offsetY: Math.round(((top + bottom) / 2 - (box.top + box.bottom) / 2) * 10) / 10,
    hiddenIcons: [...b.querySelectorAll('.icon')].filter((i) => getComputedStyle(i).color === bg).length,
  };
})())`;

/** Checks one button: content centred ±2 px, no icon in the background colour. */
export async function checkButtonCentred({ evaluate, check, sessionId, selector, what }) {
  const v = JSON.parse((await evaluate(sessionId, buttonLayout(selector))) || 'null');
  check(v, `#506: ${what}: Knopf ${selector} fehlt`);
  if (!v) return;
  check(v.offsetX !== null && Math.abs(v.offsetX) <= 2, `#506: ${what}: Inhalt von „${v.text}“ nicht mittig (${v.offsetX} px waagrecht)`);
  check(v.offsetY !== null && Math.abs(v.offsetY) <= 2, `#506: ${what}: Inhalt von „${v.text}“ nicht mittig (${v.offsetY} px senkrecht)`);
  check(!v.hiddenIcons, `#506: ${what}: Symbol in „${v.text}“ unsichtbar (Farbe des Knopfs)`);
}

/** "Keevault-App läuft nicht": the start button is centred. Leaves the stopped imitation in place (later parts replace it). */
export async function checkStartButtonCentred({ send, evaluate, open, waitFor, check, ext, workerSession }) {
  await evaluate(workerSession, stoppedApp);
  await new Promise((r) => setTimeout(r, 2200)); // the client tries the host again after 2 s
  const popup = await open(`${ext}/popup/popup.html`);
  try {
    const shown = await waitFor(() => evaluate(popup.sessionId, '/Keevault-App läuft nicht/.test(document.body.innerText) && !!document.querySelector("#view .btn.primary")'));
    check(shown, '#506: Popup zeigt nicht „Keevault-App läuft nicht“ mit „Keevault starten“');
    if (shown) await checkButtonCentred({ evaluate, check, sessionId: popup.sessionId, selector: '#view .btn.primary', what: 'Keevault starten' });
  } finally {
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  }
}
