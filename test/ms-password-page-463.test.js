import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page } from './fixtures/content-page.js';

// #463: Microsoft's password page with the name already entered keeps the name as an invisible copy for password
// managers (class moveOffScreen, aria-hidden, opacity 0, yet with a size) before the password field. The login chosen in
// the field menu under the password field must fill the password and send it – not fill the copy and then wait for a
// page change that never comes.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function passwordPage(job) {
  let p = null;
  const fields = {};
  const sent = { clicks: 0 };
  const button = { disabled: false, click() { sent.clicks += 1; sent.password = fields.pw.value; } };
  p = page({
    host: 'login.microsoftonline.com',
    replies: { 'cs:msAccount': job },
    query: (sel) => (sel === 'input[name=loginfmt]' ? [fields.name] : sel === 'input[name=passwd]' ? [fields.pw] : sel === '#idSIButton9' ? [button] : []),
  });
  fields.name = new p.Input();
  fields.name.name = 'loginfmt';
  fields.name.value = 'name@contoso.example';
  fields.name.getAttribute = (a) => (a === 'aria-hidden' ? 'true' : null);
  fields.name.classList = { contains: (c) => c === 'moveOffScreen' };
  fields.name.focus = () => { fields.name.touched = true; };
  fields.name.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 12, width: 20, height: 12 });
  fields.pw = new p.Input();
  fields.pw.type = 'password';
  fields.pw.name = 'passwd';
  fields.pw.autocomplete = 'current-password';
  fields.pw.getBoundingClientRect = () => ({ left: 0, top: 40, bottom: 72, width: 300, height: 32 });
  return { p, fields, sent };
}

test('#463 Microsoft password page: the field menu fills the password and sends it, the invisible name copy stays', async () => {
  const { p, fields, sent } = passwordPage({ mode: 'microsoft', username: 'name@contoso.example', password: 'Pw-463-Fake', totp: '', passkey: false });
  await flush();
  p.press(fields.pw);
  await flush();
  assert.equal(p.opened(), true, 'menu under the password field');
  p.browserSays(true);
  p.wait(500);
  p.clickEntry();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(p.sent.includes('cs:msAccount'), true, 'Microsoft sign-in asked for the account');
  await pause(600); // the sign-in's first look at the page (350 ms)
  assert.equal(fields.pw.value, 'Pw-463-Fake', 'password filled');
  assert.equal(sent.clicks, 1, 'sent once');
  assert.equal(sent.password, 'Pw-463-Fake', 'sent with the password');
  assert.equal(fields.name.touched, undefined, 'invisible copy untouched');
});
