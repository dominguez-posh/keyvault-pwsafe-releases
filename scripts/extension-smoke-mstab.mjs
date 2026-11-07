// Extension smoke, part: which tab a Microsoft sign-in belongs to (#424, #426), in the running test browser.
// h: the smoke's helpers { open, evaluate, check, sleep, waitFor, shadowNode, pageErrors, tap, findTarget, attach, origin,
// optionsSession, port }.

/** The remembered account (set before): starts by itself after a typed address, not when a foreign page opens the tab. */
export async function checkRememberedAccount(h) {
  const { open, evaluate, check, sleep, waitFor, shadowNode, pageErrors, tap, findTarget, attach, origin, port } = h;
  // A typed address: the remembered account starts by itself (open() without typed would be start_page, see below).
  const ms3 = await open(`http://login.microsoftonline.com:${port}/ms?3`, { typed: true });
  const auto = await waitFor(async () => { const r = await evaluate(ms3.sessionId, 'signedIn'); return r.password && r; }, 10000);
  check(auto?.user === 'breakglass@contoso.onmicrosoft.com', `Merken: keine automatische Anmeldung (${auto?.user})`);
  pageErrors(ms3.sessionId, 'ms-auto');
  // #372: a page of someone else sends a tab to the Microsoft sign-in: the remembered account (set above, it signs in by
  // itself when the tab comes from nowhere, see ms3) must not start; the list is offered instead.
  for (const [i, [name, markup]] of [
    ['window.open (noopener)', (u) => `<button id="kvo" style="position:fixed;left:10px;top:10px;width:200px;height:60px" onclick="window.open('${u}', '_blank', 'noopener')">x</button>`],
    ['Link target=_blank', (u) => `<a id="kvo" style="position:fixed;left:10px;top:10px;width:200px;height:60px;display:block" target="_blank" rel="noopener" href="${u}">x</a>`],
    ['eigener Tab (location)', (u) => `<button id="kvo" style="position:fixed;left:10px;top:10px;width:200px;height:60px" onclick="location.href='${u}'">x</button>`],
  ].entries()) {
    const target = `http://login.microsoftonline.com:${port}/ms?f${i}`;
    const from = await open(`${origin}/`);
    await evaluate(from.sessionId, `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup(target))}), true`);
    await tap(from.sessionId, 110, 40);
    const t = await waitFor(() => findTarget(target), 6000);
    const view = t ? (t.targetId === from.targetId ? from.sessionId : await attach(t.targetId)) : null;
    await sleep(6500); // the countdown of the remembered account is 3 s
    check(view && JSON.stringify(await evaluate(view, 'signedIn')) === '{}', `#372 ${name}: fremde Seite startet die Microsoft-Anmeldung`);
    check(view && !!(await waitFor(() => shadowNode(view, 'kvpwsafe-ui', '.banner .entry'), 4000)), `#372 ${name}: Kontenliste fehlt (die Leiste zeigt nichts an)`);
  }
}

/** #424: the account chosen in the bar of the tab whose URL contains `part` belongs to that tab only. */
export async function checkJobBoundToTab(h, part) {
  const json = await h.evaluate(h.optionsSession, `Promise.all([chrome.storage.session.get(["msJob", "kvInstance"]), chrome.tabs.query({})])
    .then(([s, ts]) => JSON.stringify({ job: s.msJob?.tab || null, mine: s.kvInstance + ":" + ts.find((x) => (x.url || "").includes(${JSON.stringify(part)}))?.id }))`);
  const r = JSON.parse(json || '{}');
  h.check(!!r.job && r.job === r.mine, `#424 Konto aus der Leiste nicht an den Tab gebunden (${json})`);
}

/**
 * #372/#426: an address handed over at program start (mail link from Outlook, the app's click) is start_page; in the
 * browser Target.createTarget is reported so. The tab may take the app's job, the remembered account (set before) never
 * starts by itself there; the list is offered. Checks the state lib/tabs.js recorded and the page itself.
 */
export async function checkStartPage(h) {
  const sp = await h.open(`http://login.microsoftonline.com:${h.port}/ms?sp`);
  const json = await h.evaluate(h.optionsSession, `chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url || "").includes("/ms?sp"))?.id)
    .then((id) => chrome.storage.session.get("tabTrust:" + id).then((s) => JSON.stringify(s["tabTrust:" + id] || null)))`);
  const state = JSON.parse(json || 'null');
  h.check(state?.ok === true && state?.auto === false, `#426 start_page im Browser: Auftrag ja, gemerktes Konto nein erwartet (${json})`);
  await h.sleep(6500); // the countdown of the remembered account is 3 s
  h.check(JSON.stringify(await h.evaluate(sp.sessionId, 'signedIn')) === '{}', '#426 start_page: gemerktes Konto meldet sich ohne Klick an');
  h.check(!!(await h.waitFor(() => h.shadowNode(sp.sessionId, 'kvpwsafe-ui', '.banner .entry'), 4000)), '#426 start_page: Kontenliste fehlt');
  h.pageErrors(sp.sessionId, 'ms-start-page');
}

/**
 * #429: a link on a trusted Microsoft page (typed address) to a foreign address that answers with a redirect to the
 * sign-in: the foreign page is never committed, the tab counts by where the navigation started – no job, no automatic
 * start of the remembered account; the list is offered.
 */
export async function checkForeignRedirect(h) {
  const login = `http://login.microsoftonline.com:${h.port}/ms?r429`;
  const portal = await h.open(`http://portal.azure.com:${h.port}/portal-429`, { typed: true });
  const link = `${h.origin}/go302?to=${encodeURIComponent(login)}`;
  await h.evaluate(portal.sessionId, `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<a id="kv429" style="position:fixed;left:10px;top:10px;width:200px;height:60px;display:block" href="${link}">x</a>`)}), true`);
  await h.tap(portal.sessionId, 110, 40);
  await h.sleep(6500); // the countdown of the remembered account is 3 s
  const json = await h.evaluate(h.optionsSession, `chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url || "").includes("/ms?r429"))?.id)
    .then((id) => chrome.storage.session.get("tabTrust:" + id).then((s) => JSON.stringify(s["tabTrust:" + id] || null)))`);
  const state = JSON.parse(json || 'null');
  h.check(state && state.ok === false && state.auto === false, `#429 Weiterleitung über fremde Seite gilt als vertraut (${json})`);
  h.check(JSON.stringify(await h.evaluate(portal.sessionId, 'signedIn')) === '{}', '#429 Weiterleitung über fremde Seite: gemerktes Konto meldet sich ohne Klick an');
  h.pageErrors(portal.sessionId, 'ms-foreign-redirect');
}
