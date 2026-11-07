// Smoke runs stay off the desktop (#377): a window that comes to the front can catch what someone is typing. In a smoke
// run every BrowserWindow only records what the app asks of it. The real code still runs, so "comes to the front" stays
// checkable through isVisible() and isAlwaysOnTop(). The real state is watched as well: a way past this is an error.
// Nothing here runs on import, and only boot.js turns it on: for an unpackaged --smoke-test run, never in the app.
//
// KVPWSAFE_SMOKE_DEBUG=1 logs every recorded request and its caller.
// KVPWSAFE_SMOKE_COUNTERTEST: "window" really shows a small window, the run must fail with "window visible on the
// desktop"; "front" ignores show and always-on-top, the step agentfront must fail.

export const windowViolations = [];

export function keepWindowsHidden({ BrowserWindow, app, env = process.env, log = console.log, every = 100 }) {
  const proto = BrowserWindow.prototype;
  const realIsVisible = proto.isVisible;
  const realShowInactive = proto.showInactive;
  const ignoreFront = env.KVPWSAFE_SMOKE_COUNTERTEST === 'front';
  const states = new WeakMap();
  const state = (w) => {
    if (!states.has(w)) states.set(w, { visible: false, minimized: false, top: false });
    return states.get(w);
  };
  const trace = (name) => {
    if (env.KVPWSAFE_SMOKE_DEBUG) log(`[smoke-window] ${name} ${(new Error().stack.split('\n')[3] || '').trim()}`);
  };
  const shown = (name) => function shown() {
    trace(name);
    if (!ignoreFront) Object.assign(state(this), { visible: true, minimized: false });
  };
  proto.show = shown('show');
  proto.showInactive = shown('showInactive');
  proto.restore = shown('restore');
  proto.hide = function hide() { trace('hide'); state(this).visible = false; };
  proto.minimize = function minimize() { trace('minimize'); state(this).minimized = true; };
  proto.isVisible = function isVisible() { return state(this).visible; };
  proto.isMinimized = function isMinimized() { return state(this).minimized; };
  proto.setAlwaysOnTop = function setAlwaysOnTop(on) {
    trace(`setAlwaysOnTop(${!!on})`);
    if (!ignoreFront) state(this).top = !!on;
  };
  proto.isAlwaysOnTop = function isAlwaysOnTop() { return state(this).top; };
  // The real focus() could take the keyboard. Keyboard input in the smoke test only needs the page focused.
  proto.focus = function focus() { trace('focus'); this.webContents.focus(); };
  proto.moveTop = () => {};
  proto.flashFrame = () => {};

  const scan = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && realIsVisible.call(w)) {
        const message = `window visible on the desktop: "${w.getTitle()}"`;
        if (!windowViolations.includes(message)) windowViolations.push(message);
      }
    }
  };
  setInterval(scan, every).unref?.();

  if (env.KVPWSAFE_SMOKE_COUNTERTEST === 'window') {
    app.whenReady().then(() => setTimeout(() => {
      // Off-screen and without keyboard focus: the counter-test must not disturb the desktop either.
      const w = new BrowserWindow({ show: false, x: -32000, y: -32000, width: 200, height: 100, frame: false, focusable: false, skipTaskbar: true, title: 'smoke counter-test' });
      realShowInactive.call(w);
      setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 1000);
    }, 1000));
  }
  return { scan };
}

/** The window is never shown, so a screenshot could come back empty or blank without anyone noticing. */
export function screenshotProblem(image) {
  if (image.isEmpty()) return 'screenshot: empty image';
  const pixels = image.toBitmap();
  for (let i = 4; i + 4 <= pixels.length; i += 4) {
    if (pixels.readUInt32LE(i) !== pixels.readUInt32LE(0)) return null;
  }
  return 'screenshot: blank image, all pixels are the same';
}
