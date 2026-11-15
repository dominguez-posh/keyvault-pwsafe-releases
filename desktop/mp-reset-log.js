// #537 stage 6: the log of master password resets with the recovery stick, kept in the personal vault (inside its
// encrypted app settings, so under the vault key and re-encrypted by every key change). Each device shows every entry
// once ("Masterpasswort wurde am … per Stick zurückgesetzt"); what it has shown is noted on the device only. No Electron.

export const MAX_RESETS = 10;
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const valid = (r) => !!r && typeof r === 'object' && text(r.at, 40) && !Number.isNaN(Date.parse(r.at)) && text(r.device || '', 100) && (r.kv === undefined || Number.isInteger(r.kv));

/** The entries of the log in the app settings value (only valid ones, oldest first). */
export const resetsOf = (value) => (Array.isArray(value?.mpResets) ? value.mpResets.filter(valid) : []);

/** The app settings value with one more entry (at most MAX_RESETS kept); everything else in it stays as it is. */
export function withReset(value, { at = new Date().toISOString(), device = '', kv } = {}) {
  const entry = { at, device: text(device, 100) ? device : '', ...(Number.isInteger(kv) ? { kv } : {}) };
  return { ...(value && typeof value === 'object' ? value : {}), mpResets: [...resetsOf(value), entry].slice(-MAX_RESETS) };
}

/** The entries this device has not shown yet. seen: the `at` values shown here. */
export function unseenResets(value, seen = []) {
  const known = new Set(Array.isArray(seen) ? seen : []);
  return resetsOf(value).filter((r) => !known.has(r.at));
}
