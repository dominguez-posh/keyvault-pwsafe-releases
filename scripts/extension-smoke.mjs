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
writeFileSync(join(extensionPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
// A Keevault installed by policy (ExtensionInstallForcelist applies to every profile, the test one included) would
// answer the page's WebAuthn relay as well and race the copy – the copy speaks on its own channel.
for (const f of ['content/webauthn-main.js', 'content/content.js']) {
  const p = join(extensionPath, f);
  writeFileSync(p, readFileSync(p, 'utf8').replace("'kvpwsafe-webauthn-v1'", "'kvpwsafe-webauthn-smoke'"));
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
    const m = await import('../core/image.js');
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
