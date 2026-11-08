// Links from an entry (website, portals, Bastion, custom URL fields) open in a new tab only as http(s). An entry's
// URL is data anyone with write access to the vault can set: javascript:, data:, file:, chrome-extension: and the
// like are refused with a message instead of being handed to chrome.tabs.create.

import { t } from '../core/i18n.js';

export const isWebUrl = (url) => /^https?:\/\//i.test(String(url ?? '').trim());

export const NOT_WEB = () => t('Nur Adressen mit http:// oder https:// lassen sich öffnen.');

/** open(url) opens the tab, notify(message) shows the refusal. Returns whether it opened. */
export function openWebUrl(url, { open, notify }) {
  if (!isWebUrl(url)) {
    notify(NOT_WEB());
    return false;
  }
  open(String(url).trim());
  return true;
}
