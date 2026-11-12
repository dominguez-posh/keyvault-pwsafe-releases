// Extension smoke, part: a locked app with a PIN never asks for it in the page (#409): the page reads keystrokes and a stray
// Enter would count as a wrong PIN. The extension's own window asks instead. The developer demo has no app and no PIN, and
// the old path was closed to it, so this runs without the demo against an imitated app. It must run before the demo starts:
// the worker's restart for the demo removes the imitation.

import { checkPinInBar } from './extension-smoke-pinbar.mjs';
import { checkWarmStart } from './extension-smoke-warm.mjs';
import { checkPopupUnlockStatus } from './extension-smoke-unlock.mjs';
import { checkStartButtonCentred, checkButtonCentred } from './extension-smoke-center.mjs';

/**
 * What the service worker gets instead of the native port: an app that runs, is locked and has a PIN. Kept in
 * globalThis.__kvApp, so later checks can change its answers (a function answer gets the request's arguments).
 */
export const lockedAppWithPin = `(() => {
  chrome.runtime.connectNative = () => {
    const listeners = [];
    const answers = {
      hello: { version: '0.0.0', opened: false },
      snapshot: { version: '0.0.0', opened: false, pinSet: true, containers: [], summaries: [] },
    };
    const disconnect = []; // #505: the warm-start part ends this port like a lost host
    globalThis.__kvApp = { answers, listeners, disconnect };
    return {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnect.push(fn) },
      // A function answer may take its time (a Promise, #508); an error keeps its name (TimeoutError).
      postMessage: ({ id, cmd, ...args }) => setTimeout(async () => {
        let reply = { id, ok: false, error: { message: 'Unknown command' } };
        if (cmd in answers) {
          try {
            reply = { id, ok: true, result: typeof answers[cmd] === 'function' ? await answers[cmd](args) : answers[cmd] };
          } catch (e) {
            reply = { id, ok: false, error: { message: e.message, name: e.name } };
          }
        }
        for (const fn of listeners) fn(reply);
      }, 0),
    };
  };
  return true;
})()`;

export async function checkNoPinInPage({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession, settle }) {
  // #506: first the app that is not running ("Keevault starten" centred), then the locked one ("Entsperren" centred).
  await checkStartButtonCentred({ send, evaluate, open, waitFor, check, ext, workerSession });
  await evaluate(workerSession, lockedAppWithPin);
  // The first attempt found no native host; the client tries again after 2 s.
  await new Promise((r) => setTimeout(r, 2200));
  const locked = await open(`${ext}/popup/popup.html`);
  check(await waitFor(() => evaluate(locked.sessionId, '!!document.querySelector("#view input[type=password]") && !!document.querySelector("#view .btn.primary")')), '#506: Popup zeigt bei gesperrter App kein PIN-Feld mit „Entsperren“');
  await checkButtonCentred({ evaluate, check, sessionId: locked.sessionId, selector: '#view .btn.primary', what: 'Entsperren' });
  await send('Target.closeTarget', { targetId: locked.targetId }).catch(() => {});
  const tab = await open(`${origin}/`);
  await evaluate(tab.sessionId, 'startGet(), true');
  const prompt = await waitFor(() => findTarget(`${ext}/prompt/prompt.html#get:`));
  check(prompt, 'App gesperrt mit PIN: Erweiterungsfenster wurde nicht angefordert');
  check(!(await shadowNode(tab.sessionId, 'kvpwsafe-ui', 'input')), 'App gesperrt mit PIN: Eingabefeld im Schild auf der Seite');
  if (prompt) {
    // The imitation really took effect, or the checks above would say nothing: the window knows about the PIN.
    const session = await attach(prompt.targetId);
    check(await waitFor(() => evaluate(session, '!!document.querySelector("input.pin")')), 'App gesperrt mit PIN: Erweiterungsfenster fragt nicht nach der PIN');
    await send('Target.closeTarget', { targetId: prompt.targetId }).catch(() => {});
  }
  await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  // #508: the popup unlocks the same app with the PIN and says what is going on (leaves the app open).
  await checkPopupUnlockStatus({ send, evaluate, open, waitFor, check, sleep, ext, workerSession });
  // #465: the same imitated app, now open – the PIN in the Keevault tag at the top of the page.
  await checkPinInBar({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession, settle });
  // #505: warm start – a lost host comes back by itself, and the popup list is there at once.
  await checkWarmStart({ send, evaluate, open, waitFor, check, sleep, ext, workerSession });
}
