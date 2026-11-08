import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRdpTarget, RDP_HOST } from '../desktop/rdp-target.js';

// #371: host, port and user name of a remote desktop connection are checked before anything is started.

test('usable targets pass', () => {
  assert.equal(checkRdpTarget('10.9.0.1', undefined, 'DOM\\admin'), 3389);
  assert.equal(checkRdpTarget('srv-01.corp.example', 3390, 'user@corp.example'), 3390);
  assert.equal(checkRdpTarget('[fe80::1]', '3389', ''), 3389);
  assert.equal(checkRdpTarget('server', null, 'Max Müller'), 3389);
});

test('host with line breaks, options, spaces or quotes is refused', () => {
  for (const host of ['srv\r\ndrivestoredirect:s:*', 'srv\nx', '10.0.0.1\r\n', '/admin', '-v', 'srv /w:1', 'srv"x', 'a b', '', ' srv', 'srv;calc', '..\\x', 'x'.repeat(300)]) {
    assert.throws(() => checkRdpTarget(host, 3389, 'u'), /Serveradresse|server address/i, JSON.stringify(host));
  }
  assert.throws(() => checkRdpTarget(undefined, 3389, 'u'));
  assert.throws(() => checkRdpTarget({ toString: () => 'srv' }, 3389, 'u'));
});

test('port must be a number from 1 to 65535', () => {
  for (const port of [0, -1, 65536, 'abc', '1\n2', 1.5, NaN]) assert.throws(() => checkRdpTarget('srv', port, 'u'), /Port/i, String(port));
});

test('user name without line breaks or control characters', () => {
  for (const user of ['a\r\nalternate shell:s:cmd.exe', 'a\nb', 'a\0b', `a${String.fromCharCode(0x2028)}b`, 'a\u001bb']) {
    assert.throws(() => checkRdpTarget('srv', 3389, user), /Benutzername|user name/i, JSON.stringify(user));
  }
});

test('the app and the helper both check the host, before any start', () => {
  const dev = readFileSync(new URL('../desktop/main/devices.js', import.meta.url), 'utf8');
  const body = dev.slice(dev.indexOf('export async function launchRdp'));
  assert.ok(body.indexOf('checkRdpTarget(') > 0 && body.indexOf('checkRdpTarget(') < body.indexOf('smokeTest'));
  const cs = readFileSync(new URL('../windows/Setup/Rdp.cs', import.meta.url), 'utf8');
  assert.match(cs, /HostPattern\.IsMatch\(host\)/);
  assert.match(cs, /RegexOptions\.ECMAScript/, 'without it \\w is any Unicode letter in .NET');
  // The helper's pattern, read as JavaScript (\z is the end there: $), takes exactly what the app takes.
  const pattern = /new System\.Text\.RegularExpressions\.Regex\(@"([^"]+)"/.exec(cs)?.[1] || '';
  assert.ok(pattern.endsWith('\\z'), 'ends at the real end of the string, not before a final line break');
  const helper = new RegExp(pattern.replace(/\\z$/, '$'));
  for (const host of ['srv-1.contoso.local', '10.0.0.1', '[fe80::1]', 'fe80::1%12', 'srv\n', 'münchen', '-oProxyCommand=x', '/admin', 'a b', '']) {
    assert.equal(helper.test(host), RDP_HOST.test(host), JSON.stringify(host));
  }
});

test('the helper source has no raw Unicode line separators (C# reads them as line ends, CS1010)', () => {
  const cs = readFileSync(new URL('../windows/Setup/Rdp.cs', import.meta.url), 'utf8');
  assert.ok(!cs.includes(String.fromCharCode(0x2028)) && !cs.includes(String.fromCharCode(0x2029)));
  assert.ok(cs.includes('\\u2028') && cs.includes('\\u2029'), 'spelled as escapes');
});
