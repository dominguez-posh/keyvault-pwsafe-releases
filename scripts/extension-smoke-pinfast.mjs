// Extension smoke, part (#534): with the app locked and a PIN set last time, the popup's PIN field is on the page and
// focused right away, before the app has answered (the fresh state comes 1.2 s late here, like a native port that is
// still starting). A PIN sent meanwhile is held and goes to the app only after the fresh state; an app that turns out
// not to be running gets the clear message instead of the field, and no PIN. Runs inside the #508 part, against its
// imitated, locked app (wrong PIN answers "Falsche PIN" after 1.5 s).

export const PIN_FIELD_MS = 150;

/** In this popup page only: the fresh "state" answer comes late; offline: and says the app is not running. */
const lateState = (offline) => `(() => {
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (m, ...rest) => (m?.cmd === 'state'
    ? new Promise((r) => setTimeout(r, 1200)).then(() => send(m, ...rest)).then((res) => (${offline}
      ? { ...res, result: { ...res.result, open: false, desktop: { connected: false, reason: 'AppOffline' } } } : res))
    : send(m, ...rest));
})()`;

const pinView = `JSON.stringify((() => {
  const input = document.querySelector('#view input[type=password]');
  const button = document.querySelector('#view .btn.primary');
  return { input: !!input, focused: !!input && document.activeElement === input, value: input?.value || '', button: button?.textContent.trim() || '',
    error: document.querySelector('#view .notice.error')?.textContent || '', offline: document.querySelector('#view h2')?.textContent || '',
    state: window.kvLoadTimes?.state ?? null, mark: window.kvMarks?.pin ?? null };
})())`;

async function openLate({ send, ext, offline }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: lateState(offline) }, sessionId);
  await send('Page.navigate', { url: `${ext}/popup/popup.html` }, sessionId);
  return { targetId, sessionId };
}

const typeAndSend = (pin) => `(() => {
  const input = document.querySelector('#view input[type=password]');
  input.value = ${JSON.stringify(pin)};
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`;

export async function checkPinAtOnce({ send, evaluate, waitFor, check, sleep, ext, workerSession }) {
  const pins = async () => JSON.parse((await evaluate(workerSession, 'JSON.stringify(globalThis.__kvApp.unlockPins)')) || '[]');
  // 1. The field at once, focused; a PIN sent before the fresh state is held, then goes to the app exactly once.
  let page = await openLate({ send, ext, offline: false });
  const read = async () => JSON.parse((await evaluate(page.sessionId, pinView)) || '{}');
  try {
    check(await waitFor(async () => (await read()).focused, 3000), `#534: PIN-Feld erscheint nicht fokussiert vor der App-Antwort (${JSON.stringify(await read())})`);
    let v = await read();
    console.log(`PIN sofort (#534): PIN-Feld sichtbar und fokussiert nach ${v.mark} ms (Grenze ${PIN_FIELD_MS} ms)`);
    check(v.mark != null && v.mark < PIN_FIELD_MS && v.state === null, `#534: PIN-Feld nach ${v.mark} ms (Grenze ${PIN_FIELD_MS} ms, vor der App-Antwort: ${v.state === null})`);
    await evaluate(page.sessionId, typeAndSend('2468'));
    await sleep(300);
    v = await read();
    check(v.value === '2468' && /Verbinde mit Keevault/.test(v.button) && v.state === null, `#534: gesendete PIN vor der Bestätigung nicht gehalten (${JSON.stringify(v)})`);
    check((await pins()).length === 0, `#534: PIN ging vor der bestätigten Verbindung an die App (${JSON.stringify(await pins())})`);
    check(await waitFor(async () => /Falsche PIN/.test((await read()).error), 6000), `#534: gehaltene PIN nach der Bestätigung nicht geprüft (${JSON.stringify(await read())})`);
    check(JSON.stringify(await pins()) === '["2468"]', `#534: App bekam ${JSON.stringify(await pins())} statt einmal die gehaltene PIN`);
  } finally {
    await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
  // 2. The app turns out not to be running: the message instead of the field, and the held PIN is not sent.
  await evaluate(workerSession, '(globalThis.__kvApp.unlockPins = [], true)');
  page = await openLate({ send, ext, offline: true });
  try {
    check(await waitFor(async () => (await read()).input, 3000), '#534: PIN-Feld fehlt vor der App-Antwort (offline)');
    await evaluate(page.sessionId, typeAndSend('9999'));
    check(await waitFor(async () => { const x = await read(); return !x.input && /läuft nicht/.test(x.offline); }, 5000), `#534: App nicht erreichbar, aber keine klare Meldung statt Feld (${JSON.stringify(await read())})`);
    await sleep(200);
    check((await pins()).length === 0, `#534: PIN ging an eine nicht erreichbare App (${JSON.stringify(await pins())})`);
  } finally {
    await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
}
