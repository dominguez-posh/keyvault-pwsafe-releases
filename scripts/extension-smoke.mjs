// End-to-end test of the browser extension in headless Edge/Chrome (DevTools protocol over a pipe), using the
// developer demo backend (no Azure): pages and service worker load, passkey registration and sign-in through
// the prompt window are verified with an independent relying-party library, extra protection with master
// password and browser passkey (virtual authenticator), import of the sample CSV, English UI.
// Usage: node scripts/extension-smoke.mjs [--browser=<path>] [--out=<dir for screenshots>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const extensionPath = fileURLToPath(new URL('../extension', import.meta.url));
const browser = arg('browser') || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
].find(existsSync);
if (!browser) throw new Error('Kein Edge/Chrome gefunden (--browser=<pfad>)');
const out = arg('out');
const profile = mkdtempSync(join(tmpdir(), 'kvpwsafe-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const page = `<!doctype html><title>WebAuthn test</title><body><form><input autocomplete="username"><input type="password"></form>
<script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
window.results = { patched: navigator.credentials.__kvpwsafe === true };
PublicKeyCredential.isConditionalMediationAvailable().then((v) => { results.conditional = v; });
window.startCreate = () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  results.createChallenge = b64u(challenge);
  return navigator.credentials.create({ publicKey: {
    rp: { name: 'Smoke' }, user: { id: new Uint8Array([1, 2, 3]), name: 'smoke@example.com', displayName: 'Smoke' },
    challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
    .then((c) => { results.create = 'resolved'; results.createJson = c.toJSON(); results.isPkc = c instanceof PublicKeyCredential; }, (e) => { results.create = e.name; });
};
window.startGet = () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  results.getChallenge = b64u(challenge);
  return navigator.credentials.get({ publicKey: { challenge, userVerification: 'preferred' } })
    .then((c) => { results.get = 'resolved'; results.getJson = c.toJSON(); }, (e) => { results.get = e.name; });
};
</script>`;
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
await new Promise((r) => server.listen(0, '::', r)); // dual stack: "localhost" may resolve to ::1
const origin = `http://localhost:${server.address().port}`;

const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let seq = 0;
const pending = new Map();
const events = [];
let buffer = Buffer.alloc(0);
proc.stdio[4].on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(0)) >= 0) {
    const msg = JSON.parse(buffer.subarray(0, end).toString());
    buffer = buffer.subarray(end + 1);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else events.push(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  proc.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
});

async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
async function open(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const sessionId = await attach(targetId);
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', { expression: 'location.href + "|" + document.readyState', returnByValue: true }, sessionId).catch(() => null);
    const [href, readyState] = String(r?.result?.value || '').split('|');
    if (href.startsWith(url.split('#')[0]) && readyState === 'complete') break;
    await sleep(250);
  }
  return { targetId, sessionId };
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function shot(sessionId, name) {
  if (!out) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
}
function pageErrors(sessionId, label) {
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    if (e.method === 'Runtime.exceptionThrown') failures.push(`${label}: ${e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text}`);
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') failures.push(`${label}: console.error ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
}
async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}
const findTarget = async (prefix) => (await send('Target.getTargets')).targetInfos.find((x) => x.url.startsWith(prefix));
const sw = (sessionId, cmd, args = {}) => evaluate(sessionId, `chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...args })}).then((r) => { if (!r.ok) throw new Error(r.error.message); return r.result; })`);

try {
  const { id } = await send('Extensions.loadUnpacked', { path: extensionPath });
  console.log(`Erweiterung geladen: ${id}`);
  const ext = `chrome-extension://${id}`;
  await sleep(1000);
  check((await send('Target.getTargets')).targetInfos.some((x) => x.type === 'service_worker' && x.url === `${ext}/background.js`), 'Service Worker läuft nicht');

  // Developer demo backend, no desktop bridge; restart the extension so that the service worker picks it up.
  let options = await open(`${ext}/options/options.html`);
  await evaluate(options.sessionId, `chrome.storage.local.set({ devDemo: true, settings: { desktopBridge: false, language: 'de' } }).then(() => true)`);
  await evaluate(options.sessionId, 'setTimeout(() => chrome.runtime.reload(), 50), true');
  await sleep(2500);
  options = await open(`${ext}/options/options.html`);
  await waitFor(() => evaluate(options.sessionId, 'document.body.dataset.ready === "1"'));
  const unlocked = await sw(options.sessionId, 'unlock');
  check(unlocked.containers.length === 2, `Demo-Container: ${unlocked.containers.length}`);
  const personal = unlocked.containers.find((c) => c.name === 'Persönlich');

  const popup = await open(`${ext}/popup/popup.html`);
  check(await waitFor(() => evaluate(popup.sessionId, 'document.querySelectorAll(".row-item").length > 0')), 'Popup zeigt keine Einträge');
  await shot(popup.sessionId, 'ext-popup');
  pageErrors(popup.sessionId, 'popup');

  // Passkey registration through the prompt window, verified by an independent RP library.
  const tab = await open(`${origin}/`);
  await sleep(800);
  const r0 = await evaluate(tab.sessionId, 'results');
  check(r0.patched, 'WebAuthn-Shim nicht aktiv');
  await evaluate(tab.sessionId, 'startCreate(), true');
  let prompt = await waitFor(() => findTarget(`${ext}/prompt/prompt.html#create:`));
  check(prompt, 'Passkey-Dialog (create) wurde nicht geöffnet');
  if (prompt) {
    const s = await attach(prompt.targetId);
    await waitFor(() => evaluate(s, '!!document.querySelector("footer .btn.primary")'));
    await shot(s, 'ext-prompt-create');
    await evaluate(s, 'document.querySelector("footer .btn.primary").click(), true');
    const r = await waitFor(async () => (await evaluate(tab.sessionId, 'results')).create && evaluate(tab.sessionId, 'results'));
    check(r?.create === 'resolved' && r.isPkc, `create(): ${r?.create}`);
    if (r?.createJson) {
      const reg = await verifyRegistrationResponse({ response: r.createJson, expectedChallenge: r.createChallenge, expectedOrigin: origin, expectedRPID: 'localhost' });
      check(reg.verified, 'Registrierung nicht verifiziert');
      await evaluate(tab.sessionId, 'startGet(), true');
      prompt = await waitFor(() => findTarget(`${ext}/prompt/prompt.html#get:`));
      check(prompt, 'Passkey-Dialog (get) wurde nicht geöffnet');
      if (prompt) {
        const g = await attach(prompt.targetId);
        await waitFor(() => evaluate(g, '!!document.querySelector(".choice")'));
        await evaluate(g, 'document.querySelector(".choice").click(), true');
        const r2 = await waitFor(async () => (await evaluate(tab.sessionId, 'results')).get && evaluate(tab.sessionId, 'results'));
        check(r2?.get === 'resolved', `get(): ${r2?.get}`);
        if (r2?.getJson) {
          const auth = await verifyAuthenticationResponse({
            response: r2.getJson, expectedChallenge: r2.getChallenge, expectedOrigin: origin, expectedRPID: 'localhost', credential: reg.registrationInfo.credential,
          });
          check(auth.verified, 'Anmeldung nicht verifiziert');
        }
      }
    }
  }
  pageErrors(tab.sessionId, 'testpage');

  // Extra protection: master password, then a browser passkey (virtual authenticator with PRF).
  await sw(options.sessionId, 'protection:enable', { containerId: personal.id, methods: { password: 'smoke-master-1' } });
  await sw(options.sessionId, 'protection:lock', { containerId: personal.id });
  let st = await sw(options.sessionId, 'state');
  check(st.containers.find((c) => c.id === personal.id)?.locked, 'Container nach dem Sperren nicht gesperrt');
  await sw(options.sessionId, 'protection:unlock', { containerId: personal.id, params: { password: 'smoke-master-1' } });
  await send('Target.activateTarget', { targetId: options.targetId }); // WebAuthn needs the focused tab
  await send('WebAuthn.enable', { enableUI: false }, options.sessionId);
  await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } }, options.sessionId);
  await evaluate(options.sessionId, `import('/lib/protect-ctx.js').then(async ({ protectCtx }) => {
    const ctx = protectCtx({ name: 'Smoke' });
    await ctx.addPasskey(${JSON.stringify(personal.id)}, 'Smoke-Key');
    await ctx.lock(${JSON.stringify(personal.id)});
    await ctx.unlockPasskey(${JSON.stringify(personal.id)});
    return true;
  })`);
  st = await sw(options.sessionId, 'state');
  check(!st.containers.find((c) => c.id === personal.id)?.locked, 'Entsperren mit Passkey fehlgeschlagen');

  // Import of the sample CSV.
  const before = (await sw(options.sessionId, 'items')).length;
  const imported = await evaluate(options.sessionId, `Promise.all([import('/core/importer.js'), import('/core/import-sample.js')])
    .then(([imp, sample]) => imp.parseImport({ name: 'sample.csv', text: sample.SAMPLE_CSV }))
    .then((r) => chrome.runtime.sendMessage({ cmd: 'import', containerId: ${JSON.stringify(personal.id)}, items: r.items }))
    .then((r) => r.result.imported)`);
  check(imported === 4, `Import: ${imported}`);
  check((await sw(options.sessionId, 'items')).length === before + 4, 'Importierte Einträge fehlen');

  // English UI.
  await sw(options.sessionId, 'updateSettings', { patch: { language: 'en' } });
  const popupEn = await open(`${ext}/popup/popup.html`);
  const text = await waitFor(async () => {
    const tx = await evaluate(popupEn.sessionId, 'document.body.innerText');
    return /All \(\d+\)/.test(tx) && tx;
  });
  check(text, 'Englische Oberfläche nicht aktiv');
  await shot(popupEn.sessionId, 'ext-popup-en');
  await evaluate(options.sessionId, 'location.reload(), true');
  await sleep(1500);
  await shot(options.sessionId, 'ext-options-en');
  pageErrors(options.sessionId, 'options');
  pageErrors(popupEn.sessionId, 'popup-en');
} catch (e) {
  failures.push(e.message);
} finally {
  proc.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Browser may still hold files.
  }
}

if (failures.length) {
  console.error(`EXTENSION SMOKE FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('EXTENSION SMOKE OK');
