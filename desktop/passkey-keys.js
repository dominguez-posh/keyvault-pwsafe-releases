// #439: private passkey keys never go to the browser. The app hands items out without them and puts the stored ones back
// when the browser saves the item again (no Electron here, so unit tests can load it).
import { t } from '../extension/core/i18n.js';

/** The item as the browser may see it – every passkey without its private key. */
export const withoutPasskeyKeys = (item) => (item?.passkeys?.length ? { ...item, passkeys: item.passkeys.map((k) => ({ ...k, privateKey: '' })) } : item);

/**
 * An item saved by the browser, with the stored private key put back for each passkey it already had (matched by
 * credentialId). A key the browser sends for a known passkey is ignored; a new passkey keeps the key it was created with.
 */
export function withStoredKeys(item, stored) {
  if (!item?.passkeys?.length) return item;
  const keys = new Map((stored?.passkeys || []).map((k) => [k.credentialId, k.privateKey]));
  if (!keys.size) return item;
  return { ...item, passkeys: item.passkeys.map((k) => (keys.has(k.credentialId) ? { ...k, privateKey: keys.get(k.credentialId) } : k)) };
}

/** Key Vault answers 404, a file vault throws "Nicht gefunden" for an entry that does not exist. */
export const isMissingItem = (e) => e?.status === 404 || e?.message === 'Nicht gefunden' || e?.message === t('Nicht gefunden');

/**
 * The item with its stored keys put back. `read` fetches the stored item: only "does not exist" counts as a new entry
 * (no stored keys); any other read error stops the save, otherwise the save would overwrite the private keys with nothing.
 */
export async function restoreStoredKeys(item, read) {
  if (!item?.passkeys?.length || !item.id) return item;
  let stored = null;
  try {
    stored = await read();
  } catch (e) {
    if (!isMissingItem(e)) throw new Error(t('Der Eintrag konnte nicht gelesen werden – Passkey nicht gespeichert, bitte noch einmal versuchen'));
  }
  return withStoredKeys(item, stored);
}
