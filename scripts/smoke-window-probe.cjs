// #377: what do the real window functions do to a window that was never shown? Not a smoke run and no app code.
// One off-screen window for about two seconds; if focus() does show it, it can take the keyboard for that moment.
// Run with the environment variable ELECTRON_RUN_AS_NODE removed:
//   node_modules\electron\dist\electron.exe scripts\smoke-window-probe.cjs
const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', path.join(os.tmpdir(), `kvpwsafe-window-probe-${process.pid}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 'data:text/html,<body style="margin:0;background:%23fff"><div style="width:100px;height:100px;background:%23c00"></div>';

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, x: -32000, y: -32000, width: 300, height: 200, frame: false, skipTaskbar: true, title: 'window probe' });
  await w.loadURL(PAGE);
  const report = async (step) => console.log(`PROBE ${step}: isVisible=${w.isVisible()} isFocused=${w.isFocused()} page=${await w.webContents.executeJavaScript('document.visibilityState')}`);
  await report('never shown');
  w.focus();
  await sleep(300);
  await report('after focus()');
  w.webContents.focus();
  await sleep(300);
  await report('after webContents.focus()');
  const image = await w.webContents.capturePage();
  console.log(`PROBE capturePage: empty=${image.isEmpty()} size=${JSON.stringify(image.getSize())}`);
  w.showInactive();
  await sleep(300);
  await report('control, after showInactive()');
  w.hide();
  await sleep(100);
  await report('after hide()');
  app.exit(0);
}).catch((e) => {
  console.error(`PROBE FAIL ${e.stack || e}`);
  app.exit(1);
});
