import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { page, flush } from './fixtures/content-page.js';

// #465: the app PIN is typed in the Keevault tag at the top of the page, in a frame of the extension (pin/pin.html):
// never a field in the page (#409), only for the request and tab whose tag opened it, and the PIN reaches the app only
// when the tag says the frame was really visible for a while (#373/#401). The window stays the fallback.

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const PAGE = 'chrome-extension://kv/pin/pin.html';
// runtime.getURL gives the dynamic id (use_dynamic_url) where the browser uses it; "fixed" stands for the extension id.
globalThis.chrome = { runtime: { id: 'fixed', getURL: (p) => `chrome-extension://kv/${p}` }, tabs: { sendMessage: async () => null } };
const { frameFits, pinFrameCommands, isPinPage, pinPageCommand } = await import('../extension/lib/pin-frame.js');

const req = { id: 'r1', kind: 'get', pinBar: true, tabId: 7, frameId: 0, documentId: 'doc', rpId: 'example.com' };
const frame = { tab: { id: 7 }, frameId: 3, url: `${PAGE}#r1:c|i|k`, origin: 'chrome-extension://kv' };

test('pin frame: only our page, inside the asking tab, for a sign-in offered with the PIN in the bar', () => {
  assert.equal(frameFits(req, frame, PAGE), true);
  assert.equal(frameFits(req, { ...frame, tab: { id: 8 } }, PAGE), false, 'another tab');
  assert.equal(frameFits(req, { ...frame, frameId: 0 }, PAGE), false, 'a tab or window of its own, not a frame');
  assert.equal(frameFits(req, { ...frame, url: 'chrome-extension://kv/prompt/prompt.html#get:r1' }, PAGE), false, 'another extension page');
  assert.equal(frameFits(req, { ...frame, tab: undefined }, PAGE), false);
  assert.equal(frameFits({ ...req, pinBar: false }, frame, PAGE), false, 'a request the bar did not offer with the PIN');
  assert.equal(frameFits({ ...req, kind: 'create' }, frame, PAGE), false);
  assert.equal(frameFits(null, frame, PAGE), false);
});

function commands(answer, { getFrame = async () => null } = {}) {
  const asked = [];
  const approved = [];
  const saved = [];
  let stored = { ...req };
  chrome.tabs.sendMessage = async (tabId, msg, target) => { asked.push({ tabId, msg, target }); return answer(msg); };
  const cmds = pinFrameCommands({
    loadRequest: async (id) => (id === req.id ? structuredClone(stored) : null),
    saveRequest: async (r) => { saved.push(r); stored = structuredClone(r); },
    approve: async (m) => { approved.push(m); return { done: true }; },
    pinState: async () => ({ required: true, pinSet: true }),
    getFrame,
  });
  return { cmds, asked, approved, saved };
}

const ourFrame = { ...frame, documentId: 'pin-doc' };
const approveMsg = { requestId: 'r1', containerId: 'c', itemId: 'i', credentialId: 'k', pin: '1234' };

test('pin frame: the PIN goes to the app only when the tag reports its frame as visible long enough', async () => {
  for (const answer of [() => ({ clear: false }), () => null, () => { throw new Error('no tag'); }, () => ({ clear: 'yes' })]) {
    const { cmds, approved } = commands(answer);
    await cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame);
    await assert.rejects(cmds['webauthn:pinApprove'](approveMsg, ourFrame), (e) => e.name === 'Covered');
    assert.equal(approved.length, 0);
  }
  const { cmds, asked, approved } = commands((msg) => ({ clear: msg.type === 'pinframe:clear' && msg.requestId === 'r1' }));
  await cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame);
  assert.deepEqual(await cmds['webauthn:pinApprove'](approveMsg, ourFrame), { done: true });
  assert.deepEqual(approved, [{ requestId: 'r1', containerId: 'c', itemId: 'i', credentialId: 'k', pin: '1234' }]);
  assert.deepEqual(asked[0].target, { documentId: 'doc' }, 'asks the document that made the request');
});

test('pin frame (Konrad 3): the first frame binds the request; another frame, a reload or a PIN before it gets nothing', async () => {
  const { cmds, asked, approved, saved } = commands(() => ({ clear: true }));
  await assert.rejects(cmds['webauthn:pinApprove'](approveMsg, ourFrame), /Ungültige Anfrage/, 'no PIN before the frame announced itself');
  await cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame);
  assert.deepEqual(saved.at(-1).pinFrame, { frameId: 3, documentId: 'pin-doc' });
  for (const other of [{ ...ourFrame, frameId: 4 }, { ...ourFrame, documentId: 'reloaded' }, { ...ourFrame, documentId: undefined }]) {
    await assert.rejects(cmds['webauthn:pinFrame']({ requestId: 'r1' }, other), /Ungültige Anfrage/);
    await assert.rejects(cmds['webauthn:pinApprove'](approveMsg, other), /Ungültige Anfrage/);
  }
  assert.equal(approved.length, 0);
  assert.equal(asked.filter((a) => a.msg.type === 'pinframe:ready').length, 1, 'the tag hears of one frame only');
  assert.deepEqual(await cmds['webauthn:pinApprove'](approveMsg, ourFrame), { done: true }, 'the bound frame still counts');
});

test('pin frame (Konrad 3): two frames loading at once cannot both bind', async () => {
  const { cmds } = commands(() => undefined);
  const both = await Promise.allSettled([cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame), cmds['webauthn:pinFrame']({ requestId: 'r1' }, { ...ourFrame, frameId: 5, documentId: 'x' })]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'rejected']);
});

test('pin frame (Konrad 3): where the browser reports the frame, its parent must be the frame that asked', async () => {
  const seen = [];
  const { cmds } = commands(() => ({ clear: true }), { getFrame: async (q) => { seen.push(q); return { parentFrameId: 2 }; } });
  await assert.rejects(cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame), /Ungültige Anfrage/, 'nested in another frame of the page');
  assert.deepEqual(seen[0], { tabId: 7, frameId: 3 });
  const ok = commands(() => ({ clear: true }), { getFrame: async () => ({ parentFrameId: 0 }) });
  await ok.cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame);
  assert.deepEqual(await ok.cmds['webauthn:pinApprove'](approveMsg, ourFrame), { done: true });
  const unknown = commands(() => ({ clear: true }), { getFrame: () => { throw new Error('no such frame'); } });
  await unknown.cmds['webauthn:pinFrame']({ requestId: 'r1' }, ourFrame); // not reported: the binding alone decides
});

test('pin frame (Konrad 1): the PIN page is accepted under the dynamic and the fixed id, nothing else', () => {
  assert.equal(isPinPage({ url: 'chrome-extension://kv/pin/pin.html#r1:x', origin: 'chrome-extension://kv' }), true, 'dynamic id');
  assert.equal(isPinPage({ url: 'chrome-extension://fixed/pin/pin.html#r1:x', origin: 'chrome-extension://fixed' }), true, 'fixed id');
  assert.equal(isPinPage({ url: 'chrome-extension://other/pin/pin.html#r1', origin: 'chrome-extension://other' }), false, 'another extension');
  assert.equal(isPinPage({ url: 'chrome-extension://kv/pin/pin.html.evil', origin: 'chrome-extension://kv' }), false);
  assert.equal(isPinPage({ url: 'chrome-extension://kv/popup/popup.html', origin: 'chrome-extension://kv' }), false);
  assert.equal(isPinPage({ url: 'chrome-extension://kv/pin/pin.html', origin: 'https://evil.example' }), false, 'origin and URL disagree');
  assert.equal(isPinPage({ url: 'https://kv/pin/pin.html' }), false);
  assert.equal(frameFits(req, { ...frame, url: 'chrome-extension://kv/pin/pin.html#r1' }), true, 'frameFits takes the dynamic origin');
  const dyn = { url: 'chrome-extension://kv/pin/pin.html#r1', origin: 'chrome-extension://kv', tab: { id: 7 }, frameId: 3 };
  for (const cmd of ['state', 'webauthn:pinFrame', 'webauthn:pinApprove', 'webauthn:cancel']) assert.equal(pinPageCommand(dyn, cmd), true, cmd);
  for (const cmd of ['vault:list', 'getEntry', 'settings:set', 'webauthn:approve']) assert.equal(pinPageCommand(dyn, cmd), false, cmd);
  assert.equal(pinPageCommand({ ...dyn, url: 'https://evil.example/', origin: 'https://evil.example' }, 'state'), false);
  const bg = read('background.js');
  assert.match(bg, /const fromPage = \(sender\.origin \|\| new URL\(sender\.url\)\.origin\) === PAGE_ORIGIN \|\| pinPageCommand\(sender, msg\.cmd\);/);
  assert.match(bg, /pinFrameCommands\(\{ loadRequest, saveRequest,/);
});

test('pin frame: a frame of another tab or a page with a guessed id gets nothing, not even a question to the tag', async () => {
  const { cmds, asked, approved } = commands(() => ({ clear: true }));
  await assert.rejects(cmds['webauthn:pinApprove']({ requestId: 'r1', pin: '1' }, { ...frame, tab: { id: 9 } }), /Ungültige Anfrage/);
  await assert.rejects(cmds['webauthn:pinApprove']({ requestId: 'nope', pin: '1' }, frame), /Ungültige Anfrage/);
  await assert.rejects(cmds['webauthn:pinFrame']({ requestId: 'r1' }, { ...frame, frameId: 0 }), /Ungültige Anfrage/);
  assert.equal(asked.length, 0);
  assert.equal(approved.length, 0);
});

test('pin frame: loading tells the tag it arrived (else the window takes over)', async () => {
  const { cmds, asked } = commands(() => undefined);
  assert.deepEqual(await cmds['webauthn:pinFrame']({ requestId: 'r1' }, frame), { pin: { required: true, pinSet: true }, rpId: 'example.com' });
  assert.equal(asked[0].msg.type, 'pinframe:ready');
});

const pinOffer = (extra = {}) => ({ 'cs:webauthn': { inline: { requestId: 'r', candidates: [{ containerId: 'c', itemId: 'i', credentialId: 'k', userName: 'me' }], pin: true, ui: {}, ...extra } } });

async function openTag(p) {
  p.passkeyRequest();
  await flush();
  p.browserSays(true);
  p.wait(600);
  p.click('primary');
  return p.created.find((e) => e.className === 'pinframe');
}

test('content script: "Use passkey" with the PIN opens the extension frame in the tag, no field in the page', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  assert.ok(f, 'the frame is in the tag');
  assert.equal(f.tagName, 'IFRAME');
  assert.match(f.src, /^pin\/pin\.html#r:c%7Ci%7Ck$/);
  assert.ok(!p.created.some((e) => e.tagName === 'INPUT'), 'no input element in the page');
  assert.ok(!p.sent.includes('cs:webauthnSelect'), 'nothing signed without the PIN');
});

test('content script: a covered "Use passkey" button opens no frame (#401)', async () => {
  const p = page({ replies: pinOffer() });
  p.passkeyRequest();
  await flush();
  p.browserSays(false);
  p.wait(600);
  p.click('primary');
  assert.ok(!p.created.some((e) => e.className === 'pinframe'));
});

const tick = () => new Promise((r) => setTimeout(r, 150)); // the kept click looks again every 100 ms

test('content script (#496): the first click while the tag still drops in opens the PIN field once it is really visible', async () => {
  const p = page({ replies: pinOffer() });
  p.passkeyRequest();
  await flush();
  p.click('primary'); // right away: the browser has not called the button visible yet
  await tick();
  assert.ok(!p.created.some((e) => e.className === 'pinframe'), 'nothing before it is visible');
  p.browserSays(true);
  p.wait(300);
  await tick();
  assert.ok(!p.created.some((e) => e.className === 'pinframe'), 'nor before 500 ms of it');
  p.wait(300);
  await tick();
  const f = p.created.find((e) => e.className === 'pinframe');
  assert.ok(f, 'the first click is enough');
  assert.ok(!p.sent.includes('cs:webauthnSelect'), 'nothing signed without the PIN');
});

test('content script (#496): a kept click on a tag that stays covered opens nothing and ends with the note', async () => {
  const p = page({ replies: pinOffer() });
  p.passkeyRequest();
  await flush();
  p.browserSays(false);
  p.click('primary');
  p.wait(4100);
  await tick();
  assert.ok(!p.created.some((e) => e.className === 'pinframe'));
  p.browserSays(true); // shown again later: the old click no longer counts
  p.wait(600);
  await tick();
  assert.ok(!p.created.some((e) => e.className === 'pinframe'));
});

test('content script: with the PIN the account of a running sign-in is not used on its own', async () => {
  const p = page({ replies: pinOffer({ auto: true }) });
  p.passkeyRequest();
  await flush();
  assert.ok(!p.sent.includes('cs:webauthnSelect'));
});

const ready = (p, requestId = 'r') => p.fromWorker({ type: 'pinframe:ready', requestId });

test('content script (Konrad 2): the frame stays hidden, the tag "loading", until the worker reports our page in it', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  const use = p.created.filter((e) => e.className === 'primary').at(-1);
  assert.equal(f.hidden, true, 'hidden while loading');
  assert.ok(!use.hidden);
  assert.equal(use.disabled, true, 'the button is the loading state, not clickable');
  assert.equal(use.textContent, '…');
  f.on.load(); // whatever loaded: the page may have put its own document there
  p.browserSays(true);
  p.wait(600);
  assert.equal(f.hidden, true, 'a load alone shows nothing');
  assert.ok(!f.focused, 'and gets no focus');
  assert.equal(p.fromWorker({ type: 'pinframe:clear', requestId: 'r' }).clear, false, 'not ours before the worker said so');
  ready(p, 'other');
  assert.equal(f.hidden, true, 'a report for another request shows nothing');
  ready(p);
  assert.equal(f.hidden, false);
  assert.equal(use.hidden, true);
  assert.ok(f.focused, 'focus goes in once it is shown (#405)');
});

test('content script (Konrad 2): a frame the page navigated before our page arrived is never shown', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  f.on.load(); // the page's own document
  f.on.load(); // then ours, or anything else
  ready(p);
  await flush();
  assert.equal(f.hidden, true);
  assert.ok(p.sent.includes('cs:webauthnWindow'), 'the window takes over');
});

test('content script: the tag calls its frame clear only once loaded and visible for a while (#373/#401)', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  const clear = (requestId = 'r') => p.fromWorker({ type: 'pinframe:clear', requestId }).clear;
  assert.equal(clear(), false, 'not loaded yet');
  f.on.load();
  ready(p);
  assert.equal(clear(), false, 'not seen yet');
  p.browserSays(true);
  p.wait(200);
  assert.equal(clear(), false, 'just appeared');
  p.wait(400);
  assert.equal(clear(), true);
  assert.equal(clear('other'), false, 'another request');
  p.browserSays(false);
  assert.equal(clear(), false, 'covered');
});

test('content script: a page that navigates the frame away gets the window instead', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  f.on.load();
  ready(p);
  p.browserSays(true);
  p.wait(600);
  assert.equal(p.fromWorker({ type: 'pinframe:clear', requestId: 'r' }).clear, true, 'ours, visible');
  f.on.load(); // a second document in our frame: not ours
  await flush();
  assert.equal(p.fromWorker({ type: 'pinframe:clear', requestId: 'r' }).clear, false);
  assert.ok(p.sent.includes('cs:webauthnWindow'), 'the window takes over');
});

test('content script: the answer from the app ends the frame; a cancel removes the tag', async () => {
  const p = page({ replies: pinOffer() });
  const f = await openTag(p);
  f.on.load();
  ready(p);
  p.browserSays(true);
  p.wait(600);
  assert.equal(p.fromWorker({ type: 'pinframe:clear', requestId: 'r' }).clear, true);
  p.fromWorker({ type: 'webauthn:result', requestId: 'r', error: { name: 'NotAllowedError', message: 'x' } });
  assert.equal(p.fromWorker({ type: 'pinframe:clear', requestId: 'r' }).clear, false);
  assert.ok(p.watcher().gone, 'the frame is no longer watched');
});

test('pin page: Enter only when trusted and visible, the field emptied every time and on blur, Esc cancels, PIN to the app', () => {
  const js = read('pin/pin.js');
  assert.match(js, /e\.key !== 'Enter' \|\| !e\.isTrusted/);
  assert.match(js, /pin\.value = ''; \/\/ one attempt/);
  assert.match(js, /if \(!guard\?\.clear\(\)\)/);
  assert.match(js, /addEventListener\('blur', \(\) => \{ if \(pin\) pin\.value = ''; \}\)/);
  assert.match(js, /e\.key === 'Escape'[\s\S]{0,40}cancel\(\)/);
  assert.match(js, /call\('webauthn:pinApprove', \{ requestId, containerId, itemId, credentialId, pin: typed \}\)/);
  assert.match(js, /showPinProblem\(problem, err\.message\)/, 'lockout countdown (#439)');
  assert.ok(!/postMessage|window\.parent|window\.top/.test(js), 'never talks to the page');
  assert.match(read('pin/pin.html'), /<script src="\.\.\/content\/visible-guard\.js"><\/script>/);
});

test('manifest: only the PIN page is web-accessible, only where the passkey shim runs', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepEqual(m.web_accessible_resources.map((w) => w.resources), [['pin/pin.html']]);
  const shim = m.content_scripts.find((c) => c.world === 'MAIN');
  assert.deepEqual(m.web_accessible_resources[0].matches, shim.matches);
  assert.equal(m.web_accessible_resources[0].use_dynamic_url, true, 'Konrad 1: not reachable under the fixed id, no probe for the extension');
});

test('background: with the PIN on, a passkey to offer goes to the tag marked for the PIN frame; the window otherwise', () => {
  const bg = read('background.js');
  const req = bg.slice(bg.indexOf('async function webauthnRequest'), bg.indexOf('async function inlineFor'));
  const routed = req.slice(req.indexOf('passkeyPinState()).required'));
  assert.match(routed, /request\.pinBar = found\.length > 0;\s*await saveRequest\(request\);\s*const bar = request\.pinBar && \(await inlineFor\(request\)\);\s*if \(bar\) return \{ inline: \{ \.\.\.bar, pin: true \} \};\s*await openPrompt/);
  assert.match(bg, /\.\.\.pinFrameCommands\(\{ loadRequest, saveRequest, approve: \(msg\) => webauthnApprove\(msg\)/);
});
