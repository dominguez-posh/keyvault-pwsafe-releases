// Offscreen document: clipboard access for the service worker (copy one-time codes, clear after timeout).

import { sha256, toHex } from '../core/util.js';

function write(text) {
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
}

function read() {
  const area = document.createElement('textarea');
  document.body.append(area);
  area.focus();
  document.execCommand('paste');
  const value = area.value;
  area.remove();
  return value;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  (async () => {
    if (msg.cmd === 'copy') write(msg.text);
    if (msg.cmd === 'clearIf') {
      const current = read();
      // Only clear when the clipboard still holds what Keevault put there.
      if (current && toHex(await sha256(current)) === msg.hash) write('');
    }
  })().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
