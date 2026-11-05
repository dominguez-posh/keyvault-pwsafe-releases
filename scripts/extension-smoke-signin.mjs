// Extension smoke, part: sign-in data only for the right scheme and port (#367). Each page asks the service worker the
// way the content script does after a click, from the content script's own context. `otherPort` serves the same pages
// but is no test origin of the copy, so the real checks apply there.
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

  // Save prompt (#380): a page the entry doesn't fit hears nothing about the stored password and can't replace it.
  const captured = async (page, username, password) => (await contentCall(page.sessionId, 'cs:capture', { username, password }))?.result?.action;
  check(await captured(http, 'f2-https', 'F2-Https-1') === 'save', 'F2 Erfassung http: gleiches Passwort wird erkannt');
  check(await captured(http, 'f2-https', 'F2-Fremd-1') === 'save', 'F2 Erfassung http: Aktualisieren des https-Eintrags angeboten');
  check(await captured(foreign, 'f2-http', 'F2-Http-1') === 'save', 'F2 Erfassung Port: gleiches Passwort wird erkannt');
  check(await captured(foreign, 'f2-http', 'F2-Fremd-1') === 'save', 'F2 Erfassung Port: Aktualisieren auf fremdem Port angeboten');
  check(await captured(own, 'f2-http', 'F2-Http-1') === 'none', 'F2 Erfassung: gleiches Passwort auf der eigenen Seite nicht erkannt');
  check(await captured(own, 'f2-http', 'F2-Neu-1') === 'update', 'F2 Erfassung: Aktualisieren auf der eigenen Seite fehlt');

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
  await send('Target.closeTarget', { targetId: menuPage.targetId }).catch(() => {});

  for (const x of [httpsEntry, httpEntry, msHttpEntry]) await sw(options.sessionId, 'delete', ids(x)).catch(() => {});
  for (const p of [http, own, foreign, bastion, ms]) await send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
}
