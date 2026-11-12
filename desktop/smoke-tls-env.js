// Smoke check (#517): TLS verification is never switched off from the environment. scripts/start.mjs starts the smoke
// run with NODE_TLS_REJECT_UNAUTHORIZED=0 and SSLKEYLOGFILE (path in KVPWSAFE_SMOKE_KEYLOG). Here, in the running app:
// both variables are gone from the main process, a server with a self-signed certificate is refused by Node's fetch
// and https and by Chromium's network (secureFetch), Chromium wrote no TLS keys, the diagnostics log names the removed
// variables without values, and the window showed its one-time warning. Part of the feature checks (smoke-features.js).

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { secureFetch } from './secure-net.js';
import { selfSignedCert } from './smoke-self-signed-cert.js';
import { until } from './smoke-wait.js';

const outcome = (p) => p.then((r) => `accepted ${r.status}`, (e) => `refused ${e.cause?.code || e.code || e.message}`);

export async function tlsEnvCheck({ js, api, fail }) {
  const keylog = process.env.KVPWSAFE_SMOKE_KEYLOG;
  if (!keylog) fail('the smoke run was started without NODE_TLS_REJECT_UNAUTHORIZED=0 / SSLKEYLOGFILE (scripts/start.mjs)');
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'SSLKEYLOGFILE']) {
    if (process.env[name] !== undefined) fail(`${name} is still set in the main process`);
  }
  const { key, cert } = selfSignedCert();
  const server = https.createServer({ key, cert }, (_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `https://localhost:${server.address().port}/`;
    const results = {
      'Node fetch': await outcome(fetch(url)),
      'Node https': await outcome(new Promise((resolve, reject) => https.get(url, (r) => { r.resume(); resolve({ status: r.statusCode }); }).on('error', reject))),
      secureFetch: await outcome(secureFetch(url)),
    };
    for (const [what, result] of Object.entries(results)) if (!result.startsWith('refused')) fail(`${what} accepted a self-signed certificate (${result})`);
  } finally {
    server.close();
  }
  if (keylog && fs.existsSync(keylog) && fs.statSync(keylog).size > 0) fail('Chromium wrote TLS session keys to SSLKEYLOGFILE');

  const warn = (await api.state()).tlsEnvWarning || [];
  if (!warn.includes('NODE_TLS_REJECT_UNAUTHORIZED=0') || !warn.includes('SSLKEYLOGFILE')) fail(`state.tlsEnvWarning: ${JSON.stringify(warn)}`);
  if (!(await until(() => js('document.body.dataset.tlsEnvWarned === "1"'), 3000))) fail('the window did not show the TLS warning');

  const logFile = path.join(app.getPath('userData'), 'diagnostics.log');
  const line = await until(() => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.includes('TLS-ENV')) || '' : ''), 3000);
  if (!line || !/removed NODE_TLS_REJECT_UNAUTHORIZED, SSLKEYLOGFILE/.test(line)) fail(`diagnostics.log lacks the TLS-ENV line (${line || 'none'})`);
  else if (keylog && line.includes(path.basename(keylog))) fail('the TLS-ENV log line shows a value');
}
