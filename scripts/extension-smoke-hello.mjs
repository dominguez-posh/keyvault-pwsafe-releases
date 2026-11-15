// Extension smoke, part (#537 stage 4): unlocking from the popup with Windows Hello. The imitated app (extension-smoke-
// pin.mjs) reports the master password and Hello as on; its unlockRequest stands for the app, which asks the simulated
// Hello: the first request is cancelled, the next one opens. Checked: the button is there, only a real click sends the
// request (a script click does nothing), a cancel comes back as a message, the field asks "Masterpasswort oder PIN".
// Leaves the app locked with a PIN, as the parts after it expect.

const helloApp = `(() => {
  const app = globalThis.__kvApp;
  if (!app) return false;
  app.helloRequests = 0;
  const locked = { version: '0.0.0', opened: false, pinSet: true, passkeyPin: { required: true, pinSet: true, masterPassword: true, hello: true }, containers: [], summaries: [] };
  Object.assign(app.answers, {
    hello: { version: '0.0.0', opened: false, caps: ['unlockRequest'] },
    snapshot: locked,
    unlockRequest: () => {
      app.helloRequests += 1;
      if (app.helloRequests === 1) return Promise.reject(Object.assign(new Error('Windows Hello abgebrochen – bitte das Masterpasswort eingeben'), { name: 'HelloCanceled' }));
      Object.assign(app.answers, {
        hello: { version: '0.0.0', opened: true, caps: ['unlockRequest'] },
        snapshot: { ...locked, opened: true, containers: [{ id: 'c1', name: 'Smoke' }] },
      });
      return Promise.resolve(true);
    },
  });
  for (const fn of app.listeners) fn({ event: 'changed' }); // the extension forgets its snapshot and hello (caps)
  return true;
})()`;

const backToLocked = `(() => {
  const app = globalThis.__kvApp;
  Object.assign(app.answers, {
    hello: { version: '0.0.0', opened: false },
    snapshot: { version: '0.0.0', opened: false, pinSet: true, containers: [], summaries: [] },
  });
  delete app.answers.unlockRequest;
  for (const fn of app.listeners) fn({ event: 'changed' });
  return true;
})()`;

export async function checkPopupHelloUnlock({ send, evaluate, open, waitFor, check, sleep, ext, workerSession }) {
  check(await evaluate(workerSession, helloApp), '#537: Nachbildung der App nicht gefunden');
  const popup = await open(`${ext}/popup/popup.html`);
  const s = popup.sessionId;
  try {
    const shown = await waitFor(() => evaluate(s, '!!document.querySelector("#view .hello-unlock")'));
    check(shown, '#537: Popup zeigt bei eingeschaltetem Windows Hello keinen Knopf „Mit Windows Hello entsperren“');
    if (!shown) return;
    // #537 risk 3 (Lucas: "überall automatisch"): the popup asks Hello by itself, once – the imitated app cancels that
    // first one. Then the message, the field and "Erneut mit Windows Hello"; no second automatic start.
    const cancelled = await waitFor(() => evaluate(s, '/abgebrochen/.test(document.querySelector("#view .notice.error")?.textContent || "") && !!document.querySelector("#view .hello-unlock")'));
    check(cancelled, '#537: Windows Hello startet im Popup nicht von selbst (oder ein Abbruch kommt nicht als Meldung zurück)');
    check((await evaluate(workerSession, 'globalThis.__kvApp.helloRequests')) === 1, '#537: Windows Hello wurde nicht genau einmal von selbst angefragt');
    const field = JSON.parse(await evaluate(s, 'JSON.stringify((() => { const i = document.querySelector("#view input[type=password]"); return { shown: !!i && !i.hidden, placeholder: i?.placeholder || "", again: /Erneut mit Windows Hello/.test(document.querySelector("#view .hello-unlock")?.textContent || "") }; })())'));
    check(field.shown, '#537: nach dem Abbruch fehlt das Feld für Masterpasswort oder PIN');
    check(/Masterpasswort oder PIN/.test(field.placeholder), `#537: Feld fragt nicht nach „Masterpasswort oder PIN“ (${field.placeholder})`);
    check(field.again, '#537: nach dem Abbruch kein „Erneut mit Windows Hello“');
    await sleep(1500);
    check((await evaluate(workerSession, 'globalThis.__kvApp.helloRequests')) === 1, '#537: nach dem Abbruch ein zweiter automatischer Start');
    // A script's click is no gesture: nothing goes to the app.
    await evaluate(s, 'document.querySelector("#view .hello-unlock").click(), true');
    await sleep(400);
    check((await evaluate(workerSession, 'globalThis.__kvApp.helloRequests')) === 1, '#537: ein Klick per Skript hat Windows Hello angefragt');
    const click = async () => {
      const box = JSON.parse(await evaluate(s, 'JSON.stringify((() => { const r = document.querySelector("#view .hello-unlock").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })())'));
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, s);
    };
    await click();
    const opened = await waitFor(() => evaluate(workerSession, 'globalThis.__kvApp.helloRequests === 2 && globalThis.__kvApp.answers.snapshot.opened === true'));
    check(opened, '#537: der echte Klick auf „Erneut mit Windows Hello“ hat nicht entsperrt');
  } finally {
    await evaluate(workerSession, backToLocked).catch(() => {});
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  }
}
