// Extension smoke, part (#469): a set TOTP secret can't be displayed any more. The popup's detail and edit view carry it
// nowhere in the DOM (markup, input values, data attributes), saving without "Erneuern" keeps it, "Erneuern" sets a new
// one and the shown code changes with it.

const A = 'JBSWY3DPEHPK3PXP';
const B = 'GEZDGNBVGY3TQOJQ';
const FIELD = 'KRSXG5CTMVRXEZLU';

/** Which of the secrets the page carries anywhere: markup plus the values of all form fields. */
const leaks = (secrets) => `(() => { const s = ${JSON.stringify(secrets)};
  const all = document.documentElement.outerHTML + ' ' + [...document.querySelectorAll('input, textarea, select')].map((e) => e.value).join(' ');
  return JSON.stringify(s.filter((x) => all.includes(x))); })()`;
const shownCode = 'document.querySelector(".item-detail .value.totp")?.textContent.replace(/\\s/g, "") || ""';
const codeOf = (secret) => `import(chrome.runtime.getURL('core/totp.js')).then((m) => m.totpCode(${JSON.stringify(secret)})).then((c) => c.code)`;

export async function checkOtpSecret({ send, evaluate, open, waitFor, check, sleep, sw, ext, sessionId, personal }) {
  const saved = await sw(sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Smoke OTP', username: 'otp', password: 'Otp-Pass-1',
    totp: `otpauth://totp/Smoke:otp?secret=${A}&issuer=Smoke`, fields: [{ name: 'Zweitcode', type: 'totp', value: FIELD, hidden: false }] } });
  const popup = await open(`${ext}/popup/popup.html`);
  const p = popup.sessionId;
  try {
    const row = '[...document.querySelectorAll("li.row-item")].find((r) => r.textContent.includes("Smoke OTP"))';
    check(await waitFor(() => evaluate(p, `!!${row}`)), 'OTP (#469): Eintrag nicht in der Liste');
    await evaluate(p, `${row}?.click(), true`);
    check(await waitFor(() => evaluate(p, `/^\\d{6}$/.test(${shownCode})`)), 'OTP (#469): Detailansicht zeigt keinen Code');
    let found = JSON.parse(await evaluate(p, leaks([A, FIELD])));
    check(!found.length, `OTP (#469): Geheimnis im DOM der Detailansicht (${found.length})`);
    const edit = async () => {
      await evaluate(p, '[...document.querySelectorAll(".item-detail .actions .btn")].find((b) => /Bearbeiten|Edit/.test(b.textContent))?.click(), true');
      return waitFor(() => evaluate(p, 'document.querySelectorAll(".item-form .totp-editor[data-totp-state=keep]").length === 2'));
    };
    const submit = async () => {
      await evaluate(p, 'document.querySelector(".item-form")?.requestSubmit(), true');
      return waitFor(() => evaluate(p, '!document.querySelector(".item-form") && !!document.querySelector(".item-detail .value.totp")'));
    };
    check(await edit(), 'OTP (#469): Bearbeiten zeigt nicht „gesetzt“ mit Erneuern/Entfernen');
    found = JSON.parse(await evaluate(p, leaks([A, FIELD])));
    check(!found.length, `OTP (#469): Geheimnis im DOM der Bearbeiten-Ansicht (${found.length})`);
    check(await submit(), 'OTP (#469): Speichern ohne Erneuern kehrte nicht zur Detailansicht zurück');
    let stored = await sw(sessionId, 'item', { containerId: personal.id, id: saved?.id });
    check(stored?.totp?.includes(A) && stored?.fields?.[0]?.value === FIELD, 'OTP (#469): Speichern ohne Erneuern hat das Geheimnis verändert');

    check(await edit(), 'OTP (#469): zweites Bearbeiten ohne „gesetzt“');
    await evaluate(p, 'document.querySelector(".item-form .totp-renew")?.click(), true');
    check(await waitFor(() => evaluate(p, '!!document.querySelector(".item-form input[name=totp]")')), 'OTP (#469): „Erneuern“ öffnet kein Eingabefeld');
    check(await evaluate(p, 'document.querySelector(".item-form input[name=totp]")?.value === ""'), 'OTP (#469): das Feld zum Erneuern ist nicht leer');
    await evaluate(p, `(() => { const i = document.querySelector(".item-form input[name=totp]"); i.value = ${JSON.stringify(B)}; i.dispatchEvent(new Event("input")); return true; })()`);
    check(await submit(), 'OTP (#469): Speichern nach Erneuern kehrte nicht zur Detailansicht zurück');
    stored = await sw(sessionId, 'item', { containerId: personal.id, id: saved?.id });
    check(stored?.totp === B && stored?.fields?.[0]?.value === FIELD, 'OTP (#469): „Erneuern“ hat das neue Geheimnis nicht gespeichert');
    // The code follows the new secret (both codes of the same 30 s window; a window change in between is retried).
    const follows = await waitFor(async () => (await evaluate(p, shownCode)) === (await evaluate(p, codeOf(B))), 4000);
    check(follows, 'OTP (#469): der angezeigte Code folgt nicht dem neuen Geheimnis');
    check((await evaluate(p, shownCode)) !== (await evaluate(p, codeOf(A))), 'OTP (#469): der Code hat sich durch Erneuern nicht geändert');
    found = JSON.parse(await evaluate(p, leaks([A, B, FIELD])));
    check(!found.length, `OTP (#469): Geheimnis nach dem Erneuern im DOM (${found.length})`);
  } finally {
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
    if (saved?.id) await sw(sessionId, 'delete', { containerId: personal.id, id: saved.id }).catch(() => {});
    await sleep(200);
  }
}
