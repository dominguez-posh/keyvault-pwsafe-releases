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
