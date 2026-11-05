// End-to-end test of the browser extension in headless Edge/Chrome (DevTools protocol over a pipe), using the
// developer demo backend (no Azure): pages and service worker load, passkey registration and sign-in through
// the prompt window are verified with an independent relying-party library, extra protection with master
// password and browser passkey (virtual authenticator), import of the sample CSV, English UI.
// Usage: node scripts/extension-smoke.mjs [--browser=<path>] [--out=<dir for screenshots>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
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
// A copy without the fixed key: its own extension ID, so a Keevault installed by policy on this machine neither
// blocks the test nor gets involved (the app's native host only accepts the real ID).
const extensionPath = join(profile, 'extension');
cpSync(arg('extension') || fileURLToPath(new URL('../extension', import.meta.url)), extensionPath, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8'));
delete manifest.key;
delete manifest.update_url;
// The imitated Microsoft sign-in runs over http (as a secure origin, see the browser flags): the copy's passkey shim
// also loads there.
manifest.content_scripts.find((c) => c.world === 'MAIN').matches.push('http://login.microsoftonline.com/*', 'http://login.microsoft.com/*');
writeFileSync(join(extensionPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
// A Keevault installed by policy (ExtensionInstallForcelist applies to every profile, the test one included) would
// answer the page's WebAuthn relay as well and race the copy – the copy speaks on its own channel.
for (const f of ['content/webauthn-main.js', 'content/content.js']) {
  const p = join(extensionPath, f);
  writeFileSync(p, readFileSync(p, 'utf8').replace("'kvpwsafe-webauthn-v1'", "'kvpwsafe-webauthn-smoke'"));
}
// The fake Microsoft sign-in page runs over http on a local port: only the copy accepts it. The policy-installed
// Keevault ignores it (https on the standard port only) – it would otherwise offer the real vault's accounts there.
{
  const p = join(extensionPath, 'background.js');
  const src = readFileSync(p, 'utf8');
  if (!src.includes('const SIGN_IN_HTTPS_ONLY = true;')) throw new Error('background.js: SIGN_IN_HTTPS_ONLY nicht gefunden');
  writeFileSync(p, src.replace('const SIGN_IN_HTTPS_ONLY = true;', 'const SIGN_IN_HTTPS_ONLY = false;'));
}
// Passkeys need https – in the copy the imitated Microsoft sign-in (http, local port) counts like localhost.
{
  const p = join(extensionPath, 'core/webauthn.js');
  const src = readFileSync(p, 'utf8');
  const http = "!(url.protocol === 'http:' && localhost)";
  if (!src.includes(http)) throw new Error('core/webauthn.js: https check not found');
  writeFileSync(p, src.replace(http, "!(url.protocol === 'http:' && (localhost || host === 'login.microsoftonline.com' || host === 'login.microsoft.com'))"));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const page = `<!doctype html><title>WebAuthn test</title><body><form><input autocomplete="username"><input type="password"></form>
<script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
window.results = { patched: navigator.credentials.__kvpwsafe === true, msgs: [] };
window.addEventListener('message', (e) => { if (e.data && e.data.channel) results.msgs.push(e.data.dir + ':' + e.data.id + ':' + Object.keys(e.data).join(',')); });
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
    .then((c) => { results.get = 'resolved'; results.getJson = c.toJSON(); }, (e) => { results.get = e.name; results.getMessage = e.message; });
};
</script>`;
// Imitation of the Microsoft sign-in (served as login.microsoftonline.com, see --host-resolver-rules): account name,
// then password, each confirmed with #idSIButton9 – what the extension fills is recorded in window.signedIn.
const msPage = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<form onsubmit="return false"><input name="loginfmt" type="email" placeholder="Email">
<input name="passwd" type="password" placeholder="Password" style="display:none">
<input type="submit" id="idSIButton9" value="Next"></form>
<div id="kmsi" style="display:none"><div id="KmsiDescription">Angemeldet bleiben?</div><input type="checkbox" id="KmsiCheckboxField">
<input type="button" id="idBtn_Back" value="Nein"></div>
<script>
window.signedIn = {};
document.getElementById('idSIButton9').addEventListener('click', () => {
  const user = document.querySelector('[name=loginfmt]');
  const pw = document.querySelector('[name=passwd]');
  if (user.style.display !== 'none') { signedIn.user = user.value; user.style.display = 'none'; pw.style.display = ''; }
  else {
    signedIn.password = pw.value;
    // Like Microsoft: after the password the "Stay signed in?" question (Keevault answers "No" after its own sign-in).
    pw.style.display = 'none';
    document.getElementById('kmsi').style.display = '';
  }
});
document.getElementById('idBtn_Back').addEventListener('click', () => { signedIn.staySignedIn = 'no'; });
</script>`;
// Microsoft's "Pick an account" with a different account only: Keevault must take "Use another account" (#13).
const msPickPage = msPage.replace('<form onsubmit="return false"><input name="loginfmt" type="email" placeholder="Email">',
  `<div id="tiles"><div data-test-id="someone@else.com"><div role="button" id="wrongTile" onclick="signedIn.wrongTile = true">someone@else.com</div></div>
<div id="otherTile" role="button" onclick="document.getElementById('tiles').remove(); document.querySelector('[name=loginfmt]').style.display = ''">Anderes Konto verwenden</div></div>
<form onsubmit="return false"><input name="loginfmt" type="email" placeholder="Email" style="display:none">`);
// Microsoft's password page with the switch to a passkey: an entry without a password must take the switch, never
// submit the empty field.
// The switch starts Microsoft's passkey prompt; signed in, it continues on login.microsoft.com (another origin) with
// "Stay signed in?" – Keevault must answer "No" there too.
const msPasskeyPage = msPage.replace('<input type="submit" id="idSIButton9" value="Next">',
  `<a id="idA_PWD_SwitchToFido" href="#" style="display:none" onclick="signedIn.fido = true; navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'preferred' } }).then(() => { location.href = 'http://login.microsoft.com:' + location.port + '/mskmsi?pk=resolved'; }, (e) => { signedIn.passkey = e.name; }); return false">Verwenden Sie stattdessen Ihr Gesicht, Ihren Fingerabdruck, Ihre PIN oder Ihren Sicherheitsschlüssel</a>
<input type="submit" id="idSIButton9" value="Next">`).replace('</script>', `document.getElementById('idSIButton9').addEventListener('click', () => {
  if (document.querySelector('[name=passwd]').style.display === '') document.getElementById('idA_PWD_SwitchToFido').style.display = '';
  if (signedIn.password === '') signedIn.emptySubmit = true;
});
</script>`);
const msKmsiPage = `<!doctype html><meta charset="utf-8"><title>Stay signed in</title>
<div id="KmsiDescription">Angemeldet bleiben?</div><input type="checkbox" id="KmsiCheckboxField">
<input type="button" id="idBtn_Back" value="Nein">
<script>
window.signedIn = { passkey: new URLSearchParams(location.search).get('pk') };
document.getElementById('idBtn_Back').addEventListener('click', () => { signedIn.staySignedIn = 'no'; });
</script>`;
// The Bastion blade inside the Azure portal (served as portal.azure.com, the VM in the address's #-part): no form,
// a plain "Connect" button (#12).
const portalBastionPage = `<!doctype html><meta charset="utf-8"><title>Bastion</title>
<input id="u" placeholder="Username"><input id="p" type="password" placeholder="VM Password">
<button type="button" id="connect">Connect</button>`;
// Imitation of a Bastion sign-in to a VM (served as bst-smoke.bastion.azure.com, the VM in the address like the portal).
const bastionPage = `<!doctype html><meta charset="utf-8"><title>Bastion</title>
<form onsubmit="window.connected = true; return false"><input name="username" autocomplete="username"><input name="password" type="password">
<button type="submit">Connect</button></form>`;
// Imitation of the Sophos VPN/user portal sign-in (same fields as the real page: name="username", name="password").
const sophosPage = `<!doctype html><meta charset="utf-8"><title>VPN Portal</title>
<form onsubmit="return false" method="post"><input name="username" type="text" id="username"><input name="password" type="password" id="password" autocomplete="off">
<input class="blue_btn" name="loginbutton" value="Login" type="submit"></form>`;
const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(req.url.startsWith('/sophos') ? sophosPage : req.url.startsWith('/portal') ? portalBastionPage : req.url.startsWith('/mspick') ? msPickPage : req.url.startsWith('/mspk') ? msPasskeyPage : req.url.startsWith('/mskmsi') ? msKmsiPage : req.url.startsWith('/mswa') ? page : req.url.startsWith('/ms') || req.url.startsWith('/common/oauth2/logout') ? msPage : req.url.includes('/virtualMachines/') ? bastionPage : page));
await new Promise((r) => server.listen(0, '::', r)); // dual stack: "localhost" may resolve to ::1
const origin = `http://localhost:${server.address().port}`;

const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP login.microsoftonline.com 127.0.0.1,MAP login.microsoft.com 127.0.0.1,MAP bst-smoke.bastion.azure.com 127.0.0.1,MAP portal.azure.com 127.0.0.1',
  // WebAuthn needs a secure context: the imitated Microsoft sign-in runs over http on a local port.
  `--unsafely-treat-insecure-origin-as-secure=http://login.microsoftonline.com:${server.address().port},http://login.microsoft.com:${server.address().port}`,
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
/** Node id of `selector` inside the (closed) shadow root of the element `hostSelector`, or null. */
async function shadowNode(sessionId, hostSelector, selector) {
  await send('DOM.enable', {}, sessionId).catch(() => {});
  const { root } = await send('DOM.getDocument', { depth: 0 }, sessionId);
  const { nodeId: hostId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: hostSelector }, sessionId);
  if (!hostId) return null;
  const { node } = await send('DOM.describeNode', { nodeId: hostId, depth: 0, pierce: true }, sessionId);
  const shadow = node.shadowRoots?.[0];
  if (!shadow) return null;
  const { nodeIds } = await send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [shadow.backendNodeId] }, sessionId);
  const { nodeId } = await send('DOM.querySelector', { nodeId: nodeIds[0], selector }, sessionId);
  return nodeId || null;
}
/**
 * Trusted click in the middle of a node (the content script ignores synthetic clicks). A selector inside the UI's
 * shadow root is looked up right before the click and retried – the bar re-renders while it slides in.
 */
async function clickNode(sessionId, target) {
  if (typeof target === 'string') {
    for (let i = 0; ; i++) {
      try {
        const id = await shadowNode(sessionId, 'kvpwsafe-ui', target);
        if (!id) throw new Error(`${target} nicht gefunden`);
        return await clickNode(sessionId, id);
      } catch (e) {
        if (i >= 4) throw e;
        await sleep(250);
      }
    }
  }
  const nodeId = target;
  const { model } = await send('DOM.getBoxModel', { nodeId }, sessionId);
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    // Which page: a failing check names the address (and the expression) instead of only the error.
    const where = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId).then((x) => x.result?.value).catch(() => '?');
    throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text} – ${where} – ${expression.slice(0, 80)}`);
  }
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
  let lastError = null;
  while (Date.now() - start < ms) {
    // A page that is just navigating (new document, its script not run yet) answers with an error: ask again.
    try {
      const v = await fn();
      if (v) return v;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    await sleep(250);
  }
  if (lastError) throw lastError;
  return null;
}
const findTarget = async (prefix) => (await send('Target.getTargets')).targetInfos.find((x) => x.url.startsWith(prefix));
const sw = (sessionId, cmd, args = {}) => evaluate(sessionId, `chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...args })}).then((r) => { if (!r.ok) throw new Error(r.error.message); return r.result; })`);

try {
  const { id } = await send('Extensions.loadUnpacked', { path: extensionPath });
  console.log(`Erweiterung geladen: ${id}`);
  const ext = `chrome-extension://${id}`;
  await sleep(1000);
  const worker = (await send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && x.url === `${ext}/background.js`);
  check(worker, 'Service Worker läuft nicht');

  // Without the app (this copy's ID is not allowed by any native host): the popup says so and offers to start it.
  const offline = await open(`${ext}/popup/popup.html`);
  const offlineText = await waitFor(async () => {
    const tx = await evaluate(offline.sessionId, 'document.body.innerText');
    return /Keevault-App/.test(tx) && tx;
  });
  check(offlineText, 'Popup ohne App: kein Hinweis auf die Keevault-App');
  await shot(offline.sessionId, 'ext-popup-offline');
  pageErrors(offline.sessionId, 'popup-offline');

  // Developer demo backend instead of the desktop app – set in the service worker itself, before any page asks the
  // app (a real Keevault on this machine must not be involved); restart so that the worker picks it up.
  const workerSession = await attach(worker.targetId);
  await evaluate(workerSession, `chrome.storage.local.set({ devDemo: true, settings: { language: 'de' } }).then(() => true)`);
  await evaluate(workerSession, 'setTimeout(() => chrome.runtime.reload(), 50), true');
  await sleep(2500);
  let options = await open(`${ext}/options/options.html`);
  await waitFor(() => evaluate(options.sessionId, 'document.body.dataset.ready === "1"'));
  const unlocked = await sw(options.sessionId, 'unlock');
  check(unlocked.containers.length === 2, `Demo-Container: ${unlocked.containers.length}`);
  const personal = unlocked.containers.find((c) => c.name === 'Persönlich');

  const popup = await open(`${ext}/popup/popup.html`);
  check(await waitFor(() => evaluate(popup.sessionId, 'document.querySelectorAll(".row-item").length > 0')), 'Popup zeigt keine Einträge');
  await shot(popup.sessionId, 'ext-popup');
  // Right-click on an entry: own context menu, "Edit" opens the form.
  const rowBox = JSON.parse(await evaluate(popup.sessionId, 'JSON.stringify(document.querySelector("li.row-item")?.getBoundingClientRect() || null)') || 'null');
  check(rowBox, 'Popup: keine Einträge für das Kontextmenü');
  if (rowBox) {
    const x = rowBox.left + 40;
    const y = rowBox.top + rowBox.height / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'right', clickCount: 1 }, popup.sessionId);
    const menu = await waitFor(() => evaluate(popup.sessionId, '!!document.querySelector(".context-menu")'));
    check(menu, 'Popup: Kontextmenü erschien nicht');
    if (menu) {
      await shot(popup.sessionId, 'ext-popup-menu');
      await evaluate(popup.sessionId, '[...document.querySelectorAll(".context-menu button")].find((b) => /Bearbeiten|Edit/.test(b.textContent)).click(), true');
      check(await waitFor(() => evaluate(popup.sessionId, '!!document.querySelector("input[name=title]")')), 'Popup: „Bearbeiten“ öffnete kein Formular');
      await evaluate(popup.sessionId, 'location.reload(), true');
      await sleep(800);
    }
  }
  // Entry icon from a website's favicon: a 32×32 PNG becomes a small data URL; SVG and non-images give ''.
  const favicon = await evaluate(popup.sessionId, `(async () => {
    const c = new OffscreenCanvas(32, 32); const g = c.getContext('2d'); g.fillStyle = '#0f6cbd'; g.fillRect(0, 0, 32, 32);
    const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const png = 'data:image/png;base64,' + btoa(String.fromCharCode(...b));
    const m = await import(chrome.runtime.getURL('core/image.js'));
    return JSON.stringify({ png: (await m.faviconToDataUrl(png)).slice(0, 15), svg: await m.faviconToDataUrl('data:image/svg+xml;base64,PHN2Zy8+'), none: await m.faviconToDataUrl('') });
  })()`);
  const fav = JSON.parse(favicon || '{}');
  check(/^data:image\/(webp|png)/.test(fav.png || ''), `Favicon als Symbol: ${favicon}`);
  check(fav.svg === '' && fav.none === '', `Favicon: SVG/leer sollte '' ergeben (${favicon})`);
  pageErrors(popup.sessionId, 'popup');

  // Passkey registration through the bar at the top of the page ("Save in Keevault"), verified by an independent
  // RP library.
  const tab = await open(`${origin}/`);
  await sleep(800);
  const r0 = await evaluate(tab.sessionId, 'results');
  check(r0.patched, 'WebAuthn-Shim nicht aktiv');
  await evaluate(tab.sessionId, 'startCreate(), true');
  const save = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .primary'));
  check(save, 'Passkey-Leiste (create) erschien nicht in der Seite');
  if (!save && process.env.KV_SMOKE_DEBUG) {
    console.log(`[debug] create: window=${!!(await findTarget(`${ext}/prompt/prompt.html#create:`))} results=${JSON.stringify(await evaluate(tab.sessionId, 'results'))}`);
  }
  let prompt = null;
  if (save) {
    await sleep(500);
    await shot(tab.sessionId, 'ext-inline-create');
    await clickNode(tab.sessionId, '.kvtag .primary');
    const r = await waitFor(async () => (await evaluate(tab.sessionId, 'results')).create && evaluate(tab.sessionId, 'results'));
    check(r?.create === 'resolved' && r.isPkc, `create(): ${r?.create}`);
    // The new entry waits for the popup in edit mode (headless has no toolbar popup: open the page directly).
    // chrome.action.openPopup may already have opened the real popup – then that one shows the form.
    await sleep(1200);
    let editPopup = null;
    let editForm = '';
    const popups = (await send('Target.getTargets')).targetInfos.filter((x) => x.url.startsWith(`${ext}/popup/popup.html`) && x.targetId !== popup.targetId);
    for (const p of popups) {
      const sessionId = await attach(p.targetId);
      const v = await waitFor(() => evaluate(sessionId, 'document.querySelector("input[name=title]")?.value || ""'), 3000);
      if (v) { editPopup = { targetId: p.targetId, sessionId }; editForm = v; break; }
    }
    if (!editPopup) {
      editPopup = await open(`${ext}/popup/popup.html`);
      editForm = await waitFor(() => evaluate(editPopup.sessionId, 'document.querySelector("input[name=title]")?.value || ""'));
    }
    if (process.env.KV_SMOKE_DEBUG) console.log(`[debug] edit popup: ${popups.length} opened by the extension, form: ${editForm}`);
    check(editForm, 'Nach dem Speichern des Passkeys öffnete das Popup den Eintrag nicht zum Bearbeiten');
    if (editForm) await shot(editPopup.sessionId, 'ext-popup-edit-after-passkey');
    // An existing entry without an icon on its own site: "Take over the website's icon" is offered (#314).
    if (editForm) {
      const si = JSON.parse(await evaluate(editPopup.sessionId, 'JSON.stringify({ btn: !!document.querySelector(".site-icon"), hidden: !!document.querySelector(".site-icon")?.hidden, icon: !!document.querySelector(".icon-row .avatar img") })'));
      check(si.icon || (si.btn && !si.hidden), `Bearbeiten ohne Symbol: kein „Icon der Website übernehmen“ (${JSON.stringify(si)})`);
    }
    await send('Target.closeTarget', { targetId: editPopup.targetId }).catch(() => {});
    if (r?.createJson) {
      const reg = await verifyRegistrationResponse({ response: r.createJson, expectedChallenge: r.createChallenge, expectedOrigin: origin, expectedRPID: 'localhost' });
      check(reg.verified, 'Registrierung nicht verifiziert');
      // Sign-in 1: the in-page chooser bar (closed shadow root, reached through the DOM domain), "Use passkey".
      await evaluate(tab.sessionId, 'startGet(), true');
      const use = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .primary'));
      check(use, 'Passkey-Leiste (get) erschien nicht in der Seite');
      if (use) {
        await sleep(500); // the bar slides in – click only once it has settled
        await shot(tab.sessionId, 'ext-inline-get');
        await clickNode(tab.sessionId, '.kvtag .primary');
        const r2 = await waitFor(async () => (await evaluate(tab.sessionId, 'results')).get && evaluate(tab.sessionId, 'results'));
        check(r2?.get === 'resolved', `get() über die Leiste: ${r2?.get}`);
        if (process.env.KV_SMOKE_DEBUG && r2?.get !== 'resolved') {
          const res = await evaluate(tab.sessionId, 'results');
          console.log(`[debug] get: ${res.get} – ${res.getMessage}; bar still there: ${!!(await shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag'))}; UI hosts: ${await evaluate(tab.sessionId, 'document.querySelectorAll("kvpwsafe-ui").length')}`);
          console.log(`[debug] page messages: ${JSON.stringify(res.msgs)}`);
          await shot(tab.sessionId, 'ext-inline-after-click');
        }
        if (r2?.getJson) {
          const auth = await verifyAuthenticationResponse({
            response: r2.getJson, expectedChallenge: r2.getChallenge, expectedOrigin: origin, expectedRPID: 'localhost', credential: reg.registrationInfo.credential,
          });
          check(auth.verified, 'Anmeldung (Leiste) nicht verifiziert');
        }
      }
      // Sign-in 2: "Other options" in the bar opens the prompt window, which signs in through its list.
      await sleep(1500); // the first sign-in still stores the passkey's new counter (index update)
      await evaluate(tab.sessionId, 'delete results.get; delete results.getJson; startGet(), true');
      const more = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .switch'));
      check(more, 'Passkey-Leiste (2. get) erschien nicht');
      if (more) {
        await sleep(500);
        if (process.env.KV_SMOKE_DEBUG) {
          const box = await send('DOM.getBoxModel', { nodeId: more }, tab.sessionId).catch((e) => ({ error: e.message }));
          const xbox = await send('DOM.getBoxModel', { nodeId: await shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .link-other') }, tab.sessionId).catch((e) => ({ error: e.message }));
          console.log(`[debug] before click: more=${JSON.stringify(box.model?.content || box.error)} x=${JSON.stringify(xbox.model?.content || xbox.error)}`);
        }
        await clickNode(tab.sessionId, '.kvtag .switch');
        const other = await waitFor(() => shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag .opt-window'));
        check(other, 'Liste der Leiste erschien nicht');
        if (process.env.KV_SMOKE_DEBUG && !other) {
          const res = await evaluate(tab.sessionId, 'results');
          const box = await send('DOM.getBoxModel', { nodeId: more }, tab.sessionId).catch((e) => ({ error: e.message }));
          console.log(`[debug] list: get=${res.get}; bar: ${!!(await shadowNode(tab.sessionId, 'kvpwsafe-ui', '.kvtag'))}; more box: ${JSON.stringify(box.model?.content || box.error)}; messages: ${JSON.stringify(res.msgs.slice(-4))}; cs: ${await evaluate(tab.sessionId, 'JSON.stringify(document.documentElement.dataset)')}`);
          await shot(tab.sessionId, 'ext-inline-list-missing');
        }
        if (other) {
          await sleep(300);
          await shot(tab.sessionId, 'ext-inline-list');
          await clickNode(tab.sessionId, '.kvtag .opt-window');
        }
        prompt = await waitFor(() => findTarget(`${ext}/prompt/prompt.html#get:`));
        check(prompt, 'Passkey-Dialog (get) wurde nicht geöffnet');
        if (prompt) {
          const g = await attach(prompt.targetId);
          await waitFor(() => evaluate(g, '!!document.querySelector(".choice")'));
          await shot(g, 'ext-prompt-get');
          await evaluate(g, 'document.querySelector(".choice").click(), true');
          const r3 = await waitFor(async () => (await evaluate(tab.sessionId, 'results')).get && evaluate(tab.sessionId, 'results'));
          check(r3?.get === 'resolved', `get() über das Fenster: ${r3?.get}`);
          if (r3?.getJson) {
            const auth = await verifyAuthenticationResponse({
              response: r3.getJson, expectedChallenge: r3.getChallenge, expectedOrigin: origin, expectedRPID: 'localhost', credential: reg.registrationInfo.credential,
            });
            check(auth.verified, 'Anmeldung (Fenster) nicht verifiziert');
          }
        }
      }
    }
  }
  pageErrors(tab.sessionId, 'testpage');

  // Microsoft sign-in: the bar offers the Microsoft account of the demo vault; a click signs in (name, then password).
  const ms = await open(`http://login.microsoftonline.com:${server.address().port}/ms`);
  await sleep(2500);
  await shot(ms.sessionId, 'ext-ms-bar');
  // More than one account: the bar has a search field (#10). The bar is a closed shadow root – CDP pierces it.
  const msTree = await send('DOM.getDocument', { depth: -1, pierce: true }, ms.sessionId);
  const findNode = (n, ok) => (ok(n) ? n : (n.children || []).concat(n.shadowRoots || []).reduce((hit, c) => hit || findNode(c, ok), null));
  const findAll = (n, ok, acc = []) => { if (ok(n)) acc.push(n); for (const c of (n.children || []).concat(n.shadowRoots || [])) findAll(c, ok, acc); return acc; };
  const attrsOf = (n) => Object.fromEntries((n.attributes || []).reduce((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]]]), []));
  const msSearch = findNode(msTree.root, (n) => n.nodeName === 'INPUT' && attrsOf(n).type === 'search');
  check(!!msSearch, 'Microsoft-Leiste: keine Suche bei mehreren Konten');
  // Centre of an element in the bar (first match), taken from the pierced DOM – the layout may change.
  const barPoint = async (sessionId, ok) => {
    const tree = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const n = findNode(tree.root, ok);
    if (!n) return null;
    const { model } = await send('DOM.getBoxModel', { nodeId: n.nodeId }, sessionId);
    const q = model.border;
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
  };
  const firstAccount = (n) => n.nodeName === 'BUTTON' && attrsOf(n).class === 'entry';
  const rememberBox = (n) => n.nodeName === 'INPUT' && attrsOf(n).type === 'checkbox' && !attrsOf(n).id;
  let msResult = null;
  // The bar sits in a closed shadow root at the top right: click its first account (trusted click by position).
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await barPoint(ms.sessionId, firstAccount);
    if (!p) { await sleep(800); continue; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, ms.sessionId);
    msResult = await waitFor(async () => { const r = await evaluate(ms.sessionId, 'signedIn'); return r.password && r; }, 6000);
    if (msResult) break;
  }
  // First in the bar: the demo's emergency account (Azure login, sorted by title).
  check(msResult?.user === 'breakglass@contoso.onmicrosoft.com', `Microsoft-Anmeldung: Konto ${msResult?.user}`);
  check(msResult?.password === 'Xc5&rM8!pLq3#Vz7', 'Microsoft-Anmeldung: Passwort nicht eingetragen');
  const kmsi = await waitFor(async () => (await evaluate(ms.sessionId, 'signedIn')).staySignedIn, 6000);
  check(kmsi === 'no', '„Angemeldet bleiben?“ nach der Keevault-Anmeldung nicht mit „Nein“ beantwortet');
  pageErrors(ms.sessionId, 'ms-signin');

  // The field menu on Microsoft's page (#334): an account chosen there signs in step by step like the bar – name,
  // then the password on the next page –, not only the name.
  const msMenu = await open(`http://login.microsoftonline.com:${server.address().port}/ms?menu`);
  await sleep(2000);
  let menuResult = null;
  let menuState = null;
  for (let attempt = 0; attempt < 3 && !menuResult; attempt++) {
    const field = await evaluate(msMenu.sessionId, '(() => { const r = document.querySelector("[name=loginfmt]").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: field.x, y: field.y, button: 'left', clickCount: 1 }, msMenu.sessionId);
    await sleep(1200);
    const menuTree = await send('DOM.getDocument', { depth: -1, pierce: true }, msMenu.sessionId);
    // A Keevault installed by policy also runs in this browser and shows its own menu (with the real vault, if the app
    // is unlocked): only the menu with the demo accounts (contoso) belongs to the copy under test.
    const demoText = (n) => n.nodeType === 3 && /contoso/i.test(n.nodeValue || '');
    const menuNode = findAll(menuTree.root, (n) => n.nodeName === 'DIV' && attrsOf(n).class === 'menu').find((m) => findNode(m, demoText));
    const entry = menuNode && findNode(menuNode, firstAccount);
    // The other Keevault's menu lies on top at the same place: its host element is hidden, so the click reaches ours.
    for (const h of findAll(menuTree.root, (n) => n.nodeName === 'KVPWSAFE-UI')) {
      if (menuNode && !findNode(h, (n) => n === menuNode)) await send('DOM.setAttributeValue', { nodeId: h.nodeId, name: 'style', value: 'display:none' }, msMenu.sessionId);
    }
    menuState ={ menu: !!menuNode, entry: !!entry, field, focused: await evaluate(msMenu.sessionId, 'document.activeElement?.name || document.activeElement?.tagName') };
    if (!entry) continue;
    const { model } = await send('DOM.getBoxModel', { nodeId: entry.nodeId }, msMenu.sessionId);
    const q = model.border;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, button: 'left', clickCount: 1 }, msMenu.sessionId);
    menuResult = await waitFor(async () => { const r = await evaluate(msMenu.sessionId, 'signedIn'); return r.password && r; }, 6000);  }
  check(!!menuResult?.user && !!menuResult?.password, `Feldmenü auf der Microsoft-Seite: Anmeldung bleibt stehen (${JSON.stringify(menuResult && { user: menuResult.user, password: !!menuResult.password })} ${JSON.stringify(menuState)})`);
  pageErrors(msMenu.sessionId, 'ms-menu');

  // Bastion: signing in to a VM is offered as an asset (Azure VM) with the VM name and the Bastion link from the address.
  const vmPath = '/subscriptions/s-smoke/resourceGroups/rg-smoke/providers/Microsoft.Compute/virtualMachines/vm-smoke-01/bastionHost';
  const bst = await open(`http://bst-smoke.bastion.azure.com:${server.address().port}${vmPath}`);
  await sleep(1500);
  await evaluate(bst.sessionId, `(() => { const f = document.forms[0]; f.username.value = 'CONTOSO\\\\vmadmin'; f.password.value = 'Vm-Smoke-1'; f.requestSubmit(); return true; })()`);
  const pendingBastion = await waitFor(async () => {
    const all = await evaluate(options.sessionId, 'chrome.storage.session.get(null)');
    return Object.values(all || {}).find((p) => p?.action === 'bastion');
  }, 6000);
  check(pendingBastion?.bastion?.vmName === 'vm-smoke-01', `Bastion: kein Speichern als Asset angeboten (${JSON.stringify(pendingBastion?.bastion || null)})`);
  check(/virtualMachines\/vm-smoke-01\/bastionHost$/.test(pendingBastion?.bastion?.bastionUrl || ''), 'Bastion: Link zur VM fehlt');
  check(pendingBastion?.username === 'CONTOSO\\vmadmin' && pendingBastion?.password === 'Vm-Smoke-1', 'Bastion: Anmeldedaten der VM fehlen');
  pageErrors(bst.sessionId, 'bastion');

  // Bastion blade in the portal: "Connect" (a plain button) offers the save; a VM that is already an asset gets the
  // login stored in it instead (#12).
  await sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'server', title: 'vm-smoke-03', server: { kind: 'azurevm' } } });
  for (const [vm, existing] of [['vm-smoke-02', false], ['vm-smoke-03', true]]) {
    await evaluate(options.sessionId, 'chrome.storage.session.get(null).then((all) => chrome.storage.session.remove(Object.keys(all).filter((k) => all[k]?.action === "bastion")))');
    const portal = await open(`http://portal.azure.com:${server.address().port}/portal#@contoso.com/resource/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/${vm}/bastionHost`);
    await sleep(1500);
    await evaluate(portal.sessionId, `(() => { document.getElementById('u').value = 'vmadmin@contoso.local'; document.getElementById('p').value = 'Vm-Portal-1'; return true; })()`);
    const c = await evaluate(portal.sessionId, 'JSON.stringify((({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 2 }))(document.getElementById("connect").getBoundingClientRect()))');
    const { x, y } = JSON.parse(c);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, portal.sessionId);
    const p = await waitFor(async () => {
      const all = await evaluate(options.sessionId, 'chrome.storage.session.get(null)');
      return Object.values(all || {}).find((q) => q?.action === 'bastion');
    }, 6000);
    check(p?.bastion?.vmName === vm && p?.password === 'Vm-Portal-1', `Bastion im Portal: „Connect“ bietet kein Speichern an (${vm}: ${JSON.stringify(p?.bastion || null)})`);
    check(!!p?.target === existing, `Bastion im Portal: ${existing ? 'vorhandenes Asset nicht erkannt' : 'neue VM als vorhanden behandelt'} (${vm})`);
    pageErrors(portal.sessionId, 'portal-bastion');
  }

  // Bastion opened in the browser (#27): the bar offers the logins; the chosen one is filled in, "Connect" is pressed and
  // the VM is kept as an asset linked to that login.
  {
    const vmPick = '/subscriptions/s-smoke/resourceGroups/rg-smoke/providers/Microsoft.Compute/virtualMachines/vm-smoke-05/bastionHost';
    const bp = await open(`http://bst-smoke.bastion.azure.com:${server.address().port}${vmPick}`);
    await sleep(2500);
    const acc = await waitFor(() => barPoint(bp.sessionId, firstAccount), 6000);
    check(!!acc, 'Bastion-Leiste: keine Konten angeboten');
    if (acc) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: acc.x, y: acc.y, button: 'left', clickCount: 1 }, bp.sessionId);
      const done = await waitFor(async () => { const r = await evaluate(bp.sessionId, '({ connected: !!window.connected, user: document.forms[0].username.value, pw: !!document.forms[0].password.value })'); return r.connected && r; }, 8000);
      check(done?.pw && done?.user, `Bastion-Leiste: nicht ausgefüllt und verbunden (${JSON.stringify(done)})`);
      // Sent by Keevault itself: no "save this Bastion sign-in?" afterwards (#33).
      await sleep(1500);
      const asked = await evaluate(options.sessionId, 'chrome.storage.session.get(null).then((all) => Object.values(all).some((p) => p?.action === "bastion" && p?.bastion?.vmName === "vm-smoke-05"))');
      check(!asked, 'Bastion-Leiste: danach trotzdem „Bastion-Zugang speichern?“ angeboten');
      const asset = await waitFor(async () => {
        const all = await sw(options.sessionId, 'items', {});
        const s = (all || []).find((x) => x.type === 'server' && x.title === 'vm-smoke-05');
        return s ? sw(options.sessionId, 'item', { containerId: s.containerId, id: s.id }) : null;
      }, 6000);
      check(!!asset?.server?.bastionVmLink && /vm-smoke-05\/bastionHost$/.test(asset?.server?.bastionUrl || ''), `Bastion-Leiste: Asset nicht mit dem Konto angelegt (${JSON.stringify(asset?.server || null)})`);
      if (asset) await sw(options.sessionId, 'delete', { containerId: asset.containerId, id: asset.id }).catch(() => {});
    }
    pageErrors(bp.sessionId, 'bastion-pick');
    // "Save" next to an account (#306): the VM becomes an asset linked to it – without signing in.
    const vmSave = '/subscriptions/s-smoke/resourceGroups/rg-smoke/providers/Microsoft.Compute/virtualMachines/vm-smoke-06/bastionHost';
    const bs = await open(`http://bst-smoke.bastion.azure.com:${server.address().port}${vmSave}`);
    await sleep(2500);
    const keep = await waitFor(() => barPoint(bs.sessionId, (n) => n.nodeName === 'BUTTON' && /save-only/.test(attrsOf(n).class || '')), 6000);
    check(!!keep, 'Bastion-Leiste: kein „Speichern“ neben den Konten');
    if (keep) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: keep.x, y: keep.y, button: 'left', clickCount: 1 }, bs.sessionId);
      const kept = await waitFor(async () => {
        const all = await sw(options.sessionId, 'items', {});
        const s = (all || []).find((x) => x.type === 'server' && x.title === 'vm-smoke-06');
        return s ? sw(options.sessionId, 'item', { containerId: s.containerId, id: s.id }) : null;
      }, 6000);
      check(!!kept?.server?.bastionVmLink, `Bastion „Speichern“: kein verknüpftes Asset (${JSON.stringify(kept?.server || null)})`);
      const state = await evaluate(bs.sessionId, '({ connected: !!window.connected, pw: !!document.forms[0].password.value })');
      check(!state.connected && !state.pw, `Bastion „Speichern“: trotzdem angemeldet (${JSON.stringify(state)})`);
      if (kept) await sw(options.sessionId, 'delete', { containerId: kept.containerId, id: kept.id }).catch(() => {});
    }
    pageErrors(bs.sessionId, 'bastion-save');
  }

  // "Remember": tick the box, choose the account – the next Microsoft sign-in starts by itself after the countdown.
  const ms2 = await open(`http://login.microsoftonline.com:${server.address().port}/ms?2`);
  await sleep(2500);
  const tap = async (sessionId, x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  };
  const box = await barPoint(ms2.sessionId, rememberBox);
  const acc = await barPoint(ms2.sessionId, firstAccount);
  check(box && acc, 'Merken: Leiste ohne Konto oder Kästchen');
  if (box && acc) {
    await tap(ms2.sessionId, box.x, box.y);
    await tap(ms2.sessionId, acc.x, acc.y);
  }
  check(await waitFor(async () => (await evaluate(ms2.sessionId, 'signedIn')).password), 'Merken: Anmeldung nach Klick fehlt');
  const ms3 = await open(`http://login.microsoftonline.com:${server.address().port}/ms?3`);
  const auto = await waitFor(async () => { const r = await evaluate(ms3.sessionId, 'signedIn'); return r.password && r; }, 10000);
  check(auto?.user === 'breakglass@contoso.onmicrosoft.com', `Merken: keine automatische Anmeldung (${auto?.user})`);
  pageErrors(ms3.sessionId, 'ms-auto');

  // "Pick an account" with another account only: the chosen account goes through "Use another account" (#13).
  const pick = await open(`http://login.microsoftonline.com:${server.address().port}/mspick`);
  await sleep(2500);
  const pickAcc = await barPoint(pick.sessionId, firstAccount);
  if (pickAcc) await tap(pick.sessionId, pickAcc.x, pickAcc.y);
  const picked = await waitFor(async () => { const r = await evaluate(pick.sessionId, 'signedIn'); return r.password && r; }, 8000);
  check(picked?.user === 'breakglass@contoso.onmicrosoft.com' && !picked?.wrongTile, `Kontoauswahl: falsches Konto (${JSON.stringify(picked)})`);
  pageErrors(pick.sessionId, 'ms-pick');

  // Microsoft account with a passkey only: on the password page Keevault takes "face, fingerprint, PIN or security
  // key" – never "Sign in" with an empty password. Started as the remembered account (automatic after the countdown).
  const pkSaved = await sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Microsoft Passkey', username: 'passkey@contoso.onmicrosoft.com', password: '', urls: ['https://login.microsoftonline.com/'] } });
  const remembered = await evaluate(options.sessionId, 'chrome.storage.local.get("msDefault").then((r) => r.msDefault || null)');
  await evaluate(options.sessionId, `chrome.storage.local.set({ msDefault: ${JSON.stringify(`${personal.id}/${pkSaved?.id}`)} }).then(() => true)`);
  const pkOnly = await open(`http://login.microsoftonline.com:${server.address().port}/mspk`);
  const pkState = await waitFor(async () => { const r = await evaluate(pkOnly.sessionId, 'signedIn'); return (r.fido || r.emptySubmit) && r; }, 12000);
  check(pkState?.user === 'passkey@contoso.onmicrosoft.com' && pkState?.fido && !pkState?.emptySubmit, `Nur Passkey: kein Wechsel zum Passkey (${JSON.stringify(pkState)})`);
  pageErrors(pkOnly.sessionId, 'ms-passkey');

  // Microsoft account with a password AND a passkey: the passkey comes first and is used without a click (the user
  // started this sign-in); "Stay signed in?" afterwards on login.microsoft.com (another origin) gets "No".
  const msPort = server.address().port;
  const beforeKeys = new Set((await sw(options.sessionId, 'items')).map((x) => x.key));
  const wa = await open(`http://login.microsoftonline.com:${msPort}/mswa`);
  await sleep(800);
  await evaluate(wa.sessionId, 'startCreate(), true');
  const waSave = await waitFor(() => shadowNode(wa.sessionId, 'kvpwsafe-ui', '.kvtag .primary'));
  check(waSave, `Microsoft-Passkey: Leiste zum Speichern fehlt (${await evaluate(wa.sessionId, 'JSON.stringify({ secure: isSecureContext, results })')})`);
  if (waSave) await clickNode(wa.sessionId, '.kvtag .primary');
  check(await waitFor(async () => (await evaluate(wa.sessionId, 'results')).create === 'resolved', 8000), 'Microsoft-Passkey: nicht angelegt');
  const msPk = await waitFor(async () => (await sw(options.sessionId, 'items')).find((x) => !beforeKeys.has(x.key) && (x.hosts || []).includes('login.microsoftonline.com')), 8000);
  check(msPk, 'Microsoft-Passkey: Eintrag fehlt');
  if (msPk) {
    const full = await sw(options.sessionId, 'item', { containerId: msPk.containerId, id: msPk.id });
    await sw(options.sessionId, 'save', { containerId: msPk.containerId, item: { ...full, username: 'smoke@example.com', password: 'Pw-not-used' } });
    await evaluate(options.sessionId, `chrome.storage.local.set({ msDefault: ${JSON.stringify(msPk.key)} }).then(() => true)`);
    const both = await open(`http://login.microsoftonline.com:${msPort}/mspk?2`);
    const bothState = await waitFor(async () => { const r = await evaluate(both.sessionId, 'signedIn'); return r?.staySignedIn && r; }, 15000);
    const bothFinal = bothState || await evaluate(both.sessionId, 'JSON.stringify({ url: location.href, signedIn })');
    check(bothState?.passkey === 'resolved' && bothState?.staySignedIn === 'no', `Passkey und Passwort: Passkey nicht automatisch oder „Angemeldet bleiben?“ nicht mit Nein beantwortet (${JSON.stringify(bothFinal)})`);
    pageErrors(both.sessionId, 'ms-passkey-auto');
  }
  await evaluate(options.sessionId, `chrome.storage.local.set({ msDefault: ${JSON.stringify(remembered)} }).then(() => true)`);

  // Signing out (Microsoft's logout page, account tiles like a sign-in): no bar and no automatic sign-in (#9).
  const out = await open(`http://login.microsoftonline.com:${server.address().port}/common/oauth2/logout?post_logout_redirect_uri=x`);
  await sleep(5000);
  const outState = await evaluate(out.sessionId, 'JSON.stringify({ bar: !!document.querySelector("kvpwsafe-ui"), user: signedIn.user || null })');
  check(outState === JSON.stringify({ bar: false, user: null }), `Abmelden: Keevault bietet trotzdem eine Anmeldung an (${outState})`);
  pageErrors(out.sessionId, 'ms-logout');

  // After signing out Microsoft returns to its sign-in page: the remembered account must not start by itself (it would
  // sign straight in again); choosing an account in the bar still works and ends the pause.
  const back = await open(`http://login.microsoftonline.com:${server.address().port}/ms?4`);
  await sleep(6000);
  const backState = await evaluate(back.sessionId, 'JSON.stringify({ user: signedIn.user || null })');
  check(backState === JSON.stringify({ user: null }), `Nach dem Abmelden: gemerktes Konto meldet sich wieder an (${backState})`);
  const backAcc = await barPoint(back.sessionId, firstAccount);
  check(backAcc, 'Nach dem Abmelden: Leiste ohne Konten');
  if (backAcc) await tap(back.sessionId, backAcc.x, backAcc.y);
  check(await waitFor(async () => (await evaluate(back.sessionId, 'signedIn')).password, 8000), 'Nach dem Abmelden: Anmeldung per Klick in der Leiste geht nicht');
  pageErrors(back.sessionId, 'ms-after-logout');

  // Sophos login with MFA: filling in the browser types the password followed by the current one-time code into the
  // password field (the portal wants both in one); the entry's own password stays unchanged.
  const sophosItem = await sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Sophos VPN', username: 'vpnuser',
    password: 'Vpn-Pass-1', totp: 'JBSWY3DPEHPK3PXP', sophos: true, portals: [{ label: 'VPN-Portal', url: `${origin}/sophos` }] } });
  const sop = await open(`${origin}/sophos`);
  await sleep(1000);
  const sopTab = await evaluate(options.sessionId, 'chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url || "").includes("/sophos"))?.id)');
  await sw(options.sessionId, 'fill', { tabId: sopTab, containerId: personal.id, id: sophosItem?.id });
  const sv = await waitFor(async () => { const r = await evaluate(sop.sessionId, '({ user: document.getElementById("username").value, pw: document.getElementById("password").value })'); return r.pw && r; }, 5000);
  check(sv?.user === 'vpnuser' && /^Vpn-Pass-1\d{6}$/.test(sv?.pw || ''), `Sophos: Passwort und Einmalcode nicht zusammen eingetragen (${sv?.user} / ${(sv?.pw || '').replace(/\d{6}$/, '······')})`);
  const sophosFull = await sw(options.sessionId, 'item', { containerId: personal.id, id: sophosItem?.id });
  check(sophosFull?.password === 'Vpn-Pass-1' && sophosFull?.portals?.[0]?.label === 'VPN-Portal', 'Sophos: Eintrag (Passwort oder Portal) verändert');
  pageErrors(sop.sessionId, 'sophos');

  // Linked login: an entry that signs in with another login (here the domain login) fills that one's user name and
  // password into the page – the entry itself stores none.
  const domainItem = await sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Domain-Login', username: 'CONTOSO\\smoke', password: 'Dom-Smoke-1' } });
  const linkedItem = await sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Intranet', urls: [`${origin}/linked`], loginLink: `${personal.id}/${domainItem?.id}` } });
  const lk = await open(`${origin}/linked`);
  await sleep(1000);
  const lkTab = await evaluate(options.sessionId, 'chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url || "").includes("/linked"))?.id)');
  await sw(options.sessionId, 'fill', { tabId: lkTab, containerId: personal.id, id: linkedItem?.id });
  const lv = await waitFor(async () => { const r = await evaluate(lk.sessionId, '({ user: document.querySelector("input[autocomplete=username]").value, pw: document.querySelector("input[type=password]").value })'); return r.pw && r; }, 5000);
  check(lv?.user === 'CONTOSO\\smoke' && lv?.pw === 'Dom-Smoke-1', `Verknüpfter Login: nicht mit dem Domain-Login ausgefüllt (${lv?.user})`);
  const linkedFull = await sw(options.sessionId, 'item', { containerId: personal.id, id: linkedItem?.id });
  check(!linkedFull?.password && !linkedFull?.username, 'Verknüpfter Login: eigene Anmeldedaten gespeichert');
  pageErrors(lk.sessionId, 'linked-login');
  // The demo vault has the free limit of 10 entries: the test entries go again before the import below.
  for (const it of [sophosItem, linkedItem, domainItem]) if (it?.id) await sw(options.sessionId, 'delete', { containerId: personal.id, id: it.id });

  // Import of the sample CSV.
  const before = (await sw(options.sessionId, 'items')).length;
  const imported = await evaluate(options.sessionId, `Promise.all([import('/core/importer.js'), import('/core/import-sample.js')])
    .then(([imp, sample]) => imp.parseImport({ name: 'sample.csv', text: sample.SAMPLE_CSV }))
    .then((r) => chrome.runtime.sendMessage({ cmd: 'import', containerId: ${JSON.stringify(personal.id)}, items: r.items }))
    .then((r) => (r.result.imported || JSON.stringify(r.result.errors || r.error || r).slice(0, 300)))`);
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
