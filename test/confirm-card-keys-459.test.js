import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { confirmCardHtml, releaseDialogHtml } from '../desktop/release-dialog.js';
import { placeCard } from '../desktop/card-placement.js';

// #459 (Konrad's findings): runs the card page's own script against a minimal fake DOM and presses keys, so the test checks
// behaviour, not the source text. delayMs 0 makes the waiting time end on the next timer tick.
function run(html, { armed = true } = {}) {
  const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)[1];
  const listeners = {};
  const decisions = [];
  let onArmed = null;
  const el = (id) => ({ id, textContent: '', attrs: {}, on: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.on[t] = f; } });
  const nodes = { go: el('go'), no: el('no') };
  const document = { activeElement: null, body: { innerText: 'x'.repeat(100) }, getElementById: (id) => nodes[id] };
  const window = {
    addEventListener: (type, f) => { (listeners[type] ||= []).push(f); },
    releaseDialog: { ready: () => {}, decide: (yes) => decisions.push(yes), onArmed: (cb) => { onArmed = cb; } },
  };
  vm.runInNewContext(script, { document, window, setTimeout, clearTimeout, setInterval, clearInterval });
  const arm = (on) => onArmed(on);
  if (armed) arm(true);
  const key = (k, focus = null) => {
    document.activeElement = focus ? nodes[focus] : null;
    for (const f of listeners.keydown || []) f({ key: k, isTrusted: true, repeat: false });
  };
  const wait = () => new Promise((r) => setTimeout(r, 20));
  return { key, wait, arm, decisions, nodes };
}

const card = { title: 'Zugriff?', detail: 'chrome-extension://abc', go: 'Erlauben', cancel: 'Ablehnen' };

test('card: Enter after the wait confirms when the focus is not on "deny"', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 0 }));
  await p.wait();
  p.key('Enter');
  assert.deepEqual(p.decisions, [true]);
});

test('card: Enter with the focus on "deny" confirms nothing', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 0 }));
  await p.wait();
  p.key('Enter', 'no');
  assert.ok(!p.decisions.includes(true), `Enter on "deny" confirmed: ${JSON.stringify(p.decisions)}`);
});

// The browser approval (approveBrowser) uses the default card: Enter counts after the waiting time, never on "deny".
test('browser approval card: Enter before the waiting time ends does nothing, after it confirms', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 150 }));
  p.key('Enter');
  p.key('Enter', 'go');
  assert.deepEqual(p.decisions, [], 'Enter confirmed before the waiting time ended');
  await new Promise((r) => setTimeout(r, 300));
  p.key('Enter');
  assert.deepEqual(p.decisions, [true]);
});

test('browser approval card: Enter on "deny" never confirms, even after the waiting time', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 0 }));
  await p.wait();
  p.key('Enter', 'no');
  assert.ok(!p.decisions.includes(true), `Enter on "deny" confirmed: ${JSON.stringify(p.decisions)}`);
});

test('browser approval source: approveBrowser does not switch Enter off', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('async function approveBrowser'), src.indexOf('config.update({ approvedBrowsers'));
  assert.ok(call.includes('confirmInCard') && !/enter:\s*false/.test(call));
});

test('card not shown/focused: the waiting time does not run, nothing confirms', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 0 }), { armed: false });
  await p.wait();
  p.key('Enter');
  p.nodes.go.on.click({ isTrusted: true });
  assert.deepEqual(p.decisions, []);
  assert.equal(p.nodes.go.attrs['aria-disabled'], 'true');
});

test('card: losing the focus locks it again, the next focus starts the time over', async () => {
  const p = run(confirmCardHtml(card, { nonce: 'x', delayMs: 60 }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(p.nodes.go.attrs['aria-disabled'], 'false');
  p.arm(false);
  p.nodes.go.on.click({ isTrusted: true });
  assert.deepEqual(p.decisions, [], 'confirmed after losing the focus');
  p.arm(true);
  p.nodes.go.on.click({ isTrusted: true });
  assert.deepEqual(p.decisions, [], 'confirmed right after the focus came back');
  await new Promise((r) => setTimeout(r, 120));
  p.nodes.go.on.click({ isTrusted: true });
  assert.deepEqual(p.decisions, [true]);
});

const work = { x: 0, y: 0, width: 1920, height: 1040 };
test('placement: top centre over the app window inside the work area', () => {
  assert.deepEqual(placeCard({ width: 460, height: 280 }, { x: 100, y: 100, width: 1000, height: 700 }, work), { x: 370, y: 140 });
});

test('placement: a minimised (-32000) or off-screen window is pulled into the work area', () => {
  for (const ref of [{ x: -32000, y: -32000, width: 160, height: 28 }, { x: 5000, y: 3000, width: 800, height: 600 }, { x: 1800, y: 1000, width: 800, height: 600 }]) {
    const p = placeCard({ width: 780, height: 660 }, ref, work);
    assert.ok(p.x >= work.x && p.x + 780 <= work.x + work.width, `x outside: ${JSON.stringify(p)}`);
    assert.ok(p.y >= work.y && p.y + 660 <= work.y + work.height, `y outside: ${JSON.stringify(p)}`);
  }
});

test('placement: second screen with an offset, and a card larger than the work area starts at its top left', () => {
  const second = { x: -1280, y: 200, width: 1280, height: 984 };
  assert.deepEqual(placeCard({ width: 460, height: 280 }, { x: -3000, y: 0, width: 400, height: 300 }, second), { x: -1280, y: 200 });
  assert.deepEqual(placeCard({ width: 2000, height: 2000 }, work, work), { x: 0, y: 0 });
});

test('release dialog: Enter confirms nothing, Esc denies', async () => {
  const p = run(releaseDialogHtml({ setup: true, existing: 0 }, { nonce: 'x', delayMs: 0 }));
  await p.wait();
  p.key('Enter');
  assert.deepEqual(p.decisions, []);
  p.key('Escape');
  assert.deepEqual(p.decisions, [false]);
});
