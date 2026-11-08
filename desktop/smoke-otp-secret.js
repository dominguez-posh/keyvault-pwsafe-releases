// Smoke check (#469): a set TOTP secret can't be displayed any more. Detail view, edit view and an older version carry
// it nowhere in the DOM (markup, input values, data attributes); saving without "Erneuern" keeps it; "Erneuern" sets a
// new one and the shown code changes with it. Part of the feature checks (desktop/smoke-features.js).

import { totpCode } from '../extension/core/totp.js';
import { until } from './smoke-wait.js';
import { setSmokeScreens } from './qr-decode.js';
import { MS_STYLE_URI, screenWithQr } from './smoke-qr-image.js';

const A = 'JBSWY3DPEHPK3PXP';
const B = 'GEZDGNBVGY3TQOJQ';
const FIELD = 'KRSXG5CTMVRXEZLU';

/** Which of the secrets the window carries anywhere: markup plus the values of all form fields. */
const leaks = (secrets) => `(() => { const s = ${JSON.stringify(secrets)};
  const all = document.documentElement.outerHTML + ' ' + [...document.querySelectorAll('input, textarea, select')].map((e) => e.value).join(' ');
  return JSON.stringify(s.filter((x) => all.includes(x))); })()`;
const shownCode = 'document.querySelector(".detail-pane .item-detail .value.totp")?.textContent.replace(/\\s/g, "") || ""';
const code = async (secret) => (await totpCode(secret)).code;

export async function otpSecretCheck(ctx) {
  const { js, sleep, fail, save, openItem, getItem } = ctx;
  const saved = await save({ type: 'login', title: 'Smoke OTP', username: 'otp', password: 'Otp-Pass-1',
    totp: `otpauth://totp/Smoke:otp?secret=${A}&issuer=Smoke`, fields: [{ name: 'Zweitcode', type: 'totp', value: FIELD, hidden: false }] });
  await openItem('Smoke OTP');
  const leaked = async (where, secrets) => {
    const found = JSON.parse(await js(leaks(secrets)));
    if (found.length) fail(`${where}: the TOTP secret is in the DOM (${found.length})`);
  };
  const edit = async () => {
    await js('document.querySelector(".detail-pane .item-hover-menu")?.click(); true');
    await sleep(300);
    await js('document.querySelector(".context-menu [data-action=edit]")?.click(); true');
    return until(() => js('document.querySelectorAll(".detail-pane .item-form .totp-editor[data-totp-state=keep]").length === 2'), 4000);
  };
  const submit = async () => {
    await js('document.querySelector(".detail-pane .item-form")?.requestSubmit(); true');
    return until(() => js('!document.querySelector(".detail-pane .item-form") && !!document.querySelector(".detail-pane .item-detail .value.totp")'), 5000);
  };
  try {
    if (!(await until(() => js(`/^\\d{6}$/.test(${shownCode})`), 4000))) return fail('detail view shows no code');
    // The code's row has one button – copy the code; nothing that shows the secret or a QR code.
    const buttons = await js('JSON.stringify([...document.querySelectorAll(".detail-pane .item-detail .value.totp")].map((c) => c.closest(".field").querySelectorAll("button").length))');
    if (buttons !== '[1,1]') fail(`the code rows offer more than copying the code: ${buttons}`);
    await leaked('detail view', [A, FIELD]);
    if (!(await edit())) return fail('the editor does not show "gesetzt" with "Erneuern"/"Entfernen" for both secrets');
    await leaked('edit view', [A, FIELD]);
    if (!(await submit())) return fail('saving without "Erneuern" did not return to the detail view');
    let stored = await getItem(saved.id);
    if (!stored.totp.includes(A) || stored.fields[0]?.value !== FIELD) fail('saving without "Erneuern" changed or cleared the secret');

    if (!(await edit())) return fail('second edit without "gesetzt"');
    await js('document.querySelector(".detail-pane .item-form .totp-renew")?.click(); true');
    if (!(await until(() => js('!!document.querySelector(".detail-pane .item-form input[name=totp]")'), 3000))) return fail('"Erneuern" opens no input');
    if (await js('document.querySelector(".detail-pane .item-form input[name=totp]").value !== ""')) fail('the input for the new secret is not empty');
    // #492: the scan button reads the setup QR code from the screen (here a Microsoft-style test screen, never the real one).
    const scanQr = 'document.querySelector(".detail-pane .item-form .totp-editor .icon-btn[aria-label*=QR]")';
    if (!(await js(`!!${scanQr}`))) fail('#492: the TOTP editor offers no QR scan');
    setSmokeScreens(async () => [screenWithQr({ scale: 1.25 })]);
    await js(`${scanQr}?.click(); true`);
    if (!(await until(() => js(`document.querySelector(".detail-pane .item-form input[name=totp]").value === ${JSON.stringify(MS_STYLE_URI)}`), 8000))) fail('#492: the QR code on the screen was not taken into the input');
    setSmokeScreens(null);
    await js(`(() => { const i = document.querySelector(".detail-pane .item-form input[name=totp]"); i.value = ${JSON.stringify(B)}; i.dispatchEvent(new Event("input")); return true; })()`);
    if (!(await submit())) return fail('saving after "Erneuern" did not return to the detail view');
    stored = await getItem(saved.id);
    if (stored.totp !== B || stored.fields[0]?.value !== FIELD) fail('"Erneuern" did not store the new secret (or touched the other one)');
    // The code follows the new secret (a change of the 30 s window in between is retried).
    if (!(await until(async () => (await js(shownCode)) === (await code(B)), 4000))) fail('the shown code does not follow the new secret');
    if ((await js(shownCode)) === (await code(A))) fail('the code did not change with "Erneuern"');
    await leaked('detail view after "Erneuern"', [A, B, FIELD]);

    // Version history (#450): the older version (with the old secret) opens without it as well.
    await js('document.querySelector(".detail-pane .version-history .version-toggle")?.click(); true');
    if (await until(() => js('!!document.querySelector(".detail-pane .timeline-row[data-kind=version] .timeline-open, .detail-pane .timeline-row[data-kind=added] .timeline-open")'), 4000)) {
      await js('document.querySelector(".detail-pane .timeline-row[data-kind=version] .timeline-open, .detail-pane .timeline-row[data-kind=added] .timeline-open").click(); true');
      if (await until(() => js('!!document.querySelector("dialog[open] .item-detail")'), 4000)) await leaked('older version', [A, B, FIELD]);
      else fail('older version did not open');
    } else fail('no older version in the history');
  } finally {
    setSmokeScreens(null);
    await js('document.querySelector("dialog[open]")?.close(); true');
    await sleep(200);
  }
  return undefined;
}
