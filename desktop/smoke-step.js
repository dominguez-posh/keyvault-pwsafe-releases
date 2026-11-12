// One area of the feature smoke (desktop/smoke-features.js, #529). An area that hits its limit used to go on running
// in the background: its clicks, copies and waits mixed into the next areas and made them fail too (#526, a cascade
// of timeouts after features/clipboard). Now the area is cancelled at its limit: its next sleep() or js() call throws,
// and the run waits for it to end (at most `graceMs`) before the next area starts.
// No Electron here: the unit test drives it.

import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage();

export class AreaCancelled extends Error {
  constructor() { super('area cancelled after its time limit'); this.name = 'AreaCancelled'; }
}

/** fn (sleep, js, …) that throws when the area calling it was cancelled – before and after the call. */
export const stopsWhenCancelled = (fn) => async (...args) => {
  if (current.getStore()?.cancelled) throw new AreaCancelled();
  const result = await fn(...args);
  if (current.getStore()?.cancelled) throw new AreaCancelled();
  return result;
};

/**
 * Runs fn as one area. Rejects with the area's own error, or with "timeout after N s" when it hit `limitMs` – then
 * only after the area has ended or `graceMs` more have passed (said in the message).
 */
export async function runArea(fn, { limitMs = 45_000, graceMs = 20_000 } = {}) {
  const area = { cancelled: false };
  const run = current.run(area, () => Promise.resolve().then(fn));
  const ended = run.then(() => true, () => true);
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(false), limitMs); });
  const inTime = await Promise.race([ended, limit]);
  clearTimeout(timer);
  if (inTime) return run;
  area.cancelled = true;
  const grace = new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); });
  const stopped = await Promise.race([ended, grace]);
  clearTimeout(timer);
  throw new Error(`timeout after ${limitMs / 1000} s${stopped ? '' : ` (still running ${graceMs / 1000} s later, left behind)`}`);
}
