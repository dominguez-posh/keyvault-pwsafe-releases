// #537 2b: copying one secret of an entry in the service worker ('password', a marker's place of a sealed entry, 'totp' →
// the current code). The popup closes when the app asks for its confirmation ("Immer bestätigen"); the service worker
// finishes the copy. usableItem(containerId, id, 'copy') asks the app for a sealed entry; secureCopy(text) copies.

import { sealedValue } from '../core/sealed.js';
import { totpCode } from '../core/totp.js';
import { t } from '../core/i18n.js';

export const secretCopy = (usableItem, secureCopy) => async ({ containerId, id, path }) => {
  const item = await usableItem(containerId, id, 'copy');
  const place = String(path || 'password');
  const value = place === 'totp' ? (item.totp ? (await totpCode(item.totp))?.code : '') : sealedValue(item, place);
  if (!value) throw new Error(place === 'password' ? t('Kein Passwort gespeichert') : t('Nicht gefunden'));
  return secureCopy(value);
};
