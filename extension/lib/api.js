// Calls from extension pages to the service worker.

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

/**
 * Copies through the service worker and the desktop app: kept out of Windows' clipboard history and cloud clipboard,
 * cleared again after the configured time (#337). Never the page's own clipboard – that one has no such protection.
 */
export async function copy(text, label = t('Wert')) {
  try {
    await call('copy', { text });
    toast(t('{label} kopiert', { label }));
  } catch (e) {
    toast(t('Kopieren fehlgeschlagen: {message}', { message: e.message }), 'error');
  }
}
