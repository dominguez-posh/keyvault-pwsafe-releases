// Version order of the updater (no Electron here, so unit tests can load it).

/**
 * Compares versions like semver: "1.2.10" > "1.2.9", and a pre-release below its release ("1.0.0-beta.2" < "1.0.0",
 * "1.0.0-beta.2" > "1.0.0-beta.1").
 */
export function compareVersions(a, b) {
  const split = (v) => { const [core, ...pre] = String(v).split('-'); return [core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre.join('-')]; };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) if ((ca[i] || 0) !== (cb[i] || 0)) return (ca[i] || 0) > (cb[i] || 0) ? 1 : -1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const xa = pa.split('.');
  const xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) > Number(xb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    if (!na && xa[i] !== xb[i]) return xa[i] > xb[i] ? 1 : -1;
  }
  return 0;
}

// A version a client (browser extension) reports about itself. It is a claim, never proof: it only decides whether a
// hint is shown, never an approval or a check, and nothing falls back to older behaviour because of it.
const CLIENT_VERSION = /^\d+(\.\d+){0,3}$/;

/** The reported version if it has the plain numeric form (at most 32 characters), else null. */
export function parseClientVersion(value) {
  return typeof value === 'string' && value.length <= 32 && CLIENT_VERSION.test(value) ? value : null;
}

// First extension that asks the app to sign passkeys (#439; before: copy through the app, #337).
export const MIN_EXTENSION_VERSION = '0.9.29';

/** True when the extension did not report a usable version or reports one below the protected-copy version. */
export const extensionOutdated = (reported) => {
  const v = parseClientVersion(reported);
  return !v || compareVersions(v, MIN_EXTENSION_VERSION) < 0;
};

/**
 * #454: what the app knows about the browser extension, from the clients of the bridge (their version claims are
 * hints only). `clients`: [{ approved, origin, extVersion, minApp }]. State by priority: 'extensionOutdated' (an
 * extension below MIN_EXTENSION_VERSION), 'appOutdated' (an extension that needs a newer app), 'ok', or 'noConnection'
 * (nothing reported – "not installed" cannot be told from "browser closed").
 */
export function extensionStatus(clients, appVersion) {
  const browsers = clients.filter((c) => c.approved && !String(c.origin || '').startsWith('mcp:'));
  const base = { state: 'noConnection', minExtension: MIN_EXTENSION_VERSION, appVersion };
  if (!browsers.length) return base;
  const old = browsers.find((c) => extensionOutdated(c.extVersion));
  if (old) return { ...base, state: 'extensionOutdated', extVersion: old.extVersion || '' };
  const need = browsers.find((c) => c.minApp && compareVersions(appVersion, c.minApp) < 0);
  if (need) return { ...base, state: 'appOutdated', extVersion: need.extVersion || '', minApp: need.minApp };
  return { ...base, state: 'ok', extVersion: browsers[0].extVersion || '' };
}
