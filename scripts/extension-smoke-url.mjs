// Extension smoke, part: links of an entry open in the popup only as http(s). A website and a custom URL field with
// file:// are refused with the message, and no new tab appears; the https website of the same entry still opens one.

const NOT_WEB = /Nur Adressen mit http:\/\/ oder https:\/\/ lassen sich öffnen|Only addresses with http:\/\/ or https:\/\/ can be opened/;
const BAD = 'file:///C:/Windows/win.ini';
const GOOD = 'https://smoke-url.keevault.invalid/';
const FIELD = 'Datei-Link';

export async function checkUrlSchema({ send, evaluate, open, waitFor, check, sleep, sw, ext, sessionId, personal }) {
  const saved = await sw(sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Smoke URL-Schema', username: 'url', password: 'Url-Pass-1',
    urls: [BAD, GOOD], fields: [{ name: FIELD, type: 'url', value: BAD, hidden: false }] } });
  const popup = await open(`${ext}/popup/popup.html`);
  const p = popup.sessionId;
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter((x) => x.type === 'page');
  const opened = [];
  try {
    const row = '[...document.querySelectorAll("li.row-item")].find((r) => r.textContent.includes("Smoke URL-Schema"))';
    check(await waitFor(() => evaluate(p, `!!${row}`)), 'URL-Schema: Eintrag nicht in der Liste');
    await evaluate(p, `${row}?.click(), true`);
    check(await waitFor(() => evaluate(p, '!!document.querySelector(".item-detail")')), 'URL-Schema: Detailansicht erschien nicht');
    const toastText = 'document.getElementById("toast")?.textContent || ""';
    // Since #464 the URL field is a field card of its own (label = field name) with the same row as a website.
    const fieldCard = `(c) => c.querySelector(":scope > label")?.textContent.trim() === ${JSON.stringify(FIELD)}`;
    const clickRow = (url) => evaluate(p, `(() => { const r = [...document.querySelectorAll(".item-detail .act-row")].find((x) => !(${fieldCard})(x.closest(".act-card")) && x.querySelector("a.url")?.textContent === ${JSON.stringify(url)}); r?.click(); return !!r; })()`);
    const clickField = () => evaluate(p, `(() => { const c = [...document.querySelectorAll(".item-detail .act-card")].find(${fieldCard}); const r = c?.querySelector(".act-row"); if (r?.querySelector("a.url")?.textContent !== ${JSON.stringify(BAD)}) return false; r.click(); return true; })()`);

    let before = (await pages()).length;
    check(await clickRow(BAD), 'URL-Schema: Website-Zeile mit file:// fehlt');
    check(await waitFor(async () => NOT_WEB.test(await evaluate(p, toastText)), 2000), 'URL-Schema: keine Meldung beim Öffnen einer file://-Website');
    await sleep(500);
    check((await pages()).length === before, 'URL-Schema: eine file://-Website öffnete einen Tab');

    await evaluate(p, 'document.getElementById("toast")?.remove(), true');
    check(await clickField(), 'URL-Schema: URL-Feld mit file:// fehlt');
    check(await waitFor(async () => NOT_WEB.test(await evaluate(p, toastText)), 2000), 'URL-Schema: keine Meldung beim Öffnen eines file://-URL-Felds');
    await sleep(500);
    check((await pages()).length === before, 'URL-Schema: ein file://-URL-Feld öffnete einen Tab');

    // The https website of the same entry still opens.
    const known = new Set((await pages()).map((x) => x.targetId));
    before = known.size;
    check(await clickRow(GOOD), 'URL-Schema: Website-Zeile mit https fehlt');
    check(await waitFor(async () => (await pages()).length > before, 3000), 'URL-Schema: eine https-Website öffnete keinen Tab');
    opened.push(...(await pages()).filter((x) => !known.has(x.targetId)).map((x) => x.targetId));
  } finally {
    for (const id of opened) await send('Target.closeTarget', { targetId: id }).catch(() => {});
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
    if (saved?.id) await sw(sessionId, 'delete', { containerId: personal.id, id: saved.id }).catch(() => {});
    await sleep(200);
  }
}
