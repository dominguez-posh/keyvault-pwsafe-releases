// #526: reading the device setup and the extension policies starts about 50 reg.exe (and PowerShell) processes. The
// extension hint asks every 30 s and after every extension event, the settings on every opening, the start once – in a
// smoke run up to seven such reads ran at once and every process start on the machine got slow. Callers that come while
// a read runs get its result instead of starting their own. Nothing is kept after it ends; after a setup step changed
// something, forgetSharedReads() makes the next caller read anew instead of joining a read from before the change.

const all = new Set();

/** read: () => Promise. Returns a function with the same result that runs at most one read at a time. */
export function sharedRead(read) {
  let running = null;
  const shared = () => {
    if (!running) {
      const p = Promise.resolve().then(read).finally(() => { if (running === p) running = null; });
      running = p;
    }
    return running;
  };
  const forget = () => { running = null; };
  all.add(forget);
  return shared;
}

/** After a change to the registry: no caller joins a read that started before it. */
export function forgetSharedReads() {
  for (const forget of all) forget();
}
