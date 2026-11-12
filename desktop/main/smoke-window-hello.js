// Smoke part of #512 (area 'pin'): Windows Hello lifts the window lock of #507 besides the PIN. Windows Hello is
// simulated (simulateHello) – a test never shows the real Windows dialog. Runs with the app open and no PIN set;
// leaves it open with no PIN and Windows Hello off.

import { api } from './api/index.js';
import { config, opened, windowLocked } from './state.js';
import { browserHandlers } from './browser.js';
import { lockNow } from './session.js';
import { pinGuard } from './guards.js';
import { simulateHello } from './window-hello.js';
import { until } from '../smoke-wait.js';

const PIN = '512512';

const invoke = (js, method, args) => js(`window.pwsafe.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`)
  .then((r) => JSON.parse(r || '{}'));

/** Locked again and unlocked through the extension: the session is open for it, the window shows its lock screen. */
async function extensionOnly(sleep, js) {
  await lockNow();
  await browserHandlers.unlockPin({ pin: PIN });
  // The window redraws after the lock and again after the extension's unlock: wait for its own lock screen (#526: a fixed
  // 800 ms was too short under load). The checks after this ask again.
  await until(() => js(`!!document.querySelector('.window-unlock')`), 5000, 100);
  await sleep(300);
}

const clickHello = (js) => js(`(() => { const b = document.querySelector('.window-hello'); b?.click(); return !!b; })()`);

export async function windowHelloCheck({ js, sleep, errors }) {
  await api.setPin({ next: PIN });
  try {
    // Off by default; a settings patch from the window cannot switch it on, a wrong PIN neither.
    if (config.get().windowHello || (await api.state()).windowHello) errors.push('hello: Windows Hello on by default');
    if ((await invoke(js, 'updateSettings', [{ windowHello: true }])).ok || config.get().windowHello) errors.push('hello: switched on through updateSettings without the PIN');
    simulateHello({ availability: 0, result: 0 });
    if ((await invoke(js, 'setWindowHello', [{ on: true, pin: '000000' }])).ok || config.get().windowHello) errors.push('hello: switched on with a wrong PIN');
    const on = await invoke(js, 'setWindowHello', [{ on: true, pin: PIN }]);
    if (!on.ok || !on.result?.windowHello) errors.push(`hello: not switched on with the PIN (${on.error?.message || ''})`);
    if (pinGuard.consume()) errors.push('hello: switching it on left an unlock token behind');
    // Settings show it switched on. The PIN and the switch came through direct calls, not through the window's own
    // controls, so the window has not reloaded its state yet: reload it first (#526: whether an earlier reload happened
    // to come late enough decided the check).
    await js('window.dispatchEvent(new Event("kvpwsafe-refresh")); true');
    await sleep(600);
    await js('document.querySelector(".menu-btn")?.click(); document.querySelector(".main-menu [data-action=settings]")?.click()');
    await sleep(700);
    await js(`[...document.querySelectorAll('.settings-modal [role=tab]')].find((b) => /^\\s*Sicherheit\\s*$/.test(b.textContent))?.click()`);
    await sleep(300);
    const box = JSON.parse(await js(`JSON.stringify((() => { const b = document.querySelector('.window-hello-setting'); return b ? { checked: b.checked, disabled: b.disabled } : null; })())`) || 'null');
    if (!box?.checked || box.disabled) errors.push(`hello: settings do not show Windows Hello switched on (${JSON.stringify(box)})`);
    // #526: through its close button – a bare dialog.close() left the settings in the page, hidden, and a later area
    // found the stale copy's elements (extreinstall: button "not visible").
    await js(`document.querySelectorAll('dialog[open] .modal-head .icon-btn').forEach((b) => b.click()); true`);
    if (await js(`!!document.querySelector('.settings-modal')`)) errors.push('hello: the settings stayed in the page after closing');

    // Lock screen: the Hello button besides the PIN; refused or canceled leaves the lock and the PIN field.
    await extensionOnly(sleep, js);
    if (!(await api.state()).helloUnlock) errors.push('hello: locked window state does not offer Windows Hello');
    const screen = JSON.parse(await js(`JSON.stringify({ hello: !!document.querySelector('.window-hello'), pin: !!document.querySelector('.pin-input') })`) || '{}');
    if (!screen.hello || !screen.pin) errors.push(`hello: lock screen without Windows Hello button or PIN field (${JSON.stringify(screen)})`);
    simulateHello({ availability: 0, result: 6 }); // canceled
    await clickHello(js);
    await sleep(700);
    if (!windowLocked || !opened) errors.push('hello: a canceled Windows Hello lifted the lock or ended the session');
    if (!(await js(`!!document.querySelector('.pin-input') && /Windows Hello abgebrochen/.test(document.body.innerText)`))) errors.push('hello: canceled Windows Hello not reported on the lock screen with the PIN');
    simulateHello({ availability: 0, result: null }); // the helper gave no answer
    if ((await invoke(js, 'unlockWithHello', [])).ok || !windowLocked) errors.push('hello: no answer from Windows Hello lifted the lock');
    // The rest of the API stays shut behind the lock.
    if ((await invoke(js, 'items', [])).ok) errors.push('hello: the locked window may read entries');
    if ((await invoke(js, 'setWindowHello', [{ on: false }])).ok) errors.push('hello: the locked window changed the Windows Hello setting');
    // Verified: the window opens, no second session, no PIN token.
    simulateHello({ availability: 0, result: 0 });
    await clickHello(js);
    for (let i = 0; i < 20 && windowLocked; i++) await sleep(200);
    await sleep(500);
    if (windowLocked || !opened) errors.push('hello: Windows Hello did not lift the window lock');
    if (!(await until(() => js(`!!document.querySelector('.shell')`), 5000, 100))) /* #526: the redraw takes longer under load */ errors.push('hello: window shows no vaults after Windows Hello');
    if (pinGuard.consume()) errors.push('hello: Windows Hello left a PIN token');
    if ((await invoke(js, 'unlockWithHello', [])).ok) errors.push('hello: unlockWithHello accepted without a window lock');
    // No PIN change through Hello: setPin still wants the current PIN.
    if ((await invoke(js, 'setPin', [{ current: '', next: '999999' }])).ok) errors.push('hello: PIN changed without the current PIN');

    // Switched off: the lock screen offers only the PIN, and the call is refused.
    await api.setWindowHello({ on: false });
    await extensionOnly(sleep, js);
    if ((await api.state()).helloUnlock || await js(`!!document.querySelector('.window-hello')`)) errors.push('hello: Windows Hello offered while switched off');
    if ((await invoke(js, 'unlockWithHello', [])).ok || !windowLocked) errors.push('hello: switched off, Windows Hello still lifted the lock');
    await api.verifyPin(PIN);
    await api.unlock({ entra: true });
    if (windowLocked) errors.push('hello: PIN did not open the window after Windows Hello was switched off');
    // Review #512: the organization forbids it (WindowHello = 0) – switched on before, it no longer unlocks and cannot
    // be switched on; WindowHello = 1 forces nothing.
    await api.setWindowHello({ on: true, pin: PIN });
    config.org = { ...config.org, windowHello: true };
    if ((await api.state()).windowHello !== true || config.get().enforced.includes('windowHello')) errors.push('hello: organization value true was enforced');
    config.org = { ...config.org, windowHello: false };
    await extensionOnly(sleep, js);
    if ((await api.state()).helloUnlock) errors.push('hello: offered on the lock screen although the organization forbids it');
    if ((await invoke(js, 'unlockWithHello', [])).ok || !windowLocked) errors.push('hello: the organization forbids it, Windows Hello still lifted the lock');
    await api.verifyPin(PIN);
    await api.unlock({ entra: true });
    if ((await invoke(js, 'setWindowHello', [{ on: true, pin: PIN }])).ok) errors.push('hello: switched on although the organization forbids it');
    const { windowHello: _forbidden, ...orgRest } = config.org;
    config.org = orgRest;
    // Removing the PIN switches Windows Hello off (checked below).
    await api.setWindowHello({ on: true, pin: PIN });
  } catch (e) {
    errors.push(`hello flow: ${e.message}`);
  } finally {
    simulateHello(null);
    if (Object.hasOwn(config.org || {}, 'windowHello')) {
      const { windowHello: _left, ...rest } = config.org;
      config.org = rest;
    }
    if (!opened || windowLocked) {
      await api.verifyPin(PIN).catch(() => {});
      await api.unlock({ entra: true }).catch((e) => errors.push(`hello: unlock afterwards: ${e.message}`));
    }
    await api.setPin({ current: PIN, next: null }).catch((e) => errors.push(`hello: PIN not removed: ${e.message}`));
    if (config.get().windowHello) errors.push('hello: removing the PIN left Windows Hello on');
  }
}
