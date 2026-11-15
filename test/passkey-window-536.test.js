// #536: a running passkey ceremony can always be ended, and the window never waits empty and unseen. Runs the real
// desktop/main/passkey-window.js against fakes of Electron (test/fixtures/passkey-window-fakes.mjs): the page's steps are
// played through its IPC handlers. The smoke check (desktop/smoke-passkey-window.js) drives the real window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

register('./fixtures/passkey-window-loader.mjs', import.meta.url);
const fakes = await import('./fixtures/passkey-window-fakes.mjs');
const { passkeyCeremony } = await import('../desktop/main/passkey-window.js');
const { BrowserWindow, invoke, log, win } = fakes;

/** Starts a ceremony and plays the page up to the WebAuthn call: request fetched, text drawn, started. */
async function running(t) {
  const promise = passkeyCeremony({ mode: 'register', containerName: 'Test' });
  promise.catch(() => {});
  const pw = BrowserWindow.all.find((w) => w !== win);
  const id = new URL(log.loads.at(-1)).searchParams.get('id');
  const request = await invoke('passkey:request', pw.webContents, id);
  assert.equal(request.timeoutMs, 120_000);
  assert.equal(await invoke('passkey:started', pw.webContents, id), true);
  t.after(() => { win.visible = true; });
  return { promise, pw, id };
}

const ended = (why) => assert.ok(log.diag.some((l) => l === `PASSKEY ceremony register ended (${why})`), `no diag line for ${why}: ${log.diag.join(' | ')}`);

test('before WebAuthn starts the window is brought to the front, with diag lines for ready and start', async (t) => {
  const { pw, promise } = await running(t);
  assert.ok(pw.isVisible() && pw.isFocused() && pw.movedTop, 'passkey window visible, on top and focused');
  assert.ok(log.diag.includes('PASSKEY page ready (register)'));
  assert.ok(log.diag.includes('PASSKEY ceremony started (register, visible true, focused true)'));
  pw.close();
  await assert.rejects(promise);
});

test('X during a running ceremony ends it, hides the window and drops the page (cancels WebAuthn)', async (t) => {
  const { pw, promise } = await running(t);
  pw.close();
  await assert.rejects(promise, /abgebrochen/);
  assert.ok(!pw.isDestroyed() && !pw.isVisible(), 'reused window hidden, not destroyed');
  assert.equal(log.loads.at(-1), 'about:blank', 'the waiting page is replaced, which cancels its WebAuthn request');
  ended('window closed');
});

test('Esc in the passkey window ends the ceremony whatever the page does', async (t) => {
  const { pw, promise } = await running(t);
  let prevented = false;
  pw.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  await assert.rejects(promise);
  assert.ok(prevented && !pw.isVisible());
  assert.equal(log.loads.at(-1), 'about:blank');
  ended('Esc');
});

test('hiding the main window (close to tray) ends the ceremony and hides the passkey window', async (t) => {
  const { pw, promise } = await running(t);
  win.hide();
  await assert.rejects(promise);
  assert.ok(!pw.isVisible());
  ended('main window hidden');
  // The listener is gone with the ceremony: the next hide of the main window touches nothing.
  assert.equal(win.listenerCount('hide'), 0);
});

test('a ceremony that never ends is stopped after its WebAuthn timeout plus a margin', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pw, promise } = await running(t);
  let settled = false;
  promise.then(() => {}, () => { settled = true; });
  t.mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(settled, false, 'not before the WebAuthn timeout');
  t.mock.timers.tick(15_000);
  await assert.rejects(promise);
  assert.ok(!pw.isVisible());
  ended('time limit');
});

test('the page draws text and Cancel before WebAuthn, passes an abort signal and cancels on Esc', () => {
  const page = readFileSync(path.resolve(import.meta.dirname, '..', 'desktop', 'passkey', 'passkey.js'), 'utf8');
  const run = page.slice(page.indexOf('async function run()'), page.indexOf('\n}', page.indexOf('async function run()')));
  const drawn = run.indexOf('setChildren(main');
  assert.ok(drawn >= 0 && drawn < run.indexOf('await painted()') && run.indexOf('await painted()') < run.indexOf('passkeyBridge.started(id)'));
  assert.ok(run.indexOf('passkeyBridge.started(id)') < run.indexOf('await registerPrf('), 'WebAuthn only after the window was brought forward');
  assert.match(run.slice(drawn, run.indexOf('await painted()')), /onclick: cancel \}, t\('Abbrechen'\)/);
  for (const call of ['registerApprover(', 'assertApproval(', 'registerPrf(', 'evaluatePrf(']) {
    const i = run.indexOf(`await ${call}`);
    assert.match(run.slice(i, run.indexOf('\n', i)), /signal \}\)/, `${call} gets the abort signal`);
  }
  assert.match(page, /addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Escape'\) cancel\(\); \}\)/);
  assert.match(page, /function cancel\(\) \{\s*running\?\.abort\(\);/);
});

test('the page succeeding ends the ceremony without dropping it', async (t) => {
  const { pw, promise, id } = await running(t);
  const loads = log.loads.length;
  await invoke('passkey:done', pw.webContents, id, { ok: true, result: { credentialId: 'x' } });
  assert.deepEqual(await promise, { credentialId: 'x' });
  assert.equal(log.loads.length, loads, 'no navigation after success');
  assert.ok(log.diag.includes('PASSKEY ceremony register done'));
});
