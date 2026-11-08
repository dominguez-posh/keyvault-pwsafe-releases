// #470: the personal vault (a file vault) can be exported like the other vaults. Entries from a file vault carry
// folders, favourites and the OTP secret (#469: the secret stays in an export), and the CSV holds all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToCsv } from '../extension/core/export.js';

test('export of personal entries: folders, favourite, OTP secret and umlauts end up in the CSV', () => {
  const csv = itemsToCsv([
    { type: 'login', title: 'Steuer', username: 'me', password: 'pw1', totp: 'JBSWY3DPEHPK3PXP', urls: ['https://elster.de'], folder: 'Geschäft', favorite: true, fields: [], notes: '' },
    { type: 'note', title: 'Privat', urls: [], fields: [{ name: 'PIN', value: '42' }], folder: '', notes: 'Grüße' },
  ]);
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines.length, 4, 'header, two entries, trailing break');
  assert.equal(lines[1], 'Geschäft,1,login,Steuer,,,https://elster.de,me,pw1,JBSWY3DPEHPK3PXP,,,,,,');
  assert.match(lines[2], /^,,note,Privat,Grüße,PIN: 42,/);
});
