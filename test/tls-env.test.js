// #517: TLS verification is never switched off from the environment (NODE_TLS_REJECT_UNAUTHORIZED=0, SSLKEYLOGFILE,
// weakening NODE_OPTIONS). The guard in desktop/tls-env.js is checked on its own, against a real server with a
// self-signed certificate in a child process, and in its place: main.js imports it first, the generated helper
// scripts remove the variables too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { neutralizeTlsEnv, tlsEnvLogLine } from '../desktop/tls-env.js';
import { hostScript } from '../desktop/bridge.js';
import { mcpHostScript } from '../desktop/mcp.js';
import { selfSignedCert } from '../desktop/smoke-self-signed-cert.js';

const guard = pathToFileURL(fileURLToPath(new URL('../desktop/tls-env.js', import.meta.url))).href;

test('neutralizeTlsEnv: removes the switches, keeps extra CA certificates, reports names only', () => {
  const env = {
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    SSLKEYLOGFILE: 'C:\\Users\\x\\keys.log',
    NODE_OPTIONS: '--max-old-space-size=4096 --tls-keylog C:\\keys.log --tls-min-v1.0 --use-openssl-ca --openssl-config="C:\\a b\\o.cnf" --trace-warnings',
    NODE_EXTRA_CA_CERTS: 'C:\\corp\\proxy-ca.pem',
    PATH: 'C:\\Windows',
  };
  const found = neutralizeTlsEnv(env);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.SSLKEYLOGFILE, undefined);
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096 --trace-warnings');
  assert.equal(env.NODE_EXTRA_CA_CERTS, 'C:\\corp\\proxy-ca.pem');
  assert.equal(env.PATH, 'C:\\Windows');
  assert.deepEqual(found.removed, ['NODE_TLS_REJECT_UNAUTHORIZED', 'SSLKEYLOGFILE']);
  assert.deepEqual(found.nodeOptions, ['--tls-keylog', '--tls-min-v1.0', '--use-openssl-ca', '--openssl-config']);
  assert.deepEqual(found.kept, ['NODE_EXTRA_CA_CERTS']);
  assert.deepEqual(found.warn, ['NODE_TLS_REJECT_UNAUTHORIZED=0', 'SSLKEYLOGFILE', 'NODE_OPTIONS --tls-keylog --tls-min-v1.0 --use-openssl-ca --openssl-config']);
  const line = tlsEnvLogLine(found);
  assert.match(line, /^TLS-ENV removed NODE_TLS_REJECT_UNAUTHORIZED, SSLKEYLOGFILE; NODE_OPTIONS without .*; kept NODE_EXTRA_CA_CERTS/);
  for (const value of ['keys.log', 'proxy-ca', 'o.cnf', 'C:\\']) assert.ok(!line.includes(value), `log line shows a value: ${value}`);
});

test('neutralizeTlsEnv: a value other than "0" is removed without a warning; a clean environment stays as it is', () => {
  const env = { NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_OPTIONS: '--max-old-space-size=4096' };
  const found = neutralizeTlsEnv(env);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.deepEqual(found.warn, []);
  const clean = { PATH: 'x' };
  const none = neutralizeTlsEnv(clean);
  assert.deepEqual(clean, { PATH: 'x' });
  assert.equal(tlsEnvLogLine(none), '');
  const onlyTls = { NODE_OPTIONS: '--tls-keylog=k.log' };
  neutralizeTlsEnv(onlyTls);
  assert.equal('NODE_OPTIONS' in onlyTls, false);
});

/** A child Node process with NODE_TLS_REJECT_UNAUTHORIZED=0 requests url with fetch and https; prints what happened. */
function childRequest(url, { withGuard }) {
  const code = `${withGuard ? `await import(${JSON.stringify(guard)});` : ''}
    import('node:https').then(async ({ default: https }) => {
      const out = {};
      try { out.fetch = 'accepted ' + (await fetch(${JSON.stringify(url)})).status; } catch (e) { out.fetch = 'refused ' + (e.cause?.code || e.message); }
      out.https = await new Promise((resolve) => https.get(${JSON.stringify(url)}, (r) => { r.resume(); resolve('accepted ' + r.statusCode); }).on('error', (e) => resolve('refused ' + e.code)));
      out.env = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? 'removed';
      console.log(JSON.stringify(out));
    });`;
  const env = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
}

test('with NODE_TLS_REJECT_UNAUTHORIZED=0 a self-signed certificate is refused once the guard ran (fetch and https)', async (t) => {
  const { key, cert } = selfSignedCert();
  const server = https.createServer({ key, cert }, (_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `https://localhost:${server.address().port}/`;

  // Without the guard the variable is in effect: proves the test can see the hole at all.
  const open = await childRequest(url, { withGuard: false });
  assert.deepEqual(open, { fetch: 'accepted 200', https: 'accepted 200', env: '0' });

  const guarded = await childRequest(url, { withGuard: true });
  assert.equal(guarded.env, 'removed');
  assert.match(guarded.fetch, /^refused (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/, `fetch: ${guarded.fetch}`);
  assert.match(guarded.https, /^refused (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/, `https: ${guarded.https}`);
});

test('main.js imports the guard before any other module', () => {
  const src = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const first = src.match(/^import\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/m);
  assert.ok(first, 'main.js has no import');
  assert.equal(first[1] || first[2], './tls-env.js', 'the first import of main.js must be ./tls-env.js (#517)');
});

test('the generated native host and MCP scripts remove the TLS switches too', () => {
  for (const [name, script] of [['host.cjs', hostScript('\\\\.\\pipe\\x')], ['keevault-mcp.cjs', mcpHostScript('\\\\.\\pipe\\x', '0.0.0')]]) {
    for (const v of ['NODE_TLS_REJECT_UNAUTHORIZED', 'SSLKEYLOGFILE']) {
      const at = script.indexOf(`delete process.env.${v};`);
      assert.ok(at > 0, `${name} does not remove ${v}`);
      assert.ok(at < script.indexOf('require('), `${name} removes ${v} only after its first require`);
    }
  }
});
