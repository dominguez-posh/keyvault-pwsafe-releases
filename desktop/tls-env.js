// #517: TLS verification is never switched off from the environment. NODE_TLS_REJECT_UNAUTHORIZED=0 makes Node accept
// any certificate – for every TLS connection Node itself opens (https, the global fetch/undici). Keevault's own traffic
// to Entra ID, Key Vault, Resource Manager, Graph and the update feed goes over Chromium's network stack (secure-net.js,
// electron-updater's net.request), which ignores the variable; this guard covers everything that uses Node's TLS now or
// later (dependencies, helpers) and the processes Keevault starts, which inherit process.env.
//
// Node reads NODE_TLS_REJECT_UNAUTHORIZED again for every new TLS connection, so removing it here is enough – as long as
// it happens before the first connection. main.js imports this file first (ES modules run in import order), and the
// variable is removed while the import runs. test/tls-env.test.js checks both: a request to a server with a self-signed
// certificate fails with the variable set, and main.js imports this file before anything else.
//
// SSLKEYLOGFILE makes Chromium write the TLS session keys of every connection into a file – Keevault's own traffic
// included (checked with Electron 45 for #517). Chromium reads it when its network service starts, after this import.
//
// No Electron here: the unit test runs it in plain Node.

/** NODE_OPTIONS switches that weaken TLS or reveal its keys (--tls-keylog, --tls-min-v1.0, other CA stores …). */
const WEAK_OPTION = /^--(tls-|use-openssl-ca$|openssl-|insecure-http-parser$)/;
/** Of those, the ones that take a value – written "--tls-keylog file" the value is the next word. */
const TAKES_VALUE = /^--(tls-keylog|tls-cipher-list|openssl-config)$/;

/** NODE_OPTIONS split like Node does: spaces separate, double quotes keep spaces together. */
function words(value) {
  return String(value).match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*"?)+/g) || [];
}

/**
 * Removes what switches TLS verification off from env (process.env by default) and says what it found. Never values:
 * only names, so the result may go into the diagnostics log.
 * @returns {{ warn: string[], removed: string[], nodeOptions: string[], kept: string[] }}
 *   warn: what really weakened TLS (the user is told once); removed: variables taken out;
 *   nodeOptions: switches taken out of NODE_OPTIONS; kept: legitimate CA settings left alone but worth a log line.
 */
export function neutralizeTlsEnv(env = process.env) {
  const found = { warn: [], removed: [], nodeOptions: [], kept: [] };
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
    // Node switches off only on exactly "0" – any other value is removed too, so nothing is left to change later.
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') found.warn.push('NODE_TLS_REJECT_UNAUTHORIZED=0');
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    found.removed.push('NODE_TLS_REJECT_UNAUTHORIZED');
  }
  // TLS session keys into a file: anyone reading it decrypts recorded traffic (Chromium reads it).
  if (env.SSLKEYLOGFILE !== undefined) {
    delete env.SSLKEYLOGFILE;
    found.warn.push('SSLKEYLOGFILE');
    found.removed.push('SSLKEYLOGFILE');
  }
  // NODE_OPTIONS is read once at process start (and not at all by the installed app: Electron fuse, after-pack.cjs);
  // what is taken out here keeps it from processes Keevault starts.
  if (env.NODE_OPTIONS) {
    const keep = [];
    const list = words(env.NODE_OPTIONS);
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const name = w.split('=')[0];
      if (!WEAK_OPTION.test(name)) {
        keep.push(w);
        continue;
      }
      found.nodeOptions.push(name);
      if (!w.includes('=') && TAKES_VALUE.test(name) && i + 1 < list.length && !list[i + 1].startsWith('--')) i++;
    }
    if (found.nodeOptions.length) {
      found.warn.push(`NODE_OPTIONS ${found.nodeOptions.join(' ')}`);
      if (keep.length) env.NODE_OPTIONS = keep.join(' ');
      else delete env.NODE_OPTIONS;
    }
  }
  // Extra CA certificates (company proxies) are legitimate: kept, only named in the log.
  for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (env[name]) found.kept.push(name);
  return found;
}

/** One line for the diagnostics log, or '' when the environment was clean. Names only, never values or paths. */
export function tlsEnvLogLine(found) {
  const parts = [];
  if (found.removed.length) parts.push(`removed ${found.removed.join(', ')}`);
  if (found.nodeOptions.length) parts.push(`NODE_OPTIONS without ${found.nodeOptions.join(', ')}`);
  if (found.kept.length) parts.push(`kept ${found.kept.join(', ')} (extra CA certificates)`);
  if (!parts.length) return '';
  const ignored = found.removed.length || found.nodeOptions.length ? ' – Umgebung änderte die TLS-Prüfung, ignoriert' : '';
  return `TLS-ENV ${parts.join('; ')}${ignored}`;
}

/** What this process found at its start – removed before any other module of the main process ran. */
export const tlsEnvAtStart = neutralizeTlsEnv(process.env);
