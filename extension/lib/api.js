// Calls from extension pages to the service worker.

import { sha256, toHex } from '../core/util.js';
import { toast } from '../core/dom.js';
import { t } from '../core/i18n.js';

export async function call(cmd, args = {}) {
  const res = await chrome.runtime.sendMessage({ cmd, ...args });
  if (!res) throw new Error(t('Keine Antwort vom Hintergrunddienst'));
  if (!res.ok) {
    const e = new Error(res.error.message);
    e.name = res.error.name;
    e.status = res.error.status;
    throw e;
  }
  return res.result;
}

/** Copies to the clipboard and lets the service worker clear it again after the configured time. */
export async function copy(text, label = t('Wert')) {
  await navigator.clipboard.writeText(text);
  call('clipboardCopied', { hash: toHex(await sha256(text)) }).catch(() => {});
  toast(t('{label} kopiert', { label }));
}
