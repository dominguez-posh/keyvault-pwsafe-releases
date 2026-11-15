// #537 2b "Immer bestätigen": an entry of a vault whose secrets are held back until the person confirms (Windows Hello,
// master password or PIN) – desktop/access-confirm.js. Such an entry leaves the main process "sealed": every secret
// value is replaced by a marker that names its place in the entry. The marker is no secret and no hint of one; the window
// and the extension show it masked and ask the app for the value, a save puts the stored value back (unsealItem).
// Konrad (review c13aed7, H1): a marker counts only at exactly its own place, and only where that place holds a secret –
// in the stored entry and in the one being saved. A marker anywhere else (notes of a login, a text field, another field,
// a passkey's key under another name) is refused: it would copy a secret into a place that leaves the app unsealed.
// Pure functions, no DOM: used by the app's main process, its window and the extension.

export const SEALED_PREFIX = '⁠kv-sealed:';

/** Is this value a marker of a held-back secret? */
export const isSealed = (v) => typeof v === 'string' && v.startsWith(SEALED_PREFIX);
/** The place a marker names ('password', 'fields.2.value', 'pk:<credentialId>' …). */
export const sealedPath = (v) => (isSealed(v) ? v.slice(SEALED_PREFIX.length) : '');
const mark = (path) => SEALED_PREFIX + path;

const SIMPLE = 'password totp'.split(' ');
const NESTED = 'server.tvPassword card.number card.cvc card.pin cert.data'.split(' ').map((p) => p.split('.'));
const NESTED_PLACES = new Set(NESTED.map(([a, b]) => `${a}.${b}`));
const secretField = (f) => !!f && typeof f === 'object' && (!!f.hidden || f.type === 'hidden' || f.type === 'totp');
const FIELD_PLACE = /^fields\.(\d{1,4})\.value$/;

/** Error of a save that carries a marker where it does not belong. */
export class SealedPlaceError extends Error {
  constructor(message = 'Ein zurückgehaltener Wert steht an einer falschen Stelle') {
    super(message);
    this.name = 'SealedPlace';
  }
}

/** Does `place` hold a secret in this entry? (The only places a marker may name and a value may be read from.) */
export function secretPlace(item, place) {
  if (!item || typeof item !== 'object' || typeof place !== 'string' || !place) return false;
  if (SIMPLE.includes(place) || NESTED_PLACES.has(place)) return true;
  if (place === 'notes') return item.type === 'note';
  const m = FIELD_PLACE.exec(place);
  if (m) return Array.isArray(item.fields) && secretField(item.fields[Number(m[1])]);
  if (place.startsWith('pk:')) return place.length > 3 && Array.isArray(item.passkeys) && item.passkeys.some((k) => k?.credentialId === place.slice(3));
  return false;
}

/** Is `place` a field that holds a one-time code secret (TOTP)? */
export const totpPlace = (item, place) => place === 'totp'
  || (FIELD_PLACE.test(String(place)) && item?.fields?.[Number(FIELD_PLACE.exec(place)[1])]?.type === 'totp');

/** The entry with every secret replaced by its marker; `sealed` lists the places. Non-secret values stay. */
export function sealItem(item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  const paths = [];
  for (const k of SIMPLE) if (typeof item[k] === 'string' && item[k]) { out[k] = mark(k); paths.push(k); }
  // A secure note: its text is the secret.
  if (item.type === 'note' && typeof item.notes === 'string' && item.notes) { out.notes = mark('notes'); paths.push('notes'); }
  for (const [a, b] of NESTED) {
    if (typeof item[a]?.[b] === 'string' && item[a][b]) {
      out[a] = { ...(out[a] || item[a]), [b]: mark(`${a}.${b}`) };
      paths.push(`${a}.${b}`);
    }
  }
  if (Array.isArray(item.fields)) {
    out.fields = item.fields.map((f, i) => {
      if (!secretField(f) || typeof f.value !== 'string' || !f.value) return f;
      paths.push(`fields.${i}.value`);
      return { ...f, value: mark(`fields.${i}.value`) };
    });
  }
  if (Array.isArray(item.passkeys)) {
    out.passkeys = item.passkeys.map((k) => (k?.privateKey ? (paths.push(`pk:${k.credentialId}`), { ...k, privateKey: mark(`pk:${k.credentialId}`) }) : k));
  }
  out.sealed = paths;
  return out;
}

/** The stored value at a secret place of the stored entry ('' when there is none, or the place holds no secret). */
export function sealedValue(stored, path) {
  if (!secretPlace(stored, path)) return '';
  if (path.startsWith('pk:')) return stored.passkeys.find((k) => k?.credentialId === path.slice(3))?.privateKey || '';
  const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), stored);
  return typeof v === 'string' ? v : '';
}

/** Every marker in the entry, wherever it is (also nested): [{ keys: ['fields', 2, 'value'], value }]. */
function markersIn(item) {
  const found = [];
  const walk = (v, keys, depth) => {
    if (isSealed(v)) found.push({ keys, value: v });
    else if (v && typeof v === 'object' && depth < 8) for (const [k, x] of Object.entries(v)) walk(x, [...keys, Array.isArray(v) ? Number(k) : k], depth + 1);
    else if (v && typeof v === 'object' && JSON.stringify(v).includes(SEALED_PREFIX)) found.push({ keys, value: '' }); // deeper than any entry: refused
  };
  walk(item, [], 0);
  return found;
}

/** The place a value at these keys stands for ('fields.2.value', 'pk:<id>' for a passkey's key …); '' for any other. */
function placeOf(item, keys) {
  if (keys.length === 1 && (SIMPLE.includes(keys[0]) || keys[0] === 'notes')) return keys[0];
  if (keys.length === 2 && NESTED_PLACES.has(`${keys[0]}.${keys[1]}`)) return `${keys[0]}.${keys[1]}`;
  if (keys.length === 3 && keys[0] === 'fields' && Number.isInteger(keys[1]) && keys[2] === 'value') return `fields.${keys[1]}.value`;
  if (keys.length === 3 && keys[0] === 'passkeys' && Number.isInteger(keys[1]) && keys[2] === 'privateKey') {
    const id = item.passkeys?.[keys[1]]?.credentialId;
    return typeof id === 'string' && id ? `pk:${id}` : '';
  }
  return '';
}

/** Does the entry carry a marker anywhere (also nested)? */
export const hasSealed = (item) => !!item && typeof item === 'object' && markersIn(item).length > 0;

/**
 * Before a save: every marker is replaced by the stored value at its place, so an entry saved while sealed (favourite,
 * folder, a changed title) keeps its secrets. A new value typed over a marker stays. The `sealed` list is dropped.
 * A marker that is not at exactly the place it names, or at a place that holds no secret here or in the stored entry,
 * throws SealedPlaceError – nothing is saved. stored: the entry as stored (null → markers become '').
 */
export function unsealItem(item, stored) {
  if (!item || typeof item !== 'object') return item;
  const { sealed, ...rest } = item;
  const markers = markersIn(rest);
  if (!markers.length) return rest;
  for (const { keys, value } of markers) {
    const place = placeOf(rest, keys);
    if (!place || sealedPath(value) !== place || !secretPlace(rest, place) || (stored && !secretPlace(stored, place))) throw new SealedPlaceError();
  }
  const out = { ...rest };
  const fix = (v) => (isSealed(v) ? sealedValue(stored, sealedPath(v)) : v);
  for (const k of [...SIMPLE, 'notes']) if (isSealed(out[k])) out[k] = fix(out[k]);
  for (const [a, b] of NESTED) if (isSealed(out[a]?.[b])) out[a] = { ...out[a], [b]: fix(out[a][b]) };
  if (Array.isArray(out.fields)) out.fields = out.fields.map((f) => (isSealed(f?.value) ? { ...f, value: fix(f.value) } : f));
  if (Array.isArray(out.passkeys)) out.passkeys = out.passkeys.map((k) => (isSealed(k?.privateKey) ? { ...k, privateKey: fix(k.privateKey) } : k));
  return out;
}
