import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const api = join(import.meta.dirname, '..', 'website', 'php', 'api');

/** Source of the send_mail(...) call whose first argument starts with `to`, up to its closing parenthesis. */
function mailCall(file, to) {
  const source = readFileSync(join(api, file), 'utf8');
  const start = source.indexOf(`send_mail(${to},`);
  assert.notEqual(start, -1, `${file}: no mail to ${to}`);
  let depth = 0;
  let quote = '';
  for (let i = start + 'send_mail'.length; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${file}: unterminated call`);
}

// Anyone can enter any address in these forms without signing in. If the confirmation carried their input, the site's
// mail account could be used to send their text to strangers (#360).
for (const [file, to, input] of [
  ['support.php', '$email', ['$message', '$transcript', '$page']],
  ['anfrage.php', "$request['email']", ['$hello', '$name', '$message', "$request['name']", "$request['message']", "$request['vault']", "$request['company']", "$request['code']"]],
  ['testlizenz.php', '$email', ['$name', '$company', '$text']],
]) {
  test(`website: ${file} confirmation to an unverified address carries no form input`, () => {
    const call = mailCall(file, to);
    for (const variable of input) assert.ok(!call.includes(variable), `${file} puts ${variable} into the mail`);
  });
}
