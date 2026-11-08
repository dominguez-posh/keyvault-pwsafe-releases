// Popup: links from an entry open only as http(s); javascript:, data:, file:, chrome-extension: and the like are
// refused with a message and never reach chrome.tabs.create.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWebUrl, openWebUrl } from '../extension/popup/open-url.js';

test('popup openUrl: only http(s) opens, everything else is refused with a message', () => {
  for (const ok of ['https://login.contoso.com/', 'http://intranet:8080/x', 'HTTPS://Portal.Azure.com', '  https://a.b  ']) {
    assert.equal(isWebUrl(ok), true, ok);
  }
  for (const bad of ['javascript:alert(1)', 'JavaScript://%0aalert(1)', 'data:text/html,<script>x</script>', 'file:///C:/Windows/win.ini',
    'chrome-extension://abc/popup/popup.html', 'chrome://settings', 'vbscript:x', 'ms-settings:', 'https:/x', '//evil.example', '', null, undefined]) {
    assert.equal(isWebUrl(bad), false, String(bad));
  }
  const opened = [];
  const notes = [];
  const ctx = { open: (u) => opened.push(u), notify: (m) => notes.push(m) };
  assert.equal(openWebUrl('javascript:alert(1)', ctx), false);
  assert.equal(openWebUrl('file:///C:/Windows/win.ini', ctx), false);
  assert.deepEqual(opened, []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /http:\/\/ oder https:\/\/|http:\/\/ or https:\/\//);
  assert.equal(openWebUrl(' https://login.contoso.com/ ', ctx), true);
  assert.deepEqual(opened, ['https://login.contoso.com/']);
});

test('popup: every openUrl goes through openWebUrl (no direct chrome.tabs.create with an entry URL)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
  assert.equal((src.match(/chrome\.tabs\.create\(/g) || []).length, 1, 'only inside openEntryUrl');
  assert.match(src, /const openEntryUrl = \(url\) => openWebUrl\(url,/);
  assert.doesNotMatch(src, /openUrl:\s*\(url\)\s*=>\s*chrome\.tabs\.create/);
});
