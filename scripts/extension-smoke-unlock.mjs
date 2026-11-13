// Extension smoke, part (#508): unlocking with the app PIN in the popup never looks frozen. Right after the PIN the
// button spins with "Entsperre …", then "Lade Tresore …" until the list is there; the field is locked meanwhile. A wrong
// PIN and no answer in time come back as clear messages. Runs against the imitated, locked app with a PIN of
// extension-smoke-pin.mjs; its unlockPin answers slowly, so the busy state can be seen. Leaves the app open.

import { checkPinAtOnce } from './extension-smoke-pinfast.mjs';

export const UNLOCK_PIN = '1357';

/** The imitated app's unlock: 1.5 s, then a wrong PIN, a timeout (PIN "0000") or open with one vault. */
const slowUnlock = `(() => {
  const app = globalThis.__kvApp;
  if (!app) return false;
  app.unlockPins = [];
  app.answers.unlockPin = ({ pin }) => new Promise((resolve, reject) => setTimeout(() => {
    app.unlockPins.push(pin);
    if (pin === '0000') return reject(Object.assign(new Error('Keevault-App antwortet nicht'), { name: 'TimeoutError' }));
    if (pin !== ${JSON.stringify(UNLOCK_PIN)}) return reject(new Error('Falsche PIN'));
    Object.assign(app.answers, {
      hello: { version: '0.0.0', opened: true },
      snapshot: { version: '0.0.0', opened: true, pinSet: true, containers: [{ id: 'c1', name: 'Smoke' }], summaries: [] },
    });
    return resolve(true);
  }, 1500));
  return true;
})()`;

/** Everything the popup's lock screen shows, read at once. */
const lockView = `JSON.stringify((() => {
  const input = document.querySelector('#view input[type=password]');
  const button = document.querySelector('#view .btn.primary');
  return { input: !!input, inputDisabled: !!input?.disabled, button: button?.textContent.trim() || '', buttonDisabled: !!button?.disabled,
    spinner: !!button?.querySelector('.spinner'), error: document.querySelector('#view .notice.error')?.textContent || '',
    list: !!document.querySelector('#view .tabs') };
})())`;

export async function checkPopupUnlockStatus({ send, evaluate, open, waitFor, check, sleep, ext, workerSession }) {
  check(await evaluate(workerSession, slowUnlock), '#508: Nachbildung der App nicht gefunden');
  // #534: the PIN field at once (the locked popup of the PIN part left "locked with PIN" as the last known state).
  await checkPinAtOnce({ send, evaluate, waitFor, check, sleep, ext, workerSession });
  await evaluate(workerSession, '(globalThis.__kvApp.unlockPins = [], true)');
  const popup = await open(`${ext}/popup/popup.html`);
  const read = async () => JSON.parse((await evaluate(popup.sessionId, lockView)) || '{}');
  const submit = (pin) => evaluate(popup.sessionId, `(() => {
    const input = document.querySelector('#view input[type=password]');
    input.value = ${JSON.stringify(pin)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  try {
    check(await waitFor(async () => (await read()).input), '#508: Popup zeigt kein PIN-Feld (App gesperrt mit PIN)');
    // Every text the popup puts on the page from here on – "Lade Tresore …" may be there for a moment only.
    await evaluate(popup.sessionId, `(() => {
      window.__seen = [];
      new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) window.__seen.push(n.textContent || ''); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    // Wrong PIN: busy while the app checks, then its message, the field free and empty again.
    await submit('1111');
    await sleep(300);
    let v = await read();
    check(v.inputDisabled && v.buttonDisabled && v.spinner && /Entsperre …/.test(v.button), `#508: kein Status „Entsperre …“ nach der PIN (${JSON.stringify(v)})`);
    check(await waitFor(async () => /Falsche PIN/.test((await read()).error)), '#508: falsche PIN ohne Meldung');
    v = await read();
    check(v.input && !v.inputDisabled && !v.buttonDisabled && !v.spinner, `#508: nach falscher PIN bleibt die Eingabe gesperrt (${JSON.stringify(v)})`);
    // No answer in time: says so plainly.
    await submit('0000');
    check(await waitFor(async () => /Zeitüberschreitung/.test((await read()).error)), `#508: Zeitüberschreitung ohne klare Meldung (${(await read()).error})`);
    // Right PIN: "Entsperre …", then "Lade Tresore …", then the list.
    await submit(UNLOCK_PIN);
    await sleep(300);
    v = await read();
    check(v.inputDisabled && v.spinner && /Entsperre …/.test(v.button), `#508: richtige PIN ohne Status (${JSON.stringify(v)})`);
    check(await waitFor(async () => (await read()).list), '#508: nach dem Entsperren erscheint die Liste nicht');
    const seen = JSON.parse((await evaluate(popup.sessionId, 'JSON.stringify(window.__seen)')) || '[]');
    check(seen.some((s) => /Lade Tresore …/.test(s)), '#508: „Lade Tresore …“ nie angezeigt');
    const pins = await evaluate(workerSession, 'JSON.stringify(globalThis.__kvApp.unlockPins)');
    check(pins === JSON.stringify(['1111', '0000', UNLOCK_PIN]), `#508: App bekam andere PINs: ${pins}`);
  } finally {
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  }
}
