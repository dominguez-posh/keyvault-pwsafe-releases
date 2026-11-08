import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page, script } from './fixtures/content-page.js';
import vm from 'node:vm';

// Clickjacking (#373): the page makes the menu transparent or covers it, a real click lands on it unseen.
const fills = async (p) => { await flush(); return p.sent.filter((c) => c === 'cs:fill').length; };
const openMenu = async () => {
  const p = page();
  p.press(p.field);
  await flush();
  assert.equal(p.opened(), true);
  return p;
};

test('field menu #373: asks the browser about real visibility of the menu itself', async () => {
  const p = await openMenu();
  assert.equal(p.watcher().options.trackVisibility, true);
  assert.equal(p.watcher().options.delay, 100);
  assert.equal(p.watcher().target.className, 'menu');
});

test('field menu #373: a real click on a menu the browser never called visible fills nothing', async () => {
  const p = await openMenu();
  p.wait(5000);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'no report yet');
  p.browserSays(false);
  p.wait(5000);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'covered or transparent');
});

test('field menu #373: a menu that just appeared takes no click', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'at once');
  p.wait(499);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'just before the time is up');
});

test('field menu #373: covered in between, the time starts over', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.wait(5000);
  p.browserSays(false);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'covered right now');
  p.browserSays(true);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'visible again only just now');
  p.wait(500);
  p.clickEntry();
  assert.equal(await fills(p), 1);
});

test('field menu #373: visible long enough, a real click fills, a synthetic one still does not', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.wait(500);
  p.clickEntry({ isTrusted: false });
  assert.equal(await fills(p), 0, 'synthetic click');
  p.clickEntry();
  assert.equal(await fills(p), 1);
});

test('field menu #373: moved by the page after the time, the click counts as on a menu that just appeared', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.wait(5000);
  p.menu().left = 300; // transform: translate(), no new report of the browser
  p.clickEntry();
  assert.equal(await fills(p), 0, 'moved under the pointer');
  p.wait(499);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'time starts over');
  p.wait(1);
  p.clickEntry();
  assert.equal(await fills(p), 1, 'stays there: as good as a new menu');
});

test('field menu #373: clip-path or mask on the menu, the host or an ancestor refuses the click', async () => {
  for (const style of [{ clipPath: 'inset(100%)' }, { maskImage: 'linear-gradient(transparent, transparent)' }, { webkitMaskImage: 'url(x.png)' }]) {
    const p = await openMenu();
    p.browserSays(true);
    p.wait(5000);
    const body = { nodeType: 1, computed: style };
    p.menu().parentNode = { host: { nodeType: 1, computed: {}, parentElement: body } };
    p.clickEntry();
    assert.equal(await fills(p), 0, JSON.stringify(style));
    body.computed = { clipPath: 'none', maskImage: 'none' };
    p.clickEntry();
    assert.equal(await fills(p), 0, 'taken away only just now: as good as a new menu');
    p.wait(500);
    p.clickEntry();
    assert.equal(await fills(p), 1, 'stays without it: fills');
  }
});

// Konrad F4: a check at the click alone sees nothing if the page keeps the menu away and brings it back in time.
test('field menu #373: kept out of sight and brought back under the pointer, the click refuses', async () => {
  for (const [name, away, back] of [
    ['translate', (m) => { m.left = -5000; }, (m) => { m.left = 0; }],
    ['scale from the corner', (m) => { m.width = 1; m.height = 1; }, (m) => { m.width = 100; m.height = 20; }],
  ]) {
    const p = await openMenu();
    p.browserSays(true);
    p.frame();
    away(p.menu());
    p.frame();
    p.wait(5000);
    p.frame();
    back(p.menu());
    p.frame();
    p.clickEntry();
    assert.equal(await fills(p), 0, `${name}: just back`);
    p.wait(499);
    p.frame();
    p.clickEntry();
    assert.equal(await fills(p), 0, `${name}: time starts over`);
    p.wait(1);
    p.clickEntry();
    assert.equal(await fills(p), 1, `${name}: stays there: as good as a new menu`);
  }
});

test('field menu #373: back in the same frame as the click still counts as moved', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.menu().left = -5000;
  p.frame();
  p.wait(5000);
  p.menu().left = 0; // no frame since: the check at the click has to see it
  p.clickEntry();
  assert.equal(await fills(p), 0);
});

test('field menu #373: a clip-path there from the start is refused however long it stays', async () => {
  const p = page();
  p.press(p.field);
  await flush();
  p.menu().computed = { clipPath: 'inset(100%)' };
  p.browserSays(true); // the time starts with the clip already on, so nothing ever changes
  p.frame();
  p.wait(5000);
  p.clickEntry();
  assert.equal(await fills(p), 0);
});

test('field menu #373: clip-path taken away under the pointer starts the time over', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.menu().computed = { clipPath: 'inset(100%)' };
  p.frame();
  p.wait(5000);
  p.frame();
  p.menu().computed = {};
  p.frame();
  p.clickEntry();
  assert.equal(await fills(p), 0);
});

test('field menu #373: a menu that stays partly outside the window refuses, however long it was there', async () => {
  for (const [name, part] of [['left', (m) => { m.left = -10; }], ['top', (m) => { m.top = -10; }], ['right', (m) => { m.left = 950; }], ['bottom', (m) => { m.top = 790; }]]) {
    const p = await openMenu();
    p.browserSays(true);
    part(p.menu());
    p.frame();
    p.wait(5000);
    p.frame();
    p.clickEntry();
    assert.equal(await fills(p), 0, name);
    p.wait(5000);
    p.clickEntry();
    assert.equal(await fills(p), 0, `${name}: a second click after the time as well`);
  }
});

test('field menu #373: the browser reports the menu partly out of the top window (a parent moved the frame)', async () => {
  const p = await openMenu();
  assert.deepEqual([...p.watcher().options.threshold], [0.99]);
  p.browserSays(true, 0.5);
  p.wait(5000);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'partly outside');
  p.browserSays(true, 1);
  p.clickEntry();
  assert.equal(await fills(p), 0, 'back only just now');
  p.wait(500);
  p.clickEntry();
  assert.equal(await fills(p), 1);
});

test('field menu #373: the menu is placed fully inside the window', async () => {
  const p = page();
  p.field.getBoundingClientRect = () => ({ left: 950, top: 500, right: 1000, bottom: 520, width: 50 });
  p.press(p.field);
  await flush();
  const { style, width } = p.menu();
  assert.equal(parseFloat(style.left) + width <= 1000, true, 'right edge');
  assert.equal(parseFloat(style.maxHeight), 272, 'only the room below the field');
});

test('field menu #373: frames are watched only while the menu is open', async () => {
  const p = await openMenu();
  assert.equal(p.framesWaiting(), 1);
  p.frame();
  assert.equal(p.framesWaiting(), 1, 'goes on frame by frame');
  p.key('Escape');
  assert.equal(p.framesWaiting(), 0);
});

test('field menu #373: moved by scrolling, the new place counts and the time starts over', async () => {
  const p = await openMenu();
  p.browserSays(true);
  p.wait(5000);
  p.menu().left = 40;
  p.scroll();
  p.clickEntry();
  assert.equal(await fills(p), 0, 'just moved');
  p.wait(500);
  p.clickEntry();
  assert.equal(await fills(p), 1);
});

test('field menu #373: closing the menu ends the watching', async () => {
  const p = await openMenu();
  const watcher = p.watcher();
  p.key('Escape');
  assert.equal(watcher.gone, true);
});

test('field menu #373: without the browser API the menu fills nothing', async () => {
  const guard = vm.runInNewContext(`${script('visible-guard.js')}\nglobalThis.kvpwsafeVisibleGuard({})`, { globalThis: {}, Date });
  assert.equal(guard.clear(), false);
  assert.doesNotThrow(() => guard.stop());
});
