// A copy that has to arrive in time. Waiting ends after `ms`, the copy itself may still arrive later: the caller has told
// the user it failed by then, so a late arrival must not stay on the clipboard (#374). No Electron here: a test runs it.

/**
 * #349: seconds until a copied value is cleared. 0 (never) stays 0; `atLeast` lengthens a short setting where the
 * value is needed only after a slow step – remote desktop under Credential Guard: the password is copied before mstsc
 * starts, and its dialog is ready only once the connection is set up.
 */
export function clearAfterSeconds(configured, atLeast = 0) {
  const seconds = Number(configured) || 0;
  return seconds > 0 ? Math.max(seconds, Number(atLeast) || 0) : 0;
}

/** True when copy() succeeded within ms. A success after that calls onLate instead. */
export async function copyInTime(copy, ms, onLate) {
  let late = false;
  const copied = Promise.resolve().then(copy).then(() => {
    if (late) onLate();
    return true;
  }, () => false);
  let timer;
  const ok = await Promise.race([copied, new Promise((r) => { timer = setTimeout(() => { late = true; r(false); }, ms); })]);
  clearTimeout(timer);
  return ok;
}
