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
    // A wrong PIN takes the app a moment (#508: the frame shows "Entsperre …" meanwhile).
    passkeySign: async (args) => {
      app.pins.push(args.pin);
      if (args.pin !== ${JSON.stringify(PIN)}) {
        await new Promise((r) => setTimeout(r, 1500));
        throw new Error('Falsche PIN. Noch 4 Versuche.');
      }
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
    const shownAt = Date.now();
    // #496: the very first click on the fresh page, as a person does it – right after the tag has dropped in (0.6 s),
    // while it still swings. That one click must open the PIN field (once the tag has settled), not end in "Nichts
    // eingefügt" and need a second click. No second click here.
    await sleep(700);
    await clickNode(tab.sessionId, '.kvtag .primary');
    check(await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag iframe.pinframe')), '#496: erster Klick öffnet kein PIN-Feld');
    // The refusal is drawn by CSS into the account line (data-t, #383): read it from the attributes.
    const subNode = await shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .switch .sub');
    const attrs = subNode ? (await send('DOM.getAttributes', { nodeId: subNode }, tab.sessionId).catch(() => ({}))).attributes || [] : [];
    const at = attrs.indexOf('data-t');
    const subText = at >= 0 ? attrs[at + 1] : '';
    check(!/Nichts eingefügt/.test(subText), `#496: erster Klick auf „Passkey verwenden“ abgewiesen (${subText})`);
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
    await sleep(Math.max(0, shownAt + settle - Date.now())); // the frame swings with the tag: visible for 500 ms only after that
    const typePin = async (text) => {
      await evaluate(frame, 'document.querySelector("input.pin").focus(), true');
      await send('Input.insertText', { text }, tab.sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEY_ENTER, text: '\r' }, tab.sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEY_ENTER }, tab.sessionId);
    };
    await typePin('1111');
    // #508: while the app checks the PIN the frame says so and the field is locked.
    const busy = await waitFor(() => evaluate(frame, '!!document.querySelector(".busy:not([hidden]) .spinner") && document.querySelector("input.pin").disabled'), 1400);
    check(busy, '#508: PIN-Feld der Leiste zeigt kein „Entsperre …“ oder bleibt bedienbar');
    // #526: the locked field stays fully opaque – the visibility guard counts opacity below 1 as covered.
    if (busy) check(await evaluate(frame, 'getComputedStyle(document.querySelector("input.pin")).opacity === "1"'), '#526: gesperrtes PIN-Feld mit Deckkraft unter 1 (Sichtbarkeitsschutz beginnt neu)');
    const problem = await waitFor(() => evaluate(frame, 'document.querySelector(".problem:not([hidden])")?.textContent || ""'));
    check(/Falsche PIN/.test(problem || ''), `#465: falsche PIN zeigt keinen Fehler im Rahmen (${problem || 'nichts'})`);
    check(!(await evaluate(tab.sessionId, 'results')).get, '#465: falsche PIN meldet an');
    check(await evaluate(frame, 'document.querySelector("input.pin").value === ""'), '#465: PIN bleibt nach dem Versuch im Feld');
    check(await evaluate(frame, '!document.querySelector("input.pin").disabled && !!document.querySelector(".busy[hidden]")'), '#508: nach falscher PIN bleibt das Feld der Leiste gesperrt');
    await typePin(PIN);
    const got = await waitFor(() => evaluate(tab.sessionId, 'results.get'));
    const why = got === 'resolved' ? '' : await evaluate(frame, 'document.querySelector(".problem:not([hidden])")?.textContent || ""').catch(() => '');
    check(got === 'resolved', `#465: richtige PIN meldet nicht an (${got}${why ? `, Rahmen: ${why}` : ''})`);
    const pins = await evaluate(workerSession, 'JSON.stringify(globalThis.__kvApp.pins)');
    check(pins === JSON.stringify(['1111', PIN]), `#465: App bekam andere PINs: ${pins}`);
    check(!(await findTarget(`${ext}/prompt/prompt.html`)), '#465: eigenes Fenster geöffnet');
  } finally {
    await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }
}

/**
 * #537 (Lena, Konrad): with Windows Hello on, the bar asks Hello by itself once (the field hidden until then); the
 * imitated app refuses it (not the right PIN), so the field shows – with the focus – and Hello does not start again. The
 * frame takes the height it reports: Hello, "or", the field and the error all inside, light, dark and in English. A second
 * request of the same site within 60 s starts nothing by itself (Konrad, low).
 */
export async function checkPinBarHello({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession }) {
  const helloOn = `(() => {
    const app = globalThis.__kvApp;
    if (!app) return false;
    app.answers.snapshot = { ...app.answers.snapshot, passkeyPin: { required: true, pinSet: true, masterPassword: true, hello: true } };
    for (const fn of app.listeners) fn({ event: 'changed' });
    return true;
  })()`;
  check(await evaluate(workerSession, helloOn), '#537: Nachbildung der App nicht gefunden (Hello-Leiste)');
  await evaluate(workerSession, 'chrome.storage.session.remove("helloAuto:localhost").then(() => true)');
  const variants = [{ name: 'hell', auto: true }, { name: 'dunkel', dark: true, auto: false }, { name: 'EN', en: true, auto: false }];
  try {
    for (const v of variants) {
      if (v.en) await evaluate(workerSession, 'chrome.storage.local.get("settings").then(({ settings = {} }) => chrome.storage.local.set({ settings: { ...settings, language: "en" } })).then(() => true)');
      const tab = await open(`${origin}/`);
      try {
        await evaluate(tab.sessionId, 'startGet(), true');
        if (!(await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .primary')))) { check(false, `#537 (${v.name}): kein Passkey-Schild für die Hello-Leiste`); continue; }
        await sleep(2600); // the tag drops in and swings
        await clickNode(tab.sessionId, '.kvtag .primary');
        const frameNode = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag iframe.pinframe:not([hidden])'));
        const pinUrl = await evaluate(workerSession, 'chrome.runtime.getURL("pin/pin.html")');
        const target = frameNode && await waitFor(async () => (await findTarget(`${pinUrl}#`)) || findTarget(`${ext}/pin/pin.html#`));
        if (!frameNode || !target) { check(false, `#537 (${v.name}): Leiste klappt nicht auf`); continue; }
        const frame = await attach(target.targetId);
        if (v.dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, frame).catch(() => {});
        if (!(await waitFor(() => evaluate(frame, '!!document.querySelector("button.hello") && !!document.querySelector("input.pin")')))) { check(false, `#537 (${v.name}): Leiste ohne Hello-Knopf oder Feld`); continue; }
        const pinsBefore = await evaluate(workerSession, 'globalThis.__kvApp.pins.length');
        if (v.auto) check(await evaluate(frame, 'document.querySelector("input.pin").hidden === true'), '#537: Feld in der Leiste sichtbar, bevor Windows Hello gefragt wurde');
        const shown = await waitFor(() => evaluate(frame, '!document.querySelector("input.pin").hidden'), 9000);
        check(shown, `#537 (${v.name}): das Feld für Masterpasswort oder PIN erscheint nicht`);
        const asks = JSON.parse(await evaluate(workerSession, `JSON.stringify(globalThis.__kvApp.pins.slice(${pinsBefore}))`));
        if (v.auto) {
          check(asks.length === 1 && asks[0]?.hello === true, `#537: Windows Hello in der Leiste nicht genau einmal von selbst angefragt (${JSON.stringify(asks)})`);
          check(await waitFor(() => evaluate(frame, 'document.activeElement === document.querySelector("input.pin")'), 2000), '#537: nach dem Abbruch hat das Feld der Leiste nicht den Fokus (Lena 2)');
          await sleep(1500);
          check((await evaluate(workerSession, 'globalThis.__kvApp.pins.length')) === pinsBefore + 1, '#537: zweiter automatischer Start in der Leiste');
        } else {
          await sleep(1500);
          check((await evaluate(workerSession, 'globalThis.__kvApp.pins.length')) === pinsBefore, `#537 (${v.name}): Windows Hello startete für dieselbe Seite innerhalb von 60 s erneut von selbst`);
        }
        await sleep(600); // the frame reports its height, the tag applies it
        const box = JSON.parse(await evaluate(frame, `JSON.stringify((() => {
          const inside = (el) => { if (!el || el.hidden) return true; const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; };
          const all = ['button.hello', '.hello-or', 'label', 'input.pin', '.problem', '.busy'].map((q) => document.querySelector(q));
          const b = document.querySelector('button.hello');
          return { inside: all.every(inside), first: document.querySelector('#main').firstElementChild === b, text: b.textContent.trim(), radius: getComputedStyle(b).borderRadius,
            height: innerHeight, content: Math.ceil(document.querySelector('#main').getBoundingClientRect().height), lang: document.documentElement.lang };
        })())`));
        check(box.inside, `#537 (${v.name}): etwas in der Leiste abgeschnitten (${JSON.stringify(box)})`);
        check(box.height >= box.content && box.height - box.content < 40, `#537 (${v.name}): die Leiste nimmt nicht die gemeldete Höhe (${JSON.stringify(box)})`);
        check(box.first && (v.en ? /Windows Hello/.test(box.text) && box.lang === 'en' : /Windows Hello/.test(box.text)), `#537 (${v.name}): Hello nicht zuerst oder falsche Sprache (${JSON.stringify(box)})`);
        check(box.radius === '10px', `#537 (${v.name}): Hello-Knopf ohne den Stil der Leiste (${box.radius})`);
        await evaluate(frame, 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true').catch(() => {});
      } finally {
        await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      }
    }
  } finally {
    await evaluate(workerSession, 'chrome.storage.local.get("settings").then(({ settings = {} }) => chrome.storage.local.set({ settings: { ...settings, language: "de" } })).then(() => true)').catch(() => {});
    await evaluate(workerSession, `(() => { const app = globalThis.__kvApp; if (!app) return false; app.answers.snapshot = { ...app.answers.snapshot, passkeyPin: { required: true, pinSet: true } }; for (const fn of app.listeners) fn({ event: 'changed' }); return true; })()`).catch(() => {});
  }
  return undefined;
}
