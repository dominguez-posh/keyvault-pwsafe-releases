// Live demo check and website screenshots from it: serves the built website (npm run website → website/dist/htdocs),
// opens /demo/ in headless Edge/Chrome (DevTools protocol over a pipe), fails on script errors and – with --out –
// writes screenshots in light and dark, German and English (<out>/<name>.png, <out>/dark/…, <out>/en/…).
// Usage: node scripts/demo-shots.mjs [--out=docs/images] [--browser=<path>] [--page=index.html --page-out=x.png]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = fileURLToPath(new URL('../website/dist/htdocs/', import.meta.url));
if (!existsSync(join(root, 'demo', 'desktop', 'renderer', 'index.html'))) throw new Error('Demo fehlt – erst npm run website');
const browser = arg('browser') || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
].find(existsSync);
if (!browser) throw new Error('Kein Edge/Chrome gefunden (--browser=<pfad>)');
const out = arg('out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'kvpwsafe-demo-'));
const proc = spawn(browser, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let seq = 0;
const pending = new Map();
const errors = [];
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
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  proc.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
});
const evaluate = async (sessionId, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;

/** Opens the demo in light/dark and de/en at the app's screenshot size (1200×780 at 125 %, like the app's shots). */
async function openDemo({ lang, theme }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1.25, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
  await send('Page.navigate', { url: `${origin}/demo/desktop/renderer/index.html?lang=${lang}` }, sessionId);
  for (let i = 0; i < 60; i++) {
    if (await evaluate(sessionId, 'document.querySelectorAll(".sidebar .nav").length > 2').catch(() => false)) break;
    await sleep(200);
  }
  await sleep(600);
  return { targetId, sessionId };
}

const views = {
  // The team vault with an entry open (the website's main picture).
  desktop: async (s) => {
    await evaluate(s, '[...document.querySelectorAll(".sidebar .nav")].find((n) => /Team Infrastruktur/.test(n.textContent))?.click()');
    await sleep(500);
    await evaluate(s, '[...document.querySelectorAll(".list li")].find((r) => /Monitoring/.test(r.textContent))?.click()');
    await sleep(500);
    await evaluate(s, '[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => /Grafana/.test(r.textContent))?.click() || document.querySelector(".list li.row-item[data-key]")?.click()');
    await sleep(700);
  },
};

// Smoke check: the demo renders, lists entries, opens one and edits it without script errors.
{
  const { targetId, sessionId } = await openDemo({ lang: 'de', theme: 'light' });
  const count = await evaluate(sessionId, 'document.querySelectorAll(".sidebar .nav").length');
  if (!(count > 2)) errors.push(`Demo: Seitenleiste leer (${count})`);
  await views.desktop(sessionId);
  const title = await evaluate(sessionId, 'document.querySelector(".detail-pane .item-head h2")?.textContent || ""');
  if (!/Grafana|\w/.test(title)) errors.push('Demo: kein Eintrag geöffnet');
  const saved = await evaluate(sessionId, `(async () => {
    const r = await window.pwsafe.invoke('items');
    const s = r.result.find((x) => x.title === 'Grafana');
    const item = (await window.pwsafe.invoke('item', [s.containerId, s.id])).result;
    const ok = await window.pwsafe.invoke('save', [s.containerId, { ...item, notes: 'Demo-Notiz' }, item.version]);
    return ok.ok || JSON.stringify(ok.error);
  })()`);
  if (saved !== true) errors.push(`Demo: Speichern fehlgeschlagen ${saved}`);
  await send('Target.closeTarget', { targetId });
}

if (out) {
  for (const theme of ['light', 'dark']) {
    for (const lang of ['de', 'en']) {
      for (const [name, run] of Object.entries(views)) {
        const { targetId, sessionId } = await openDemo({ lang, theme });
        await run(sessionId);
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        const dir = join(out, ...(lang === 'en' ? ['en'] : []), ...(theme === 'dark' ? ['dark'] : []));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
        console.log(`${name} ${lang} ${theme}`);
        await send('Target.closeTarget', { targetId });
      }
    }
  }
}

// --page=<path> --page-out=<png> [--page-theme=dark]: screenshot of a website page (layout checks).
if (arg('page')) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: arg('page-theme') || 'light' }] }, sessionId);
  await send('Page.navigate', { url: `${origin}/${arg('page')}` }, sessionId);
  await sleep(1500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(arg('page-out'), Buffer.from(data, 'base64'));
}

proc.kill();
server.close();
if (errors.length) {
  console.error(`DEMO FAIL\n${[...new Set(errors)].join('\n')}`);
  process.exit(1);
}
console.log('DEMO OK');
