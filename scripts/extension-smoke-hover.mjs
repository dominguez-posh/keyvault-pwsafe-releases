// Extension smoke, part (#458): in the popup's entry view, "Kopieren" and the arrow of a card with one value show as soon
// as the mouse is anywhere on the card (heading, edge); a card with several addresses keeps the action per row (on its
// heading at most the first row's). Additional fields use the same card without a copy icon of their own and show their
// value; an empty one is not shown. Real mouse moves over CDP, because :hover cannot be set from script.

const sendMsg = (cmd, args) => `chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...args })}).then((r) => { if (!r.ok) throw new Error(r.error.message); return r.result; })`;
const NAMES = { user: ['Benutzername', 'User name', 'Username'], sites: ['Websites'], site: ['Website'],extra: ['Mandanten-ID'], empty: ['Primäre Domäne'], holder: ['Karteninhaber', 'Cardholder'] };
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const LONG_URL = 'https://keevault.de/hilfe/ein-sehr-langer-pfad/der-sicher-nicht-in-die-karte-passt/und-noch-weiter';
const card = (key) => `[...document.querySelectorAll(".view.detail .field-card > .field")].find((c) => ${JSON.stringify(NAMES[key])}.includes(c.querySelector(":scope > label")?.textContent.trim()))`;
const rowByTitle = (title) => `[...document.querySelectorAll("li.row-item")].find((r) => r.textContent.includes(${JSON.stringify(title)}))`;

export async function checkCardHover({ send, evaluate, waitFor, check, popup }) {
  const s = popup.sessionId;
  const ev = (code) => evaluate(s, code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const move = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) }, s);
    await sleep(350);
  };
  const rect = async (expr) => JSON.parse(await ev(`JSON.stringify((() => { const r = (${expr})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })())`));
  const shown = async (key) => JSON.parse(await ev(`JSON.stringify([...((${card(key)})?.querySelectorAll(".act-row") || [])].map((r) => getComputedStyle(r.querySelector(".act-label")).opacity === "1"))`));
  const containers = JSON.parse(await ev(`(${sendMsg('state', {})}).then((r) => JSON.stringify(r.containers.map((c) => c.id)))`));
  const saved = JSON.parse(await ev(`(${sendMsg('save', { containerId: containers[0], item: { type: 'login', title: 'Smoke Hover', username: 'hover-user', password: 'Hover-Pass-1!', totp: TOTP_SECRET,
    urls: ['https://one.hover.example', 'https://two.hover.example'],
    fields: [{ name: 'Mandanten-ID', value: 'tenant-4711', type: 'text', hidden: false }, { name: 'Primäre Domäne', value: '', type: 'text', hidden: false }] } })}).then((r) => JSON.stringify({ id: r.id }))`));
  const holder = JSON.parse(await ev(`(${sendMsg('save', { containerId: containers[0], item: { type: 'card', title: 'Smoke Hover Karte', card: { holder: 'Erika Hover', number: '4111111111111111' } } })}).then((r) => JSON.stringify({ id: r.id }))`));
  const long = JSON.parse(await ev(`(${sendMsg('save', { containerId: containers[0], item: { type: 'login', title: 'Smoke Hover Lang', username: 'hover-user', password: 'Hover-Pass-1!', urls: [LONG_URL] } })}).then((r) => JSON.stringify({ id: r.id }))`));
  const openByTitle = async (title) => {
    await ev('location.reload(), true');
    await waitFor(() => ev('document.querySelectorAll(".row-item").length > 0'));
    await ev('document.querySelector(".tabs button:nth-child(2)")?.click(), true');
    await ev(`(() => { const q = document.querySelector("input[type=search]"); q.value = ${JSON.stringify(title)}; q.dispatchEvent(new Event("input")); return true; })()`);
    await waitFor(() => ev(`!!(${rowByTitle(title)})`));
    await ev(`(${rowByTitle(title)})?.click(), true`);
  };
  // #493: a mouse focus (pressed on the card, released outside it: no click, so nothing is copied) does not keep the card
  // lit once the mouse has left; keyboard focus (:focus-visible) does.
  const focusCheck = async () => {
    await ev(`(${card('user')})?.scrollIntoView({ block: "center" }), true`);
    const head = await rect(`(${card('user')})?.querySelector(":scope > label")`);
    if (!head) return check(false, 'Popup (#493): Karte Benutzername fehlt');
    const lit = async () => JSON.parse(await ev(`(() => { document.getAnimations().forEach((a) => a.finish()); const c = ${card('user')}; const st = getComputedStyle(c);
      return JSON.stringify({ frame: st.boxShadow.includes("inset"), action: getComputedStyle(c.querySelector(".act-label")).opacity === "1", focused: c.contains(document.activeElement) }); })()`));
    await move(head.x + head.w / 2, head.y + head.h / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(head.x + head.w / 2), y: Math.round(head.y + head.h / 2), button: 'left', clickCount: 1 }, s);
    await move(1, 1);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }, s);
    await sleep(300);
    const mouse = await lit();
    check(mouse.focused, `Popup (#493): Mausdruck hat die Karte nicht fokussiert, die Prüfung zeigt nichts ${JSON.stringify(mouse)}`);
    check(!mouse.frame && !mouse.action, `Popup (#493): Karte bleibt nach Mausfokus hervorgehoben, obwohl die Maus weg ist ${JSON.stringify(mouse)}`);
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }, s);
    await ev(`(() => { const c = ${card('user')}; c.blur(); c.focus(); return true; })()`);
    await sleep(200);
    const keyboard = await lit();
    const visible = await ev(`(${card('user')}).matches(":focus-visible")`);
    check(visible && keyboard.frame && keyboard.action, `Popup (#493): Tastaturfokus auf der Karte nicht sichtbar ${JSON.stringify({ visible, ...keyboard })}`);
    await ev('document.activeElement?.blur(), true');
    return undefined;
  };
  try {
    await openByTitle('Smoke Hover');
    const opened = await waitFor(() => ev(`!!(${card('extra')})`));
    check(opened, 'Popup (#458): Eintrag mit Zusatzfeld öffnet nicht');
    if (!opened) return;
    for (const key of ['user', 'extra']) {
      // The popup page is short (about 490 px): a card further down lies below the window, where no mouse reaches it.
      await ev(`(${card(key)})?.scrollIntoView({ block: "center" }), true`);
      const head = await rect(`(${card(key)})?.querySelector(":scope > label")`);
      const box = await rect(card(key));
      if (!head || !box) { check(false, `Popup (#458): Karte ${key} fehlt`); continue; }
      await move(1, 1);
      check(!(await shown(key))[0], `Popup (#458): „Kopieren“ (${key}) ohne Hover sichtbar`);
      await move(head.x + head.w / 2, head.y + head.h / 2);
      check((await shown(key))[0], `Popup (#458): Maus auf der Überschrift (${key}), „Kopieren“ nicht sichtbar`);
      await move(box.x + 3, box.y + box.h / 2);
      check((await shown(key))[0], `Popup (#458): Maus am Rand der Karte (${key}), „Kopieren“ nicht sichtbar`);
    }
    await focusCheck();
    await ev(`(${card('sites')})?.scrollIntoView({ block: "center" }), true`);
    const sites = await rect(`(${card('sites')})?.querySelector(":scope > label")`);
    if (sites) {
      await move(sites.x + sites.w / 2, sites.y + sites.h / 2);
      const rows = await shown('sites');
      check(rows.length === 2 && !rows[1], `Popup (#458): Überschrift „Websites“ zeigt die Aktion jeder Zeile ${JSON.stringify(rows)}`);
    } else check(false, 'Popup (#458): Karte „Websites“ fehlt');
    const extra = JSON.parse(await ev(`JSON.stringify((() => { const c = ${card('extra')}; const v = c?.querySelector(".value");
      return { single: !!c?.matches(".act-card.single"), icon: !!c?.querySelector(".field-row > .icon-btn:not(.act-more)"), value: v?.textContent || "", seen: !!v && v.getBoundingClientRect().width > 0 }; })())`));
    check(extra.single && !extra.icon, `Popup (#458): Zusatzfeld nicht als Karte oder mit eigenem Kopier-Symbol ${JSON.stringify(extra)}`);
    check(extra.value === 'tenant-4711' && extra.seen, `Popup (#458): Wert des Zusatzfelds nicht sichtbar ${JSON.stringify(extra)}`);
    check(!(await ev(`!!(${card('empty')})`)), 'Popup (#458): leeres Zusatzfeld wird angezeigt');
    // TOTP as the same card: current code with countdown, the copy action (demo: plain "Kopieren", otherwise "Sicher
    // kopieren"), no copy icon, never the secret in the card (#469).
    const totp = JSON.parse(await ev(`JSON.stringify((() => { const c = document.querySelector(".view.detail .field-card > .totp-field");
      return c && { single: c.matches(".act-card.single"), icon: !!c.querySelector(".field-row > .icon-btn:not(.act-more)"), action: c.querySelector(".act-label")?.textContent || "",
        code: c.querySelector(".value.totp")?.textContent || "", timer: c.querySelector(".totp-timer")?.textContent || "", secret: c.textContent.includes(${JSON.stringify(TOTP_SECRET)}) }; })())`));
    check(!!totp && totp.single && !totp.icon && /^(Sicher kopieren|Copy securely|Kopieren|Copy)$/.test(totp.action), `Popup (#458): TOTP nicht als Karte mit Kopier-Aktion ${JSON.stringify(totp)}`);
    check(!!totp && /^\d{3} \d{3}$/.test(totp.code) && /^\d+$/.test(totp.timer) && !totp.secret, `Popup (#458): TOTP ohne aktuellen Code und Countdown oder mit Secret ${JSON.stringify(totp)}`);
    // Card holder: the card with "Kopieren", no copy icon of its own.
    await openByTitle('Smoke Hover Karte');
    const shownHolder = await waitFor(() => ev(`!!(${card('holder')})`));
    const h = shownHolder && JSON.parse(await ev(`JSON.stringify((() => { const c = ${card('holder')}; return { single: c.matches(".act-card.single"), icon: !!c.querySelector(".field-row > .icon-btn:not(.act-more)"),
      action: c.querySelector(".act-label")?.textContent || "", value: c.querySelector(".value")?.textContent || "" }; })())`));
    check(!!h && h.single && !h.icon && /^(Kopieren|Copy)$/.test(h.action) && h.value === 'Erika Hover', `Popup (#458): Karteninhaber nicht als Karte mit „Kopieren“ ${JSON.stringify(h)}`);
    // #498: without hover the address and the user name use the full width of their row (no room kept for the action);
    // the action lies at the right edge over the end of the value; the full address is the tooltip.
    await openByTitle('Smoke Hover Lang');
    if (!(await waitFor(() => ev(`!!(${card('site')})?.querySelector(".url")`)))) check(false, 'Popup (#498): Karte „Website“ mit langer Adresse fehlt');
    else {
      await move(1, 1);
      const fit = async (key, sel) => JSON.parse(await ev(`JSON.stringify((() => { const r = (${card(key)})?.querySelector(".act-row"), v = r?.querySelector(${JSON.stringify(sel)});
        if (!v) return null; const a = r.getBoundingClientRect(), b = v.getBoundingClientRect(), t = r.querySelector(".act-tools").getBoundingClientRect();
        return { row: Math.round(a.width), value: Math.round(b.width), toolsRight: Math.round(a.right - t.right), title: v.title || "", cut: v.scrollWidth > v.clientWidth }; })())`));
      for (const [key, sel] of [['site', '.url'], ['user', '.value']]) {
        const f = await fit(key, sel);
        check(!!f && f.value >= f.row - 2 && Math.abs(f.toolsRight) <= 1, `Popup (#498): ${key}: Wert nutzt ohne Hover nicht die volle Breite ${JSON.stringify(f)}`);
        if (key === 'site') check(!!f && f.title === LONG_URL && f.cut, `Popup (#498): lange Adresse ohne Tooltip oder nicht erst am Rand gekürzt ${JSON.stringify(f)}`);
      }
      const head = await rect(`(${card('site')})?.querySelector(":scope > label")`);
      if (head) await move(head.x + head.w / 2, head.y + head.h / 2);
      const hovered = await fit('site', '.url');      check((await shown('site'))[0] && !!hovered && hovered.value >= hovered.row - 2, `Popup (#498): beim Hover fehlt die Aktion oder die Adresse wird schmaler ${JSON.stringify(hovered)}`);
    }
  } finally {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }, s).catch(() => {});
    await move(1, 1).catch(() => {});
    await ev(`(${sendMsg('delete', { containerId: containers[0], id: saved.id })}).then(() => true)`).catch(() => {});
    await ev(`(${sendMsg('delete', { containerId: containers[0], id: holder.id })}).then(() => true)`).catch(() => {});
    await ev(`(${sendMsg('delete', { containerId: containers[0], id: long.id })}).then(() => true)`).catch(() => {});
  }
}
