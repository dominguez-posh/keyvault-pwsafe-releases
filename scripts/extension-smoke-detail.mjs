// Extension smoke, part: the popup's entry view works like the app's (#464) – the whole field card is the click target,
// the arrow opens a menu without copying, the version history unfolds, linked assets are listed, an entry moves with its
// assets and a passkey moves to another entry.
// Runs in the developer demo (no app): there the browser clipboard is used, so the action reads "Kopieren" (German),
// never "Sicher kopieren" – that label belongs to the copy path through the app.

/** Counts the copy commands the popup sends to the service worker. */
const countCopies = `(() => {
  if (!window.__copyCount) {
    window.__copyCount = 0;
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) => { if (m && m.cmd === 'copy') window.__copyCount++; return orig(m, ...rest); };
  }
  return true;
})()`;

export async function checkDetailCards({ evaluate, waitFor, check, shot, popup }) {
  const s = popup.sessionId;
  const ev = (code) => evaluate(s, code);
  await ev('location.reload(), true');
  await waitFor(() => ev('document.querySelectorAll(".row-item").length > 0'));
  await ev(countCopies);
  // The first entries until one has a password card.
  let card = false;
  for (let i = 0; i < 6 && !card; i++) {
    await ev(`document.querySelectorAll("li.row-item")[${i}]?.click(), true`);
    card = await waitFor(() => ev('!!document.querySelector(".view.detail .act-card")'), 3000);
    if (!card) await ev('document.querySelector(".back button")?.click(), true');
  }
  check(card, 'Popup-Eintragsansicht: keine Feldkarte (act-card)');
  if (!card) return;
  await shot(s, 'ext-popup-detail-cards');

  const pw = '[...document.querySelectorAll(".view.detail .act-card")].find((c) => c.querySelector(".secret"))';
  check(await ev(`!!(${pw})`), 'Popup-Eintragsansicht: Passwort ist keine Feldkarte');
  check(await ev(`(${pw})?.querySelector(".act-label")?.textContent === "Kopieren"`),
    'Popup ohne App-Weg: Aktion am Passwort heißt nicht „Kopieren“ (Sicher kopieren nur über die App)');
  check(await ev('!document.querySelector(".view.detail .act-card .act-label")?.textContent.includes("Sicher")'), 'Popup ohne App-Weg: „Sicher kopieren“ in der Eintragsansicht');

  // Click on the label (empty space of the card) copies; click on the arrow opens the menu and does not copy.
  const before = await ev('window.__copyCount');
  await ev(`(${pw}).querySelector("label").click(), true`);
  check(await waitFor(async () => (await ev('window.__copyCount')) === before + 1), 'Popup: Klick auf die Beschriftung kopiert nicht');
  await ev('document.querySelector(".toast, #toast")?.remove(), true');
  await ev(`(${pw}).querySelector(".act-more").click(), true`);
  check(await waitFor(() => ev('!!document.querySelector(".context-menu [role=menuitem]")')), 'Popup: Pfeil öffnet kein Menü');
  check((await ev('window.__copyCount')) === before + 1, 'Popup: Klick auf den Pfeil hat kopiert');
  check(await ev('[...document.querySelectorAll(".context-menu button")].some((b) => /großer Schrift|large type/i.test(b.textContent))'), 'Popup: Pfeil-Menü ohne „In großer Schrift anzeigen“');
  check(await ev('![...document.querySelectorAll(".context-menu button")].some((b) => /Fenster|window/i.test(b.textContent))'), 'Popup: Pfeil-Menü bietet „In Fenster eingeben“ an (gibt es im Browser nicht)');
  await shot(s, 'ext-popup-detail-menu');
  await ev('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true');
  check(await waitFor(() => ev('!document.querySelector(".context-menu")')), 'Popup: Escape schließt das Pfeil-Menü nicht');

  // Version history unfolds (the demo reads it itself; with the app the section appears when the app reports "history").
  check(await ev('!!document.querySelector(".version-toggle")'), 'Popup: Versionsverlauf fehlt');
  await ev('document.querySelector(".version-toggle")?.click(), true');
  check(await waitFor(() => ev('!document.querySelector("[data-version-timeline]")?.hidden && !!document.querySelector(".timeline-row")')), 'Popup: Versionsverlauf klappt nicht auf');

  // No passkey buttons in the view (they exist in edit mode only).
  check(await ev('!document.querySelector(".view.detail .passkey-row button")'), 'Popup: Passkey-Knöpfe in der Eintragsansicht (nur im Bearbeiten-Modus)');
  await checkMoveAndAssets({ evaluate, waitFor, check, shot, popup });
}

const send = (cmd, args) => `chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...args })}).then((r) => { if (!r.ok) throw new Error(r.error.message); return r.result; })`;
const clickBy = (selector, label) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => ${label}.test(b.textContent.trim() + (b.title || '') + (b.getAttribute('aria-label') || '')))?.click(), true`;
const rowByTitle = (title) => `[...document.querySelectorAll("li.row-item")].find((r) => r.textContent.includes(${JSON.stringify(title)}))`;

/**
 * #464: linked assets, move (with assets) and move passkey in the popup. The demo has no app: the popup then runs the same
 * core functions on the demo session (an app without the capability makes the popup hide the functions, no error – that
 * is covered by test/extension-caps-464.test.js). Works on its own entries and deletes them again.
 */
export async function checkMoveAndAssets({ evaluate, waitFor, check, shot, popup }) {
  const s = popup.sessionId;
  const ev = (code) => evaluate(s, code);
  const items = async () => JSON.parse(await ev(`(${send('items', {})}).then((r) => JSON.stringify(r.map((x) => ({ id: x.id, c: x.containerId, title: x.title }))))`));
  const state = JSON.parse(await ev(`(${send('state', {})}).then((r) => JSON.stringify({ canMove: r.canMove, canAssets: r.canAssets, canMovePasskey: r.canMovePasskey, canHistory: r.canHistory, containers: r.containers.map((c) => ({ id: c.id, name: c.name })) }))`));
  check(state.canMove && state.canAssets && state.canMovePasskey && state.canHistory, 'Popup (Demo): Verschieben/Assets/Passkey-Verschieben/Verlauf nicht freigegeben');
  const [from, to] = state.containers;
  if (!from || !to) { check(false, 'Popup: die Demo hat keine zwei Tresore für den Verschieben-Test'); return; }

  // A login used by an asset (RDP account) and the asset itself, both in the first vault.
  const login = JSON.parse(await ev(`(${send('save', { containerId: from.id, item: { type: 'login', title: 'Smoke Verschieben', username: 'move-user', password: 'Move-Pass-1!', urls: ['https://move.example'] } })}).then((r) => JSON.stringify({ id: r.id }))`));
  await ev(`(${send('save', { containerId: from.id, item: { type: 'server', title: 'Smoke Server', server: { kind: 'windows', host: 'srv.move.example', rdpLink: `${from.id}/${login.id}` } } })}).then(() => true)`);
  await ev('location.reload(), true');
  await waitFor(() => ev('document.querySelectorAll(".row-item").length > 0'));
  await ev('document.querySelector(".tabs button:nth-child(2)")?.click(), true');
  await ev('(() => { const q = document.querySelector("input[type=search]"); q.value = "Smoke"; q.dispatchEvent(new Event("input")); return true; })()');
  check(await waitFor(() => ev(`!!(${rowByTitle('Smoke Verschieben')})`)), 'Popup: Test-Login nicht in der Liste');

  // The login shows "Verknüpfte Assets anzeigen"; the dialog lists the asset, a click opens it.
  await ev(`(${rowByTitle('Smoke Verschieben')})?.click(), true`);
  check(await waitFor(() => ev('!!document.querySelector(".view.detail .linked-assets")')), 'Popup: „Verknüpfte Assets anzeigen“ fehlt bei einem Login mit Asset');
  await ev('document.querySelector(".view.detail .linked-assets")?.click(), true');
  check(await waitFor(() => ev('!!document.querySelector("dialog[open] .linked-assets-list .link-pick-row")')), 'Popup: Asset-Liste zeigt das verknüpfte Asset nicht');
  check(await ev('!!document.querySelector("dialog[open] .linked-assets-list")?.textContent.includes("Smoke Server")'), 'Popup: Asset-Liste ohne „Smoke Server“');
  await ev('document.querySelector("dialog[open] .linked-assets-list .link-pick-row")?.click(), true');
  check(await waitFor(() => ev('!document.querySelector("dialog[open]") && !!document.querySelector(".view.detail")?.textContent.includes("Smoke Server")')), 'Popup: Klick auf das Asset öffnet es nicht');
  await ev('document.querySelector(".back button")?.click(), true');
  await waitFor(() => ev(`!!(${rowByTitle('Smoke Verschieben')})`));
  await ev(`(${rowByTitle('Smoke Verschieben')})?.click(), true`);
  await waitFor(() => ev('!!document.querySelector(".view.detail .act-card")'));

  // Move: the plan lists the asset and "move along" is on; afterwards both lie in the target vault and the link points there.
  await ev(clickBy('.view.detail .actions button', '/Verschieben|Move/'));
  check(await waitFor(() => ev('!!document.querySelector("dialog[open] select[name=target]")')), 'Popup: Verschieben öffnet keinen Dialog');
  await ev(`(() => { const sel = document.querySelector("dialog[open] select[name=target]"); sel.value = ${JSON.stringify(to.id)}; sel.dispatchEvent(new Event("change")); return true; })()`);
  check(await waitFor(() => ev('!!document.querySelector("dialog[open] input[name=moveAssets]") && !!document.querySelector("dialog[open] .move-plan-row")')), 'Popup: Verschieben-Plan zeigt das Asset nicht');
  check(await ev('!!document.querySelector("dialog[open] .move-plan-row")?.textContent.includes("Smoke Server")'), 'Popup: Plan ohne „Smoke Server“');
  await shot(s, 'ext-popup-move-assets');
  await ev('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click(), true');
  check(await waitFor(async () => {
    const all = await items();
    return all.some((x) => x.title === 'Smoke Verschieben' && x.c === to.id) && all.some((x) => x.title === 'Smoke Server' && x.c === to.id);
  }, 8000), 'Popup: Eintrag und Asset liegen nach dem Verschieben nicht im Zieltresor');
  const after = await items();
  check(!after.some((x) => x.c === from.id && /^Smoke (Verschieben|Server)$/.test(x.title)), 'Popup: nach dem Verschieben bleiben Kopien im Quelltresor');
  const movedAsset = after.find((x) => x.title === 'Smoke Server');
  const movedLogin = after.find((x) => x.title === 'Smoke Verschieben');
  const link = movedAsset ? JSON.parse(await ev(`(${send('item', { containerId: to.id, id: movedAsset.id })}).then((r) => JSON.stringify(r.server.rdpLink))`)) : '';
  check(!!movedLogin && link === `${to.id}/${movedLogin?.id}`, `Popup: Verknüpfung des Assets zeigt nicht auf den verschobenen Login (${link})`);

  // Move passkey: the demo's entry with a passkey → the moved login, and back so the other checks find the seed data.
  const grafana = after.find((x) => x.title === 'Grafana');
  if (grafana && movedLogin) {
    const key = 'ZGVtby1wYXNza2V5';
    const there = await ev(`(${send('movePasskey', { from: { containerId: grafana.c, id: grafana.id }, to: { containerId: to.id, id: movedLogin.id }, credentialId: key })}).then(() => (${send('item', { containerId: to.id, id: movedLogin.id })}).then((r) => r.passkeys.length)).catch((e) => e.message)`);
    check(there === 1, `Popup: Passkey verschieben schlug fehl (${there})`);
    const gone = await ev(`(${send('item', { containerId: grafana.c, id: grafana.id })}).then((r) => r.passkeys.length)`);
    check(gone === 0, 'Popup: der Passkey ist nach dem Verschieben noch im alten Eintrag');
    await ev(`(${send('movePasskey', { from: { containerId: to.id, id: movedLogin.id }, to: { containerId: grafana.c, id: grafana.id }, credentialId: key })}).then(() => true)`);
  } else check(false, 'Popup: Grafana (Passkey) oder verschobener Login fehlt für den Passkey-Test');

  // The edit view of an entry with a passkey offers "move" (the demo reports the capability).
  if (grafana) {
    await ev('location.reload(), true');
    await waitFor(() => ev('document.querySelectorAll(".row-item").length > 0'));
    await ev('document.querySelector(".tabs button:nth-child(2)")?.click(), true');
    await waitFor(() => ev(`!!(${rowByTitle('Grafana')})`));
    await ev(`(${rowByTitle('Grafana')})?.click(), true`);
    await waitFor(() => ev('!!document.querySelector(".view.detail .act-card")'));
    await ev(clickBy('.view.detail .actions button', '/Bearbeiten|Edit/'));
    check(await waitFor(() => ev('!!document.querySelector("input[name=title]")')), 'Popup: „Bearbeiten“ öffnete kein Formular');
    check(await ev(`[...document.querySelectorAll(".passkey-row button")].some((b) => /verschieben|move/i.test(b.title + b.getAttribute("aria-label")))`), 'Popup: Passkey verschieben fehlt im Bearbeiten-Modus');
    await ev(clickBy('.passkey-row button', '/verschieben|move/i'));
    check(await waitFor(() => ev('!!document.querySelector("dialog[open] .link-pick-dialog .link-pick-row")')), 'Popup: Passkey-verschieben-Dialog ohne Zieleinträge');
    await ev('document.querySelector("dialog[open] .modal-footer .btn")?.click(), true');
  }

  // Clean up the test entries.
  for (const x of await items()) if (/^Smoke (Verschieben|Server)$/.test(x.title)) await ev(`(${send('delete', { containerId: x.c, id: x.id })}).then(() => true)`).catch(() => {});
}
