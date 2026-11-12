// Extension smoke, part: sign-in data only for the right scheme and port (#367). Each page asks the service worker the
// way the content script does after a click, from the content script's own context. `otherPort` serves the same pages
// but is no test origin of the copy, so the real checks apply there.

/** #405: once the passkey tag takes clicks, a space or Enter while typing still doesn't sign in: its button has no focus. */
/** Types into fields [id, text] with input events of the browser: a value set by script offers nothing to save (#383). */
export async function typeInto({ send, evaluate, sessionId, fields }) {
  for (const [id, text] of fields) {
    await evaluate(sessionId, `(() => { const f = document.getElementById(${JSON.stringify(id)}); f.focus(); f.select(); return true; })()`);
    await send('Input.insertText', { text }, sessionId);
  }
}

export async function keysDoNotSign({ send, sleep, check, evaluate, shadowNode, sessionId, settle }) {
  await sleep(settle);
  for (const [key, code, vk, text] of [[' ', 'Space', 32, ' '], ['Enter', 'Enter', 13, '\r']]) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, sessionId);
  }
  await sleep(600);
  check(!(await evaluate(sessionId, 'results')).get && !!(await shadowNode(sessionId, 'kvpwsafe-ui', '.kvtag .primary')), '#405 Passkey-Schild: Taste beim Tippen meldet an');
}

export async function checkSignInPages({ send, events, open, sw, waitFor, check, ext, options, personal, port, otherPort, shadowNode }) {
  const contentCall = async (sessionId, cmd, args = {}) => {
    const created = await waitFor(() => [...events].reverse().find((e) => e.sessionId === sessionId && e.method === 'Runtime.executionContextCreated' && e.params.context.origin === ext), 6000);
    if (!created) throw new Error(`Kein Kontext der Erweiterung für ${cmd}`);
    const r = await send('Runtime.evaluate', { contextId: created.params.context.id, expression: `chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...args })})`, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result.value;
  };
  const refused = (r) => r?.ok === false;
  const save = (item) => sw(options.sessionId, 'save', { containerId: personal.id, item: { type: 'login', ...item } });
  const httpsEntry = await save({ title: 'F2 https', username: 'f2-https', password: 'F2-Https-1', totp: 'JBSWY3DPEHPK3PXP', urls: ['https://shop-smoke.example/'] });
  const httpEntry = await save({ title: 'F2 http', username: 'f2-http', password: 'F2-Http-1', totp: 'JBSWY3DPEHPK3PXP', urls: [`http://router-smoke.example:${port}/`] });
  const msHttpEntry = await save({ title: 'F2 Microsoft http', username: 'f2-ms', password: 'F2-Ms-1', urls: [`http://login.microsoftonline.com:${otherPort}/`] });
  const ids = (x) => ({ containerId: personal.id, id: x.id });
  const menuHas = (r, x) => (r?.result?.items || []).some((i) => i.id === x.id);

  // Route 1, http: an entry with an https URL gives nothing to the same name over http.
  const http = await open(`http://shop-smoke.example:${port}/`);
  check(!menuHas(await contentCall(http.sessionId, 'cs:matches'), httpsEntry), 'F2 http: Feldmenü zeigt https-Eintrag auf http-Seite');
  check(refused(await contentCall(http.sessionId, 'cs:fill', ids(httpsEntry))), 'F2 http: cs:fill gibt https-Eintrag an http-Seite');
  check(refused(await contentCall(http.sessionId, 'cs:totp', ids(httpsEntry))), 'F2 http: cs:totp gibt Code an http-Seite');
  // An entry with its own http URL keeps working: this is what tells the checks above from a broken content call.
  const own = await open(`http://router-smoke.example:${port}/`);
  check(menuHas(await contentCall(own.sessionId, 'cs:matches'), httpEntry), 'F2: http-Eintrag fehlt im Feldmenü seiner eigenen Seite');
  check((await contentCall(own.sessionId, 'cs:fill', ids(httpEntry)))?.result?.password === 'F2-Http-1', 'F2: http-Eintrag füllt auf seiner eigenen Seite nicht');

  // Route 2, foreign port: the same entry on another port of the same name.
  const foreign = await open(`http://router-smoke.example:${otherPort}/`);
  check(!menuHas(await contentCall(foreign.sessionId, 'cs:matches'), httpEntry), 'F2 Port: Feldmenü zeigt Eintrag auf fremdem Port');
  check(refused(await contentCall(foreign.sessionId, 'cs:fill', ids(httpEntry))), 'F2 Port: cs:fill gibt Eintrag an fremden Port');
  check(refused(await contentCall(foreign.sessionId, 'cs:totp', ids(httpEntry))), 'F2 Port: cs:totp gibt Code an fremden Port');

  // Route 3, Bastion over http: outside the copy's test origins the bar offers nothing and hands out nothing.
  const vm = '/subscriptions/s-smoke/resourceGroups/rg-smoke/providers/Microsoft.Compute/virtualMachines/vm-smoke-f2/bastionHost';
  const bastion = await open(`http://bst-smoke.bastion.azure.com:${otherPort}${vm}`);
  const accounts = await contentCall(bastion.sessionId, 'cs:bastionAccounts');
  check(accounts?.ok && !accounts.result, `F2 Bastion: Leiste zeigt Konten über http (${(accounts?.result?.accounts || []).length})`);
  check(refused(await contentCall(bastion.sessionId, 'cs:bastionAccount', ids(httpsEntry))), 'F2 Bastion: Konto über http ausgegeben');

  // Route 4, no way around cs:msAccount: its refusal must not end in cs:fill, even for an entry with this very URL.
  const ms = await open(`http://login.microsoftonline.com:${otherPort}/ms`);
  check(refused(await contentCall(ms.sessionId, 'cs:msAccount', ids(msHttpEntry))), 'F2 Microsoft: cs:msAccount antwortet über http');
  check(refused(await contentCall(ms.sessionId, 'cs:fill', ids(msHttpEntry))), 'F2 Microsoft: Rückfall auf cs:fill gibt Anmeldedaten aus');

  // #374: no page but Microsoft's own sign-in over https sets the account that signs in by itself.
  const remembered = async () => (await send('Runtime.evaluate', { expression: 'chrome.storage.local.get("msDefault").then((r) => r.msDefault ?? null)', awaitPromise: true, returnByValue: true }, options.sessionId)).result.value;
  const rememberedBefore = await remembered();
  for (const [name, page] of [['fremde Seite', own], ['Microsoft über http', ms]]) {
    await contentCall(page.sessionId, 'cs:msRemember', { key: 'smoke/f2' });
    check(await remembered() === rememberedBefore, `#374 cs:msRemember: ${name} setzt das automatische Konto`);
  }

  // Save prompt (#380): a page the entry doesn't fit hears nothing about the stored password and can't replace it.
  const captured = async (page, username, password) => (await contentCall(page.sessionId, 'cs:capture', { username, password }))?.result?.action;
  check(await captured(http, 'f2-https', 'F2-Https-1') === 'save', 'F2 Erfassung http: gleiches Passwort wird erkannt');
  check(await captured(http, 'f2-https', 'F2-Fremd-1') === 'save', 'F2 Erfassung http: Aktualisieren des https-Eintrags angeboten');
  check(await captured(foreign, 'f2-http', 'F2-Http-1') === 'save', 'F2 Erfassung Port: gleiches Passwort wird erkannt');
  check(await captured(foreign, 'f2-http', 'F2-Fremd-1') === 'save', 'F2 Erfassung Port: Aktualisieren auf fremdem Port angeboten');
  check(await captured(own, 'f2-http', 'F2-Http-1') === 'none', 'F2 Erfassung: gleiches Passwort auf der eigenen Seite nicht erkannt');
  check(await captured(own, 'f2-http', 'F2-Neu-1') === 'update', 'F2 Erfassung: Aktualisieren auf der eigenen Seite fehlt');

  // Clickjacking (#411): the page makes the bar transparent, a real click on "Update" must not replace the password. The
  // click on the visible bar after that tells this check from a bar that never saves.
  await send('Page.bringToFront', {}, own.sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, own.sessionId);
  const ownPause = (ms) => new Promise((r) => setTimeout(r, ms));
  const inOwn = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, own.sessionId)).result.value;
  const stored = async () => (await contentCall(own.sessionId, 'cs:fill', ids(httpEntry)))?.result?.password;
  const clickUpdate = async () => {
    // #490: the bar slides in: click only once its button stands still (same box twice, 200 ms apart), not at a guessed time.
    const box = async () => (await send('DOM.getBoxModel', { nodeId: await shadowNode(own.sessionId, 'kvpwsafe-ui', '.banner .b.primary') }, own.sessionId)).model.border.join(',');
    let model = null;
    for (let i = 0, last = ''; i < 30 && !model; i++) {
      const now = await box().catch(() => '');
      if (now && now === last) model = { border: now.split(',').map(Number) };
      last = now;
      if (!model) await ownPause(200);
    }
    if (!model) return check(false, '#411 Speichern-Leiste: die Schaltfläche kam nicht zur Ruhe');
    const [x, y] = [(model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2];
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, own.sessionId);
    await ownPause(1500);
  };
  check(!!(await waitFor(() => shadowNode(own.sessionId, 'kvpwsafe-ui', '.banner .b.primary'), 6000)), '#411 Speichern-Leiste erschien nicht');
  await inOwn('(() => { const st = document.createElement("style"); st.id = "cj"; st.textContent = "kvpwsafe-ui { opacity: 0 !important; }"; document.head.append(st); return true; })()');
  await ownPause(1200);
  await clickUpdate();
  check(await stored() === 'F2-Http-1', '#411 Speichern-Leiste: Klick auf durchsichtige Leiste überschreibt das Passwort');
  await inOwn('document.getElementById("cj").remove(), true');
  await ownPause(1200);
  await clickUpdate();
  await waitFor(async () => (await stored()) === 'F2-Neu-1', 6000); // the save goes through the extension: wait for it, not a pause
  check(await stored() === 'F2-Neu-1','#411 Speichern-Leiste: Klick auf sichtbare Leiste speichert nicht');

  // Confirmed fill (#412): the tab has moved on from the origin in the confirmation, nothing goes there. The right origin
  // tells this from a fill that never works.
  const ownTab = (await send('Runtime.evaluate', { expression: `chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url || "").startsWith("http://router-smoke.example:${port}"))?.id)`, awaitPromise: true, returnByValue: true }, options.sessionId)).result.value;
  const ownField = async () => (await send('Runtime.evaluate', { expression: 'document.querySelector("input[autocomplete=username]").value', returnByValue: true }, own.sessionId)).result.value;
  const forced = (origin) => sw(options.sessionId, 'fill', { tabId: ownTab, ...ids(httpsEntry), force: true, origin }).then(() => true, () => false);
  check(!(await forced('https://shop-smoke.example')), '#412 Bestätigung: Füllen trotz anderem Ursprung');
  check(!(await forced('')), '#412 Bestätigung: Füllen ohne bestätigten Ursprung');
  check(await ownField() === '', '#412 Bestätigung: Feld gefüllt trotz anderem Ursprung');
  check(await forced(`http://router-smoke.example:${port}`), '#412 Bestätigung: Füllen mit bestätigtem Ursprung schlägt fehl');
  await send('Runtime.evaluate', { expression: 'document.querySelector("input[autocomplete=username]").value = "", true' }, own.sessionId);

  // Field menu (#380): only real input at the field opens it, whatever the page's own script does. A separate tab: the
  // save prompts above must not count as a menu. The real clicks and keys come through CDP, so they are trusted events.
  const menuPage = await open(`http://router-smoke.example:${port}/`);
  const s = menuPage.sessionId;
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
  const inPage = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, s)).result.value;
  const scriptFocus = () => inPage('document.querySelector("input[autocomplete=username]").focus(), document.activeElement.autocomplete');
  const blur = async () => { await inPage('document.activeElement?.blur(), true'); await waitFor(async () => !(await shadowNode(s, 'kvpwsafe-ui', '.menu')), 2000); };
  const closed = async () => { await new Promise((r) => setTimeout(r, 1000)); return !(await shadowNode(s, 'kvpwsafe-ui', '.menu')) && !(await inPage('(getSelection().removeAllRanges(), window.find("f2-http"))')); };
  const opened = async () => !!(await waitFor(() => shadowNode(s, 'kvpwsafe-ui', '.menu'), 4000));
  const realClick = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s); };
  const realKey = async (key, code, vk, text) => {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text }, s);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, s);
  };
  check(await scriptFocus() === 'username' && await closed(), 'F2 Feldmenü: focus() des Skripts öffnet das Menü');
  await blur();
  await realClick(600, 500);
  await scriptFocus();
  check(await closed(), 'F2 Feldmenü: Klick anderswo, dann focus() öffnet das Menü');
  await blur();
  const box = await inPage('(() => { const r = document.querySelector("input[autocomplete=username]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  await realClick(box.x, box.y);
  check(await opened(), 'F2 Feldmenü: echter Klick ins Feld öffnet nichts');
  await blur();
  await realKey('Tab', 'Tab', 9);
  check(await opened(), 'F2 Feldmenü: echte Tab-Taste öffnet nichts');
  await blur();
  await scriptFocus();
  check(await closed(), 'F2 Feldmenü: Autofokus öffnet das Menü');
  await realKey('a', 'KeyA', 65, 'a');
  check(await opened(), 'F2 Feldmenü: Taste im Feld nach Autofokus öffnet nichts');

  // Clickjacking (#373): the page hides the menu or lays something over it, a real click on the entry must not fill. The
  // last run without any of it tells these checks from a menu that never fills.
  const FIELD = 'document.querySelector("input[autocomplete=username]")';
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickEntry = async (attack = null) => {
    await blur();
    await inPage(`${FIELD}.value = "", true`);
    await realClick(box.x, box.y);
    if (!(await opened())) return 'kein Menü';
    await pause(1200); // far longer than the wait for a menu that just appeared
    if (attack) await inPage(`(() => { const st = document.createElement("style"); st.id = "cj"; st.textContent = "kvpwsafe-ui { display: block !important; ${attack} !important; }"; document.head.append(st); return true; })()`);
    const { model } = await send('DOM.getBoxModel', { nodeId: await shadowNode(s, 'kvpwsafe-ui', '.menu .entry') }, s);
    await realClick((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
    await pause(1200);
    return inPage(`${FIELD}.value`);
  };
  await inPage('(() => { const st = document.createElement("style"); st.id = "cj"; st.textContent = "kvpwsafe-ui { opacity: 0 !important; }"; document.head.append(st); return true; })()');
  const transparent = await clickEntry();
  check(transparent === '', `#373 Feldmenü: Klick auf durchsichtiges Menü füllt (${transparent ? 'Wert gesetzt' : transparent})`);
  await inPage('document.getElementById("cj").remove(), true');
  await inPage('(() => { const c = document.createElement("div"); c.id = "cj"; c.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:#fff"; document.body.append(c); return true; })()');
  const covered = await clickEntry();
  check(covered === '', `#373 Feldmenü: Klick auf verdecktes Menü füllt (${covered ? 'Wert gesetzt' : covered})`);
  await inPage('document.getElementById("cj").remove(), true');
  // Konrad M1, M2: moved after the menu's time was over; clipped or masked. The box model reads where the entry is now.
  for (const [name, attack] of [['verschoben', 'transform: translate(0, 40px)'], ['clip-path', 'clip-path: inset(0 0 0 0 round 1px)'], ['mask', 'mask-image: linear-gradient(#000, #000)']]) {
    const value = await clickEntry(attack);
    check(value === '', `#373 Feldmenü: Klick füllt, Menü ${name} (${value ? 'Wert gesetzt' : value})`);
    await inPage('document.getElementById("cj").remove(), true');
  }
  // Konrad F4: kept away by the page during the wait, back the moment the pointer is on the bait; the click comes right after.
  for (const [name, away] of [['weggeschoben', 'translate: -5000px 0 !important;'], ['verkleinert', 'transform-origin: 0 0 !important; scale: 0.01 !important;']]) {
    await blur();
    await inPage(`${FIELD}.value = "", true`);
    await realClick(box.x, box.y);
    check(await opened(), `#373 Feldmenü ${name}: kein Menü`);
    await inPage(`(() => { const st = document.createElement("style"); st.id = "cj"; st.textContent = "kvpwsafe-ui { display: block !important; ${away} }"; document.head.append(st); return true; })()`);
    await pause(1200);
    await inPage('document.getElementById("cj").remove(), true');
    const { model } = await send('DOM.getBoxModel', { nodeId: await shadowNode(s, 'kvpwsafe-ui', '.menu .entry') }, s);
    await realClick((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
    await pause(1200);
    const value = await inPage(`${FIELD}.value`);
    check(value === '', `#373 Feldmenü: Klick füllt, Menü ${name} und zurück (${value ? 'Wert gesetzt' : value})`);
  }
  // What the browser itself says about clip-path and mask (M2 was a guess): for the log, the checks above hold either way.
  const verdict = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `Promise.all(["", "clip-path:inset(100%)", "mask-image:linear-gradient(transparent,transparent)"].map((style) => new Promise((done) => {
    const d = document.createElement("div"); d.style.cssText = "position:fixed;left:0;top:0;width:50px;height:50px;background:#000;z-index:2147483646;" + style; document.body.append(d);
    const io = new IntersectionObserver((seen) => { io.disconnect(); d.remove(); done((style || "frei") + ": isVisible=" + seen.at(-1).isVisible); }, { trackVisibility: true, delay: 100 }); io.observe(d);
    setTimeout(() => done((style || "frei") + ": keine Meldung"), 2000);
  }))).then((r) => r.join("; "))` }, s);
  console.log(`[#373 M2] ${verdict.result.value}`);
  const free = await clickEntry();
  check(free === 'f2-http', `#373 Feldmenü: Klick auf sichtbares Menü füllt nicht (${free || 'leer'})`);
  await send('Target.closeTarget', { targetId: menuPage.targetId }).catch(() => {});

  for (const x of [httpsEntry, httpEntry, msHttpEntry]) await sw(options.sessionId, 'delete', ids(x)).catch(() => {});
  for (const p of [http, own, foreign, bastion, ms]) await send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
}
