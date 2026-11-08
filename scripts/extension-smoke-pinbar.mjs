// Extension smoke, part (#465): with the app PIN before every passkey use, "Use passkey" in the Keevault tag opens the
// PIN field inside the tag – in a frame of the extension, not in the page. A wrong PIN shows the app's error in the
// frame and keeps the request open, the right one signs in. Runs against the imitated app of extension-smoke-pin.mjs
// (the developer demo has no app and no PIN), switched to an open app with one passkey for this test page.

export const PIN = '2468';

/** The imitated app, now open: PIN on, one passkey for localhost; passkeySign checks the PIN like the app does (#439). */
export const openAppWithPin = `(() => {
  const app = globalThis.__kvApp;
  if (!app) return false;
  const passkey = { credentialId: 'AQIDBA', rpId: 'localhost', userName: 'smoke@example.com' };
  app.pins = [];
  Object.assign(app.answers, {
    hello: { version: '0.9.30', opened: true, caps: ['passkeySign'] },
    snapshot: { version: '0.9.30', opened: true, pinSet: true, passkeyPin: { required: true, pinSet: true }, containers: [{ id: 'c1', name: 'Smoke' }], summaries: [] },
    passkeyCandidates: [{ containerId: 'c1', itemId: 'i1', title: 'Smoke', urls: [], passkey }],
    passkeySign: (args) => {
      app.pins.push(args.pin);
      if (args.pin !== ${JSON.stringify(PIN)}) throw new Error('Falsche PIN. Noch 4 Versuche.');
      return { response: { id: 'AQIDBA', rawId: 'AQIDBA', type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA', userHandle: 'AQID' } } };
    },
  });
  for (const fn of app.listeners) fn({ event: 'changed' }); // the extension forgets its snapshot
  return true;
})()`;

const KEY_ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };

export async function checkPinInBar({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession, settle }) {
  check(await evaluate(workerSession, openAppWithPin), '#465: Nachbildung der App nicht gefunden');
  const tab = await open(`${origin}/`);
  try {
    await evaluate(tab.sessionId, 'startGet(), true');
    const use = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .primary'));
    check(use, '#465: kein Passkey-Schild mit „Passkey verwenden“');
    check(!(await findTarget(`${ext}/prompt/prompt.html`)), '#465: eigenes Fenster statt der Leiste');
    if (!use) return;
    await sleep(settle);
    await clickNode(tab.sessionId, '.kvtag .primary');
    // Shown only after the worker reported our page in it (pinframe:ready); until then hidden, the tag "loading".
    const frameNode = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag iframe.pinframe:not([hidden])'));
    check(frameNode, '#465: Leiste klappt nicht auf (kein PIN-Rahmen oder nie als bereit gemeldet)');
    check(!(await shadowNode(tab.sessionId, 'kvpwsafe-ui', 'input')), '#465: Eingabefeld im Schild auf der Seite');
    // use_dynamic_url: the tag loads the frame from what runtime.getURL gives (the per-session id where the browser uses
    // it), but the browser commits the document under the extension's own origin – Edge 2026-11 reports the frame target
    // with the fixed id. Either way it must be this extension's pin.html.
    const pinUrl = await evaluate(workerSession, 'chrome.runtime.getURL("pin/pin.html")');
    const target = await waitFor(async () => (await findTarget(`${pinUrl}#`)) || findTarget(`${ext}/pin/pin.html#`));
    check(target, `#465: PIN-Feld liegt nicht im Rahmen der Erweiterung (${pinUrl})`);
    if (pinUrl !== `${ext}/pin/pin.html`) {
      // Dynamic id in effect: the page must not reach the page under the fixed id (no probe for the extension).
      const probe = await evaluate(tab.sessionId, `fetch(${JSON.stringify(`${ext}/pin/pin.html`)}).then(() => 'geladen', () => 'gesperrt')`);
      check(probe === 'gesperrt', `#465: pin.html unter der festen ID von der Seite ladbar (${probe})`);
    } else {
      console.log('#465: Browser vergibt keine dynamische ID (use_dynamic_url ohne Wirkung), Prüfung der festen ID übersprungen');
    }
    if (!frameNode || !target) return;
    const frame = await attach(target.targetId);
    check(await waitFor(() => evaluate(frame, '!!document.querySelector("input.pin")')), '#465: Rahmen ohne PIN-Feld');
    // Into the field with a real click, then wait for the visibility guard inside and outside the frame (#373/#401).
    // By selector: the node id from above is stale once the tag has re-rendered or the document was fetched again.
    await clickNode(tab.sessionId, '.kvtag iframe.pinframe:not([hidden])');
    await sleep(1500);
    const typePin = async (text) => {
      await evaluate(frame, 'document.querySelector("input.pin").focus(), true');
      await send('Input.insertText', { text }, tab.sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEY_ENTER, text: '\r' }, tab.sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEY_ENTER }, tab.sessionId);
    };
    await typePin('1111');
    const problem = await waitFor(() => evaluate(frame, 'document.querySelector(".problem:not([hidden])")?.textContent || ""'));
    check(/Falsche PIN/.test(problem || ''), `#465: falsche PIN zeigt keinen Fehler im Rahmen (${problem || 'nichts'})`);
    check(!(await evaluate(tab.sessionId, 'results')).get, '#465: falsche PIN meldet an');
    check(await evaluate(frame, 'document.querySelector("input.pin").value === ""'), '#465: PIN bleibt nach dem Versuch im Feld');
    await typePin(PIN);
    const got = await waitFor(() => evaluate(tab.sessionId, 'results.get'));
    check(got === 'resolved', `#465: richtige PIN meldet nicht an (${got})`);
    const pins = await evaluate(workerSession, 'JSON.stringify(globalThis.__kvApp.pins)');
    check(pins === JSON.stringify(['1111', PIN]), `#465: App bekam andere PINs: ${pins}`);
    check(!(await findTarget(`${ext}/prompt/prompt.html`)), '#465: eigenes Fenster geöffnet');
  } finally {
    await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }
}
