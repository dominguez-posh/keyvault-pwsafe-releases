import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashPin, PinGuard } from '../desktop/pin.js';
import { PasskeyPinGate } from '../desktop/passkey-pin.js';
import { CopyPinGate } from '../desktop/copy-pin.js';
import { ExportPinGate } from '../desktop/export-pin.js';
import { HELLO_PROOF, isHelloProof, normalizeProof } from '../desktop/proof.js';
import { EXTENSION_HELLO_MAX, EXTENSION_HELLO_WAIT_MS, EXTENSION_HELLO_WINDOW_MS, HelloUnlock } from '../desktop/unlock-hello.js';

// #537 stage 4: Windows Hello as proof in the gates (passkey use, copy, export, admin mode) and the extension's
// unlockRequest. Konrad's conditions: purpose-bound and used once (each use asks Hello itself), an unlock by Hello is
// no passkey proof, cancel counts nothing, the extension's request needs the Hello wrapper and waits after a cancel.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

async function gates({ helloOn = true } = {}) {
  const s = { appPin: await hashPin('246813'), unlockKeys: { blob: 'x', hello: helloOn } };
  const guard = new PinGuard();
  const asked = [];
  let answer = 'ok';
  const hello = async (purpose) => {
    asked.push(purpose);
    if (answer === 'cancel') throw Object.assign(new Error('cancel'), { name: 'HelloCanceled' });
    return true;
  };
  const common = { settings: () => s, guard, save: () => {}, verify: async (p) => p === 'master password!!', hello };
  return {
    s, guard, asked, setAnswer: (a) => { answer = a; },
    passkey: new PasskeyPinGate(common), copy: new CopyPinGate(common), exp: new ExportPinGate(common),
  };
}

test('#537 stage 4: only { hello: true } is a Hello proof; everything else is text or nothing', () => {
  assert.equal(isHelloProof({ hello: true }), true);
  for (const p of [{ hello: 'true' }, { hello: 1 }, 'hello', null, [true], { pin: '1' }]) assert.equal(isHelloProof(p), false);
  assert.deepEqual(normalizeProof({ hello: true, extra: 'x' }), HELLO_PROOF);
  assert.equal(normalizeProof({ pin: '1' }), '');
  assert.equal(normalizeProof('1234'), '1234');
});

test('#537 stage 4: every gate asks Hello itself, once per use, with its purpose; nothing is kept for the next one', async () => {
  const g = await gates();
  assert.equal(await g.passkey.check({ hello: true }), true);
  assert.equal(await g.passkey.check({ hello: true }), true);
  await g.copy.confirm('kv-a', { hello: true });
  g.copy.require('kv-a');
  const token = await g.exp.confirm('kv-a', { hello: true });
  g.exp.consume('kv-a', token);
  assert.deepEqual(g.asked, ['passkey', 'passkey', 'copy', 'export'], 'two passkey uses, two Hello confirmations');
  assert.equal(g.guard.consume(), false, 'a gate never opens the one unlock');
  assert.ok(g.passkey.state().hello && g.passkey.state().masterPassword);
});

test('#537 stage 4: a cancelled Hello counts nothing and confirms nothing; MP still works', async () => {
  const g = await gates();
  g.setAnswer('cancel');
  await assert.rejects(g.passkey.check({ hello: true }), { name: 'HelloCanceled' });
  await assert.rejects(g.copy.confirm('kv-a', { hello: true }), { name: 'HelloCanceled' });
  assert.throws(() => g.copy.require('kv-a'), { name: 'CopyPinRequired' });
  assert.equal(g.guard.failures, 0);
  assert.equal(await g.passkey.check('master password!!'), true);
  await assert.rejects(g.passkey.check('wrong'), { name: 'PinWrong' });
  assert.equal(g.guard.failures, 1);
});

test('#537 stage 4: without a Hello function a Hello proof is refused', async () => {
  const s = { appPin: await hashPin('246813'), unlockKeys: { blob: 'x' } };
  const gate = new PasskeyPinGate({ settings: () => s, guard: new PinGuard(), save: () => {} });
  await assert.rejects(gate.check({ hello: true }), { name: 'HelloOff' });
});

function extensionHello({ wrapper = true, allowed = true } = {}) {
  let now = 1_000_000;
  const results = [];
  const cards = [];
  const logs = [];
  const order = [];
  let queueBusy = false;
  const service = {
    config: { get: () => ({ unlockKeys: { blob: 'x', hello: wrapper } }) },
    queue: async (fn) => { queueBusy = true; try { return await fn(); } finally { queueBusy = false; } },
    guard: { waitSeconds: () => 0 }, diag: (l) => logs.push(l),
    unlockWithDk: async () => true,
  };
  const x = { answerCard: true };
  const h = new HelloUnlock({ service, hello: { allowed: () => allowed, confirmExtension: async () => { cards.push(1); order.push('card'); return x.answerCard; } }, now: () => now });
  h.proveDk = async () => {
    order.push(queueBusy ? 'hello-in-queue' : 'hello');
    const r = results.shift();
    if (r) throw Object.assign(new Error(r), { name: r });
    return Buffer.alloc(32);
  };
  return Object.assign(x, { h, results, cards, logs, order, tick: (ms) => { now += ms; } });
}

test('#537 stage 4 (Konrad): unlockRequest – a Keevault card of its own before every Hello, waits, a limit, a log line', async () => {
  await assert.rejects(extensionHello({ wrapper: false }).h.unlockForExtension(), { name: 'HelloOff' }, 'no wrapper: refused');
  await assert.rejects(extensionHello({ allowed: false }).h.unlockForExtension(), { name: 'HelloOff' }, 'forbidden: refused');
  const x = extensionHello();
  assert.equal(await x.h.unlockForExtension(), true);
  assert.deepEqual(x.order, ['card', 'hello'], 'the card first, then Hello – outside the PIN queue');
  x.answerCard = false;
  await assert.rejects(x.h.unlockForExtension(), { name: 'HelloRefused' });
  assert.deepEqual(x.order, ['card', 'hello', 'card'], 'refused in the card: no Hello');
  await assert.rejects(x.h.unlockForExtension(), { name: 'HelloWait' }, 'a wait after a refusal');
  x.tick(EXTENSION_HELLO_WAIT_MS);
  x.answerCard = true;
  x.results.push('HelloUnavailable');
  await assert.rejects(x.h.unlockForExtension(), { name: 'HelloUnavailable' });
  x.tick(EXTENSION_HELLO_WAIT_MS);
  await assert.rejects(x.h.unlockForExtension(), { name: 'HelloLimit' }, `at most ${EXTENSION_HELLO_MAX} in ten minutes`);
  x.tick(EXTENSION_HELLO_WINDOW_MS);
  assert.equal(await x.h.unlockForExtension(), true, 'after the window it works again');
  assert.ok(x.logs.filter((l) => l === 'UNLOCK extension hello request').length >= 4, 'one log line per request');
  assert.ok(x.logs.every((l) => !/[A-Za-z0-9+/]{30,}/.test(l)));
});

test('#537 stage 4 (Konrad): a gate asks Hello outside the PIN queue', async () => {
  const { runProof } = await import('../desktop/proof.js');
  let inQueue = false;
  const queue = async (fn) => { inQueue = true; try { return await fn(); } finally { inQueue = false; } };
  let helloInQueue = null;
  const guard = new PinGuard();
  const r = await runProof({ hello: true }, { settings: {}, guard, save: () => {}, verify: async () => false, hello: async () => { helloInQueue = inQueue; }, purpose: 'copy' }, queue, () => 'done');
  assert.equal(r, 'done');
  assert.equal(helloInQueue, false);
});

test('#537 stage 4: wiring – bridge, Windows provider, agents and admin mode take the Hello proof; the extension only from its pages', () => {
  const browser = read('desktop/main/browser.js');
  assert.match(read('desktop/main/hello-key.js'), /go: t\('Zulassen'\), cancel: t\('Ablehnen'\), enter: false/, 'the card: no Enter');
  assert.match(read('desktop/renderer/app/requests.js'), /!e\?\.isTrusted \|\| Date\.now\(\) - shownAt < CONFIRM_DELAY_MS/, 'Windows dialog: Hello only by a real click after the delay');
  assert.match(browser, /unlockRequest: async \(\) => \{\s*if \(opened\) return true;\s*await helloUnlock\.unlockForExtension\(\);\s*await api\.unlock\(\{ entra: true, background: true \}\);/, 'opens the extension session only');
  assert.match(browser, /await passkeyPin\.check\(normalizeProof\(pin\)\);/);
  assert.match(browser, /APP_CAPS = \['passkeySign', 'copy', 'unlockRequest'/);
  assert.match(read('desktop/windows-provider.js'), /await this\.pin\.check\(normalizeProof\(decision\.pin\)\);/);
  assert.match(read('desktop/main/agents.js'), /await pinQuestions\.get\(id\)\(normalizeProof\(pin\)\);/);
  assert.match(read('desktop/main/agents.js'), /pinQuestions\.set\(id, check \|\| \(\(proof\) => passkeyPin\.check\(proof\)\)\)/);
  assert.match(read('desktop/main/api/app.js'), /if \(isHelloProof\(pin\)\) \{\s*\/\/[^\n]*\n\s*await runProof\(pin, \{[^\n]*purpose: 'admin' \}, inPinQueue, \(\) => true\);/);
  assert.match(read('desktop/main/guards.js'), /hello: \(purpose\) => helloProof\(purpose\)/);
  // The extension: unlockHello is a page command (popup), never one of the content scripts.
  const bg = read('extension/background.js');
  const pageAt = bg.indexOf("unlockHello: () => unlockVia(() => app.unlockRequest())");
  assert.ok(pageAt > 0 && !/cs:unlockHello/.test(bg));
  // #537 risk 3 (Lucas): a real click, or the one automatic start of the page itself – never a script's click.
  const popup = read('extension/popup/locked.js');
  assert.match(popup, /onclick: \(e\) => \{ if \(e\.isTrusted\) askHello\(\); \}/, 'a script click asks nothing');
  assert.match(popup, /const autoHello = !!helloButton && !error && !helloAutoTried;/, 'once per popup, not after an error');
  const bar = read('extension/pin/pin.js');
  assert.match(bar, /onclick: \(e\) => \{ if \(e\.isTrusted\) askHello\(\); \}/);
  assert.match(bar, /if \(!helloGuard\?\.clear\(\)\) \{/, 'the passkey bar: the visibility check before Hello');
});

test('Windows provider dialog: the window focus listener goes when the dialog closes (Konrad, 9f3c6f9)', () => {
  const src = readFileSync(new URL('../desktop/renderer/app/requests.js', import.meta.url), 'utf8');
  assert.match(src, /window\.addEventListener\('focus', onFocus\)/);
  // 9aeaf9b smoke: the cleanup runs on the dialog's close event and on the own close() (modal() removes the dialog).
  assert.match(src, /const cleanup = \(\) => \{\n\s+if \(cleaned\) return;\n\s+cleaned = true;\n\s+pinRequests\.remove\(reqKey\);\n\s+if \(onFocus\) window\.removeEventListener\('focus', onFocus\);/);
  assert.match(src, /dialog\.addEventListener\('close', cleanup\);\n\s+close = \(\) => \{ cleanup\(\); closeModal\(\); \};\n\s+afterShow/);
  assert.doesNotMatch(src, /window\.addEventListener\('focus', \(\) =>/);
});
