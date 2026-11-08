// Extension smoke, part: a locked app with a PIN never asks for it in the page (#409): the page reads keystrokes and a stray
// Enter would count as a wrong PIN. The extension's own window asks instead. The developer demo has no app and no PIN, and
// the old path was closed to it, so this runs without the demo against an imitated app. It must run before the demo starts:
// the worker's restart for the demo removes the imitation.

import { checkPinInBar } from './extension-smoke-pinbar.mjs';

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
    globalThis.__kvApp = { answers, listeners };
    return {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: ({ id, cmd, ...args }) => setTimeout(() => {
        let reply = { id, ok: false, error: { message: 'Unknown command' } };
        if (cmd in answers) {
          try {
            reply = { id, ok: true, result: typeof answers[cmd] === 'function' ? answers[cmd](args) : answers[cmd] };
          } catch (e) {
            reply = { id, ok: false, error: { message: e.message } };
          }
        }
        for (const fn of listeners) fn(reply);
      }, 0),
    };
  };
  return true;
})()`;

export async function checkNoPinInPage({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession, settle }) {
  await evaluate(workerSession, lockedAppWithPin);
  // The first attempt found no native host; the client tries again after 2 s.
  await new Promise((r) => setTimeout(r, 2200));
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
  // #465: the same imitated app, now open – the PIN in the Keevault tag at the top of the page.
  await checkPinInBar({ send, evaluate, attach, open, shadowNode, clickNode, waitFor, findTarget, check, sleep, ext, origin, workerSession, settle });
}
