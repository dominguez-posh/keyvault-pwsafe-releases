// Extension smoke, part: a locked app with a PIN never asks for it in the page (#409): the page reads keystrokes and a stray
// Enter would count as a wrong PIN. The extension's own window asks instead. The developer demo has no app and no PIN, and
// the old path was closed to it, so this runs without the demo against an imitated app. It must run before the demo starts:
// the worker's restart for the demo removes the imitation.

/** What the service worker gets instead of the native port: an app that runs, is locked and has a PIN. */
export const lockedAppWithPin = `(() => {
  chrome.runtime.connectNative = () => {
    const listeners = [];
    const answers = {
      hello: { version: '0.0.0', opened: false },
      snapshot: { version: '0.0.0', opened: false, pinSet: true, containers: [], summaries: [] },
    };
    return {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: ({ id, cmd }) => setTimeout(() => {
        const known = cmd in answers;
        for (const fn of listeners) fn(known ? { id, ok: true, result: answers[cmd] } : { id, ok: false, error: { message: 'Unknown command' } });
      }, 0),
    };
  };
  return true;
})()`;

export async function checkNoPinInPage({ send, evaluate, attach, open, shadowNode, waitFor, findTarget, check, ext, origin, workerSession }) {
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
}
