// Smoke check (#458): "Copy" and the arrow of a field card with one value show as soon as the mouse is anywhere on the
// card (heading, edge), not only over the value row. A card with several rows (Websites) keeps the action per row: with
// the mouse on its heading at most the first row shows its action. Additional and template fields use the same card
// (no copy icon of their own), show their value, and an empty one is not shown. Real mouse moves (sendInputEvent),
// because :hover cannot be set from script. Part of the feature checks (desktop/smoke-features.js).
// The rest of #458: TOTP (current code, countdown, "Copy securely" copies only the code), card holder and server fields
// (host, management page) are the same card without a copy icon of their own.

import { until } from './smoke-wait.js';

// The headings in German and English (the smoke run may use either language).
const NAMES = { Benutzername: ['Benutzername', 'User name', 'Username'], Websites: ['Websites'], Website: ['Website'], 'Mandanten-ID': ['Mandanten-ID'], 'Primäre Domäne': ['Primäre Domäne'],
  Karteninhaber: ['Karteninhaber', 'Cardholder'], 'Server (IP oder Name)': ['Server (IP oder Name)', 'Server (IP or name)'], Verwaltungsseite: ['Verwaltungsseite', 'Management page'] };
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const card = (label) => `[...document.querySelectorAll(".detail-pane .field-card > .field")].find((c) => ${JSON.stringify(NAMES[label] || [label])}.includes(c.querySelector(":scope > label")?.textContent.trim()))`;

export async function fieldHoverCheck(ctx) {
  const { js, sleep, fail, save, openItem, win, clipboardHas, setAdmin, isAdmin } = ctx;
  await save({ type: 'login', title: 'Smoke Hover', username: 'hover-user', password: 'Hover-Pass-1', totp: TOTP_SECRET, urls: ['https://one.hover.example', 'https://two.hover.example'],
    fields: [{ name: 'Mandanten-ID', value: 'tenant-4711', type: 'text', hidden: false }, { name: 'Primäre Domäne', value: '', type: 'text', hidden: false }] });
  await openItem('Smoke Hover');
  if (!(await until(() => js(`!!(${card('Mandanten-ID')})`), 4000))) return fail('the entry with additional fields did not open');
  const move = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    // The hidden window hands mouse moves to the page late (they wait for a frame): wait until the element under the
    // point is the hovered one.
    if (!(await until(() => js(`!!document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})?.matches(":hover")`), 3000))) fail(`the mouse move to ${Math.round(x)},${Math.round(y)} did not reach the page`);
  };
  const rect = async (expr) => JSON.parse(await js(`JSON.stringify((() => { const r = (${expr})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })())`));
  // The window of a smoke run is never shown, so it draws no frames and the .12 s fade-in never runs: the transitions
  // are finished first, then the opacity is the one the hover rule sets.
  const FINISH = 'document.getAnimations().forEach((a) => a.finish());';
  // Opacity of the action text of each row of a card: "1" = visible.
  const shown = (label) => js(`${FINISH} JSON.stringify([...((${card(label)})?.querySelectorAll(".act-row") || [])].map((r) => getComputedStyle(r.querySelector(".act-label")).opacity === "1"))`).then(JSON.parse);
  try {
    for (const label of ['Benutzername', 'Mandanten-ID']) {
      const head = await rect(`(${card(label)})?.querySelector(":scope > label")`);
      const box = await rect(card(label));
      if (!head || !box) { fail(`${label}: card or heading missing`); continue; }
      await move(1, 1);
      if ((await shown(label))[0]) fail(`${label}: "Copy" is visible without hover`);
      await move(head.x + head.w / 2, head.y + head.h / 2);
      if (!(await shown(label))[0]) fail(`${label}: mouse on the heading, but "Copy" is not visible`);
      await move(box.x + 3, box.y + box.h / 2);
      if (!(await shown(label))[0]) fail(`${label}: mouse on the edge of the card, but "Copy" is not visible`);
    }
    await clickFocusCheck();
    // The arrow of the user name card shows with the action (where the card has one) – the mouse back on that card.
    const userHead = await rect(`(${card('Benutzername')})?.querySelector(":scope > label")`);
    if (userHead) await move(userHead.x + userHead.w / 2, userHead.y + userHead.h / 2);
    const arrow = await js(`(() => { ${FINISH} const a = (${card('Benutzername')})?.querySelector(".act-more"); return !a || getComputedStyle(a).opacity === "1"; })()`);
    if (!arrow) fail('user name: mouse on the card, but the arrow is not visible');
    // Websites: several rows – the heading shows no action, or only the first row's.
    const sites = await rect(`(${card('Websites')})?.querySelector(":scope > label")`);
    if (!sites) fail('Websites card missing');
    else {
      await move(sites.x + sites.w / 2, sites.y + sites.h / 2);
      const s = await shown('Websites');
      if (s.length !== 2) fail(`Websites: expected two rows, found ${s.length}`);
      else if (s[1]) fail(`Websites: mouse on the heading shows the action of every row ${JSON.stringify(s)}`);
    }
    // Additional field: same card as the user name, no copy icon of its own, the value visible; an empty one not shown.
    const extra = JSON.parse(await js(`JSON.stringify((() => { const c = ${card('Mandanten-ID')}; const v = c?.querySelector(".value");
      return { single: !!c?.matches(".act-card.single"), icon: !!c?.querySelector(".field-row > .icon-btn:not(.act-more)"), action: c?.querySelector(".act-label")?.textContent || "",
        value: v?.textContent || "", seen: !!v && v.getBoundingClientRect().width > 0 && getComputedStyle(v).visibility !== "hidden" }; })())`));
    if (!extra.single || extra.icon) fail(`additional field: not the card of the user name or still a copy icon ${JSON.stringify(extra)}`);
    if (!/^(Kopieren|Copy)$/.test(extra.action)) fail(`additional field: action is not "Copy" ${JSON.stringify(extra)}`);
    if (extra.value !== 'tenant-4711' || !extra.seen) fail(`additional field: the value is not shown ${JSON.stringify(extra)}`);
    if (await js(`!!(${card('Primäre Domäne')})`)) fail('an empty additional field is shown in the detail view');

    // #458 rest: the TOTP card shows the current code with its countdown, "Copy securely" anywhere on it, no copy icon;
    // a click copies the code, never the secret (#469).
    const totp = JSON.parse(await js(`JSON.stringify((() => { const c = document.querySelector(".detail-pane .field-card > .totp-field");
      return c && { single: c.matches(".act-card.single"), icon: !!c.querySelector(".field-row > .icon-btn:not(.act-more)"), action: c.querySelector(".act-label")?.textContent || "",
        code: c.querySelector(".value.totp")?.textContent || "", timer: c.querySelector(".totp-timer")?.textContent || "", secret: c.textContent.includes(${JSON.stringify(TOTP_SECRET)}) }; })())`));
    if (!totp) fail('TOTP: no card in the detail view');
    else {
      if (!totp.single || totp.icon) fail(`TOTP: not the field card or still a copy icon ${JSON.stringify(totp)}`);
      if (!/^(Sicher kopieren|Copy securely)$/.test(totp.action)) fail(`TOTP: action is not "Copy securely" ${JSON.stringify(totp)}`);
      if (!/^\d{3} \d{3}$/.test(totp.code) || !/^\d+$/.test(totp.timer)) fail(`TOTP: no current code with countdown ${JSON.stringify(totp)}`);
      if (totp.secret) fail('TOTP: the secret is in the card');
      let copied = false;
      for (let i = 0; i < 2 && !copied; i++) {
        await js('document.querySelector(".detail-pane .totp-field > label")?.click()');
        const code = (await js('document.querySelector(".detail-pane .totp-field .value.totp")?.textContent || ""')).replace(/\s/g, '');
        for (let j = 0; j < 8 && !copied; j++) { await sleep(300); copied = !!code && await clipboardHas(code); }
      }
      if (!copied) fail('TOTP: a click on the card did not copy the current code');
      if (await clipboardHas(TOTP_SECRET)) fail('TOTP: the click copied the secret (#469)');
    }
    await widthCheck();

    // Card holder: the card with "Copy", no icon of its own.
    await save({ type: 'card', title: 'Smoke Hover Karte', card: { holder: 'Erika Hover', number: '4111111111111111' } });
    await openItem('Smoke Hover Karte');
    if (!(await until(() => js(`!!(${card('Karteninhaber')})`), 4000))) fail('card holder: no card in the detail view');
    else singleCard(await cardInfo('Karteninhaber'), 'card holder', /^(Kopieren|Copy)$/, 'Erika Hover');

    // Server (assets, admin mode): host as the card with "Copy", the management page as a card with "Open".
    const wasAdmin = isAdmin();
    await setAdmin(true);
    try {
      await save({ type: 'server', title: 'Smoke Hover Server', server: { kind: 'vmware', host: 'hover-srv', mgmtUrl: 'https://hover-srv.contoso.local' } });
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=devices]")?.click()');
      await sleep(500);
      await openItem('Smoke Hover Server');
      if (!(await until(() => js(`!!(${card('Server (IP oder Name)')})`), 4000))) fail('server: no host card in the detail view');
      else {
        singleCard(await cardInfo('Server (IP oder Name)'), 'server host', /^(Kopieren|Copy)$/, 'hover-srv');
        singleCard(await cardInfo('Verwaltungsseite'), 'server management page', /^(Öffnen|Open)$/, 'https://hover-srv.contoso.local');
      }
    } finally {
      await js('document.querySelector(".context-menu")?.remove(); document.querySelector(".mode-switch [data-mode=items]")?.click()');
      await sleep(300);
      if (!wasAdmin) await setAdmin(false);
    }
  } finally {
    await move(1, 1);
  }

  // #493: a mouse click copies, says "Kopiert" on the card for a moment, and the card goes dark once the mouse has left
  // (it keeps the focus, but not :focus-visible); keyboard focus on the card keeps it lit.
  async function clickFocusCheck() {
    const user = card('Benutzername');
    const lit = () => js(`(() => { ${FINISH} const c = ${user}; const s = c && getComputedStyle(c);
      return JSON.stringify({ frame: !!s && s.boxShadow.includes("inset"), action: !!c && getComputedStyle(c.querySelector(".act-label")).opacity === "1", text: c?.querySelector(".act-label")?.textContent || "" }); })()`).then(JSON.parse);
    const head = await rect(`(${user})?.querySelector(":scope > label")`);
    if (!head) return fail('#493: user name card missing');
    const x = Math.round(head.x + head.w / 2), y = Math.round(head.y + head.h / 2);
    await move(x, y);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    if (!(await until(() => js(`/^(Kopiert|Copied)$/.test((${user})?.querySelector(".act-label")?.textContent || "")`), 2000))) fail('#493: no "Kopiert" on the card after the click');
    if (!(await js(`!!(${user})?.contains(document.activeElement)`))) fail('#493: the click did not focus the card (the check would prove nothing)');
    await move(1, 1);
    await sleep(1500); // "Kopiert" is over
    const after = await lit();
    if (after.frame || after.action) fail(`#493: the card stays lit after a click once the mouse has left ${JSON.stringify(after)}`);
    // Keyboard: a key press makes the next focus a keyboard focus (:focus-visible), as with Tab.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    await sleep(200);
    await js(`(() => { const c = ${user}; c?.blur(); c?.focus(); return true; })()`);
    await sleep(200);
    const keyboard = await lit();
    const visible = await js(`!!(${user})?.matches(":focus-visible")`);
    if (!visible || !keyboard.frame || !keyboard.action) fail(`#493: keyboard focus on the card is not visible ${JSON.stringify({ visible, ...keyboard })}`);
    await js('document.activeElement?.blur(); true');
    return undefined;
  }

  // #498: without hover the value of a card uses the full width of its row (no room kept for the action); the action
  // lies over the end of the value at the right edge on hover; the full address is the tooltip.
  async function widthCheck() {
    const long = 'https://keevault.de/hilfe/ein-sehr-langer-pfad/der-sicher-nicht-in-die-karte-passt/und-noch-weiter';
    await save({ type: 'login', title: 'Smoke Hover Lang', username: 'hover-user', password: 'Hover-Pass-1', urls: [long] });
    await openItem('Smoke Hover Lang');
    if (!(await until(() => js(`!!(${card('Website')})?.querySelector(".url")`), 4000))) return fail('#498: no Website card with the long address');
    await move(1, 1);
    const fit = (label, sel) => js(`JSON.stringify((() => { const c = ${card(label)}; const r = c?.querySelector(".act-row"), v = r?.querySelector(${JSON.stringify(sel)});
      if (!v) return null; const a = r.getBoundingClientRect(), b = v.getBoundingClientRect(), t = r.querySelector(".act-tools").getBoundingClientRect();
      return { row: Math.round(a.width), value: Math.round(b.width), toolsRight: Math.round(a.right - t.right), title: v.title || "", cut: v.scrollWidth > v.clientWidth }; })())`).then(JSON.parse);
    for (const [label, sel] of [['Website', '.url'], ['Benutzername', '.value']]) {
      const f = await fit(label, sel);
      if (!f) { fail(`#498: ${label}: no value in the card`); continue; }
      if (f.value < f.row - 2) fail(`#498: ${label}: the value takes only ${f.value} of ${f.row} px without hover (room kept for the action)`);
      if (Math.abs(f.toolsRight) > 1) fail(`#498: ${label}: the action is not at the right edge of the row ${JSON.stringify(f)}`);
      if (label === 'Website' && (f.title !== long || !f.cut)) fail(`#498: long address without tooltip or not shortened at the edge ${JSON.stringify(f)}`);
    }
    const head = await rect(`(${card('Website')})?.querySelector(":scope > label")`);
    if (head) await move(head.x + head.w / 2, head.y + head.h / 2);
    const hovered = await fit('Website', '.url');    if (!(await shown('Website'))[0]) fail('#498: mouse on the Website card, but the action is not visible');
    if (hovered && hovered.value < hovered.row - 2) fail(`#498: on hover the address shrinks instead of the action lying over it ${JSON.stringify(hovered)}`);
    await move(1, 1);
    return undefined;
  }

  async function cardInfo(label) {
    return JSON.parse(await js(`JSON.stringify((() => { const c = ${card(label)}; const v = c?.querySelector(".value, .url");
      return c ? { single: c.matches(".act-card.single"), icon: !!c.querySelector(".field-row > .icon-btn:not(.act-more)"), action: c.querySelector(".act-label")?.textContent || "", value: v?.textContent || "" } : null; })())`));
  }
  function singleCard(info, what, action, value) {
    if (!info) return fail(`${what}: card missing`);
    if (!info.single || info.icon) fail(`${what}: not the field card or still a copy icon ${JSON.stringify(info)}`);
    if (!action.test(info.action)) fail(`${what}: wrong action ${JSON.stringify(info)}`);
    if (info.value !== value) fail(`${what}: value not shown ${JSON.stringify(info)}`);
  }
}
