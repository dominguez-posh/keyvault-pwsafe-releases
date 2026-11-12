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
async function openDemo({ lang, theme, phone }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  if (phone) {
    // A phone: narrow screen, touch, no Windows platform (the app's "frameless" window mode is for Windows only).
    await send('Emulation.setDeviceMetricsOverride', { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true }, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Linux armv81' }, sessionId);
  } else await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1.25, mobile: false }, sessionId);
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

// The personal vault "Persönlich" (#488): in the sidebar's personal slot with the cloud badge, locked, its entries hidden until
// the demo PIN shown in the unlock panel opens it; a wrong PIN does not.
for (const lang of ['de', 'en']) {
  const { targetId, sessionId } = await openDemo({ lang, theme: 'light' });
  const state = () => evaluate(sessionId, `JSON.stringify({
    row: !!document.querySelector('.personal-slot .nav-row[data-vault]'),
    name: document.querySelector('.personal-slot .nav-label')?.textContent || '',
    badge: !!document.querySelector('.personal-slot .source-badge.cloud'),
    hint: document.querySelector('.unlock-panel .demo-hint')?.textContent || '' })`).then((v) => JSON.parse(v));
  const s0 = await state();
  if (!s0.row || !/Pers/.test(s0.name)) errors.push(`Demo (${lang}): „Persönlich“ fehlt in der Seitenleiste ${JSON.stringify(s0)}`);
  if (!s0.badge) errors.push(`Demo (${lang}): Cloud-Symbol an „Persönlich“ fehlt`);
  const count = `window.pwsafe.invoke('items').then((r) => r.result.filter((x) => /personal/.test(x.containerId)).length)`;
  if ((await evaluate(sessionId, count)) !== 0) errors.push(`Demo (${lang}): „Persönlich“ zeigt Einträge, obwohl gesperrt`);
  await evaluate(sessionId, `document.querySelector('.personal-slot .nav').click()`);
  await sleep(700);
  const pin = ((await state()).hint.match(/\d{6}/) || [])[0];
  if (!pin) errors.push(`Demo (${lang}): Demo-PIN wird nicht angezeigt`);
  const unlock = (value) => evaluate(sessionId, `(async () => {
    const input = document.querySelector('.unlock-panel form input');
    input.value = ${JSON.stringify(value)};
    input.form.requestSubmit();
    await new Promise((r) => setTimeout(r, 900));
    return ${count};
  })()`);
  if ((await unlock('000000')) !== 0) errors.push(`Demo (${lang}): falsche PIN öffnet „Persönlich“`);
  if (pin) {
    const n = await unlock(pin);
    if (n < 3) errors.push(`Demo (${lang}): „Persönlich“ lässt sich mit der Demo-PIN nicht öffnen (Einträge: ${n})`);
    if (arg('personal-shot') && lang === 'de') {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(arg('personal-shot'), Buffer.from(data, 'base64'));
    }
  }
  await send('Target.closeTarget', { targetId });
}

// The demo on a phone (#438): 360×740 and 390×844, German and English. No horizontal overflow in any state, the menu is
// reachable and slides in, an entry opens as its own page and "Back" returns to the list, tap targets are at least 44 px,
// and the personal vault opens with the demo PIN. --mobile-shots=<dir> writes demo-mobil-<w>x<h>-<lang>-<state>.png.
const PHONES = [{ width: 360, height: 740 }, { width: 390, height: 844 }];
for (const phone of PHONES) {
  for (const lang of ['de', 'en']) {
    const tag = `Handy ${phone.width}×${phone.height} ${lang}`;
    console.log(tag);
    const { targetId, sessionId } = await openDemo({ lang, theme: 'light', phone });
    const ev = (expr) => evaluate(sessionId, expr);
    const shot = async (state) => {
      if (!arg('mobile-shots')) return;
      mkdirSync(arg('mobile-shots'), { recursive: true });
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(arg('mobile-shots'), `demo-mobil-${phone.width}x${phone.height}-${lang}-${state}.png`), Buffer.from(data, 'base64'));
    };
    // A real touch at the centre of the first visible element that matches (and whose text matches).
    const tap = async (selector, text = '') => {
      if (process.env.DEMO_DEBUG) console.log('  tap', selector, text);
      const pt = await ev(`(() => {
        const re = new RegExp(${JSON.stringify(text)});
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility({ visibilityProperty: true }) && re.test(e.textContent));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pt) return false;
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] }, sessionId);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
      await sleep(600);
      return true;
    };
    const overflow = (state) => ev(`(() => {
      const w = innerWidth, bad = [];
      if (document.documentElement.scrollWidth > w) bad.push('Seite ' + document.documentElement.scrollWidth);
      for (const el of document.querySelectorAll('.shell > *, .shell .list-pane > *, .shell .detail-pane > *, .shell .detail-pane .item-detail > *, dialog[open], .main-menu')) {
        if (!el.checkVisibility({ visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > w + 1 || r.left < -1)) bad.push((el.className || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      }
      for (const el of document.querySelectorAll('.list-pane, .detail-pane')) if (el.checkVisibility() && el.scrollWidth > el.clientWidth + 1) bad.push('waagerecht scrollbar in ' + el.className);
      return bad.join('; ');
    })()`).then((bad) => { if (bad) errors.push(`Demo (${tag}, ${state}): Überlauf: ${bad}`); });
    const tapSizes = (state) => ev(`(() => {
      const bad = [];
      for (const el of document.querySelectorAll('button, a[href], select, input:not([type="hidden"]), summary, [role="button"], .row-item, .nav, .folder-row')) {
        if (!el.checkVisibility({ visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
        if (el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label')?.getBoundingClientRect().height >= 44) continue;
        if (el.closest('.splitter, .drag-strip') || el.closest('button, .nav')?.contains(el) && el.closest('button, .nav') !== el) continue;
        if (Math.min(r.width, r.height) < 43.5) bad.push((el.className || el.tagName).toString().slice(0, 30) + '[' + (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 24) + '] ' + Math.round(r.width) + '×' + Math.round(r.height));
      }
      return [...new Set(bad)].slice(0, 6).join('; ');
    })()`).then((bad) => { if (bad) errors.push(`Demo (${tag}, ${state}): Tippfläche unter 44 px: ${bad}`); });

    await shot('liste');
    await overflow('Start');
    await tapSizes('Start');
    // Menu: reachable, slides in, closes after a choice
    if (!(await tap('.m-menu-btn'))) errors.push(`Demo (${tag}): Menü-Knopf nicht erreichbar`);
    else {
      const open = await ev(`(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return document.querySelector('.shell').classList.contains('m-nav-open') && r.left >= 0 && r.right <= innerWidth && r.width > 200; })()`);
      if (!open) errors.push(`Demo (${tag}): Menü klappt nicht auf`);
      await shot('menue');
      await overflow('Menü offen');
      await tapSizes('Menü offen');
      if (!(await tap('.sidebar .nav', 'Team Infrastruktur'))) errors.push(`Demo (${tag}): Tresor im Menü nicht antippbar`);
      if (await ev(`document.querySelector('.shell').classList.contains('m-nav-open')`)) errors.push(`Demo (${tag}): Menü bleibt nach der Auswahl offen`);
    }
    // Entry: open (list → detail), back (detail → list)
    if (!(await ev(`!!document.querySelector('.list li.row-item[data-key]')`))) await tap('.list li', 'Monitoring');
    if (!(await tap('.list li.row-item[data-key]'))) errors.push(`Demo (${tag}): kein Eintrag in der Liste`);
    else {
      const state = await ev(`(() => {
        const q = (s) => document.querySelector(s);
        return JSON.stringify({ detail: q('.shell').classList.contains('m-detail'), title: q('.detail-pane .item-head h2')?.textContent || '',
          listHidden: !q('.list-pane').checkVisibility(), detailShown: q('.detail-pane').checkVisibility(), back: !!q('.m-back-btn')?.checkVisibility() });
      })()`).then((v) => JSON.parse(v));
      if (!state.detail || !state.title || !state.listHidden || !state.detailShown || !state.back) errors.push(`Demo (${tag}): Eintrag öffnet nicht als eigene Seite ${JSON.stringify(state)}`);
      await shot('eintrag');
      await overflow('Eintrag');
      await tapSizes('Eintrag');
      if (!(await tap('.m-back-btn'))) errors.push(`Demo (${tag}): Zurück-Knopf nicht antippbar`);
      const back = await ev(`document.querySelector('.list-pane').checkVisibility() && !document.querySelector('.detail-pane').checkVisibility() && !document.querySelector('.shell').classList.contains('m-detail')`);
      if (!back) errors.push(`Demo (${tag}): Zurück führt nicht zur Liste`);
    }
    // Personal vault with the demo PIN
    await tap('.m-menu-btn');
    await tap('.personal-slot .nav');
    const pin = (await ev(`document.querySelector('.unlock-panel .demo-hint')?.textContent || ''`)).match(/\d{6}/)?.[0];
    if (!pin) errors.push(`Demo (${tag}): Demo-PIN wird auf dem Handy nicht angezeigt`);
    else {
      await shot('persoenlich-gesperrt');
      await overflow('Persönlich gesperrt');
      await tapSizes('Persönlich gesperrt');
      await ev(`(() => { const i = document.querySelector('.unlock-panel form input'); i.value = ${JSON.stringify(pin)}; i.form.requestSubmit(); })()`);
      await sleep(1000);
      const n = await ev(`window.pwsafe.invoke('items').then((r) => r.result.filter((x) => /personal/.test(x.containerId)).length)`);
      if (n < 3) errors.push(`Demo (${tag}): „Persönlich“ lässt sich auf dem Handy mit der Demo-PIN nicht öffnen (Einträge: ${n})`);
      await shot('persoenlich');
      await overflow('Persönlich offen');
      await tapSizes('Persönlich offen');
    }
    await send('Target.closeTarget', { targetId });
  }
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
