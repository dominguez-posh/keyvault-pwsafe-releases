import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HELLO_VERIFIED, WindowHelloGate, helloOn, helloOutput } from '../desktop/window-hello.js';

// #512: Windows Hello lifts the window lock of #507 besides the app PIN. The flow with a simulated Windows Hello runs in
// the desktop smoke (desktop/main/smoke-window-hello.js, area "pin"); a real Windows Hello dialog is never part of a test.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** WinRT id of a parameterized interface (SHA-1 over the WinRT namespace id and the signature, as version 5). */
function pinterfaceIid(signature) {
  const ns = Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex');
  const d = createHash('sha1').update(Buffer.concat([ns, Buffer.from(signature, 'utf8')])).digest().subarray(0, 16);
  d[6] = (d[6] & 0x0f) | 0x50;
  d[8] = (d[8] & 0x3f) | 0x80;
  const x = d.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

test('#512: the helper asks Windows Hello through the right interface ids', () => {
  const cs = read('windows/Setup/Hello.cs');
  const op = '{9fc2b0bb-e446-44e2-aa61-9cab8f636af2}'; // IAsyncOperation`1
  const result = pinterfaceIid(`pinterface(${op};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))`);
  const availability = pinterfaceIid(`pinterface(${op};enum(Windows.Security.Credentials.UI.UserConsentVerifierAvailability;i4))`);
  assert.match(cs, new RegExp(`IidOpResult = new Guid\\("${result}"\\)`));
  assert.match(cs, new RegExp(`IidOpAvailability = new Guid\\("${availability}"\\)`));
  // The message comes on stdin, never on the command line; the app window owns the dialog.
  assert.match(cs, /Console\.OpenStandardInput\(\)/);
  assert.match(read('windows/Setup/Program.cs'), /if \(args\.Has\("hello-verify"\)\) return Hello\.Verify\(args\.Get\("hello-verify"\)\);/);
});

test('#512: on only when the user switched it on and a PIN is set; the helper answer is read strictly', () => {
  const pin = { hash: 'h' };
  assert.equal(helloOn({ windowHello: true, appPin: pin }, true), true);
  assert.equal(helloOn({ windowHello: true, appPin: pin }, false), false, 'a preset of the organization file does not switch it on');
  assert.equal(helloOn({ windowHello: true, appPin: null }, true), false, 'never without the PIN as fallback');
  assert.equal(helloOn({ windowHello: 'true', appPin: pin }, true), false);
  assert.equal(helloOutput(0, '{"result":0}', 'result'), 0);
  assert.equal(helloOutput(0, '{"result":6}\n', 'result'), 6);
  assert.equal(helloOutput(1, '{"result":0}', 'result'), null, 'a failed helper never counts');
  assert.equal(helloOutput(0, '{"result":"0"}', 'result'), null);
  assert.equal(helloOutput(0, 'verified', 'result'), null);
  assert.equal(helloOutput(0, '{"availability":0}', 'result'), null);
});

function gateWith({ on = true, results = [HELLO_VERIFIED], lock = { opened: true, windowLocked: true, epoch: 1 }, during = null } = {}) {
  const state = { ...lock };
  let asked = 0;
  const gate = new WindowHelloGate({
    on: () => (typeof on === 'function' ? on() : on),
    locked: () => ({ ...state }),
    async verify() {
      asked += 1;
      during?.(state);
      const r = results.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r() : r;
    },
  });
  return { gate, state, asked: () => asked };
}

test('#512: the gate lifts only a current window lock, only on "verified", one request at a time', async () => {
  assert.equal(await gateWith().gate.confirm(), true);
  for (const [result, name] of [[6, 'HelloCanceled'], [5, 'HelloCanceled'], [1, 'HelloUnavailable'], [2, 'HelloUnavailable'], [null, 'HelloUnavailable'], [undefined, 'HelloUnavailable'], ['0', 'HelloUnavailable'], [new Error('x'), 'HelloUnavailable']]) {
    await assert.rejects(gateWith({ results: [result] }).gate.confirm(), (e) => e.name === name, String(result));
  }
  // Off, or no window lock (normal lock screen, or the window already open): Windows Hello is not even asked.
  for (const [opts, name] of [[{ on: false }, 'HelloOff'], [{ lock: { opened: false, windowLocked: false, epoch: 1 } }, 'NotWindowLocked'],
    [{ lock: { opened: true, windowLocked: false, epoch: 1 } }, 'NotWindowLocked']]) {
    const g = gateWith(opts);
    await assert.rejects(g.gate.confirm(), (e) => e.name === name);
    assert.equal(g.asked(), 0);
  }
  // The lock changed while Windows asked: locked anew, ended, or switched off in between.
  for (const during of [(s) => { s.epoch = 2; }, (s) => { s.opened = false; s.windowLocked = false; }, (s) => { s.windowLocked = false; }]) {
    await assert.rejects(gateWith({ during }).gate.confirm(), (e) => e.name === 'HelloStale');
  }
  let enabled = true;
  await assert.rejects(gateWith({ on: () => enabled, during: () => { enabled = false; } }).gate.confirm(), (e) => e.name === 'HelloStale');
  // A second request while one is open is refused; afterwards it works again.
  let release;
  const g = gateWith({ results: [() => new Promise((r) => { release = r; }), HELLO_VERIFIED] });
  const first = g.gate.confirm();
  await assert.rejects(g.gate.confirm(), (e) => e.name === 'HelloBusy');
  release(HELLO_VERIFIED);
  assert.equal(await first, true);
  assert.equal(await g.gate.confirm(), true);
});

test('#512: the window lock stays an allowlist – only unlockWithHello is added, switching and status stay shut', () => {
  const index = read('desktop/main/api/index.js');
  const allowed = [...index.match(/WINDOW_LOCKED_API = new Set\(\[([^\]]+)\]\)/)[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(allowed.includes('unlockWithHello'));
  for (const shut of ['setWindowHello', 'helloStatus', 'setPin', 'updateSettings'].slice(0, 3)) assert.ok(!allowed.includes(shut), shut);
  assert.match(index, /\.\.\.windowHelloApi,/);
});

test('#512: Hello is checked in the main process, opens no session, gives no PIN token, changes no PIN', () => {
  const main = read('desktop/main/window-hello.js');
  const unlock = main.slice(main.indexOf('export async function unlockWindowWithHello'));
  assert.ok(unlock.indexOf('await gate.confirm()') < unlock.indexOf('setWindowLocked(false)'), 'confirmed before the lock is lifted');
  assert.doesNotMatch(unlock, /openSession|auth\.unlock|pinGuard|verifyPin|setPin|appPin|unlock\(\{/);
  assert.match(main, /export function simulateHello\(value\) \{\n\s+if \(smokeTest\) simulated = value;/, 'simulated only in the smoke test');
  assert.match(main, /if \(smokeTest\) return simulated \? simulated\.result : null;/);
  // The window gets no say: unlockWithHello takes no argument.
  const api = read('desktop/main/api/window-hello.js');
  assert.match(api, /async unlockWithHello\(\) \{\n\s+await unlockWindowWithHello\(\);/);
  // Switching on: open, PIN verified (counted), the unlock token used up, then stored. Off at any time.
  const on = api.slice(api.indexOf('async setWindowHello'), api.indexOf('async unlockWithHello'));
  assert.ok(on.indexOf('requireOpen()') < on.indexOf('await api.verifyPin('));
  assert.ok(on.indexOf('await api.verifyPin(') < on.indexOf('pinGuard.consume()'));
  assert.ok(on.indexOf('pinGuard.consume()') < on.indexOf('config.update({ windowHello: true })'));
});

test('#512: the setting changes only through setWindowHello, stays on this device and goes with the PIN', async () => {
  const { PIN_ONLY_SETTINGS } = await import('../desktop/pin.js');
  assert.ok(PIN_ONLY_SETTINGS.includes('windowHello'), 'updateSettings refuses it');
  const config = read('desktop/config.js');
  assert.match(config, /windowHello: false, \/\/ #512/);
  const syncKeys = config.slice(config.indexOf('export const SYNC_KEYS'), config.indexOf(']', config.indexOf('export const SYNC_KEYS')));
  assert.ok(syncKeys.length > 0 && !syncKeys.includes('windowHello'), 'not synced to other devices');
  assert.doesNotMatch(read('desktop/settings-file.js'), /windowHello/, 'not in the settings file');
  assert.match(read('desktop/main/api/app.js'), /config\.update\(\{ appPin: null, windowHello: false \}\)/, 'removing the PIN switches it off');
  const { lockScreenSettings } = await import('../desktop/window-lock-settings.js');
  assert.ok(!Object.hasOwn(lockScreenSettings({ windowHello: true, appPin: { hash: 'h' } }), 'windowHello'));
});

// Review Konrad (#512): the organization can forbid Windows Hello (WindowHello = 0), never force it on.
test('#512 review: an organization switches Windows Hello off, never on', async () => {
  const { parseRegExport, policyFromKeys } = await import('../desktop/policy.js');
  const root = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Keevault';
  const off = policyFromKeys(parseRegExport(`[${root}]\n"WindowHello"=dword:00000000\n`), root);
  assert.equal(off.settings.windowHello, false);
  const pin = { hash: 'h' };
  // Enforced off: not on, even when the user had switched it on before; the gate does not ask Windows Hello.
  assert.equal(helloOn({ windowHello: false, appPin: pin, enforced: ['windowHello'] }, true), false);
  assert.equal(helloOn({ windowHello: true, appPin: pin, enforced: ['windowHello'] }, true), false);
  let asked = 0;
  const gate = new WindowHelloGate({ on: () => helloOn({ windowHello: false, appPin: pin, enforced: ['windowHello'] }, true),
    locked: () => ({ opened: true, windowLocked: true, epoch: 1 }), verify: async () => { asked += 1; return HELLO_VERIFIED; } });
  await assert.rejects(gate.confirm(), (e) => e.name === 'HelloOff');
  assert.equal(asked, 0);
  const config = read('desktop/config.js');
  assert.match(config, /if \(key === 'windowHello' && this\.org\[key\] !== false\) continue;/, 'only false is enforced');
  assert.match(config, /'windowHello'\]; \/\/ #512/);
  const api = read('desktop/main/api/window-hello.js');
  const on = api.slice(api.indexOf('async setWindowHello'), api.indexOf('async unlockWithHello'));
  assert.ok(on.indexOf("enforced.includes('windowHello')") > 0 && on.indexOf("enforced.includes('windowHello')") < on.indexOf('config.update({ windowHello: true })'));
  assert.match(read('installer/policy/Keevault.admx'), /valueName="WindowHello"/);
  assert.match(read('installer/policy/Keevault-Richtlinie-Intune.ps1'), /Set-Bool 'WindowHello' \$WindowHello/);
});
