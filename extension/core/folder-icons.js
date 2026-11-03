// Symbols for folders: one of the app's stroke icons by name, or a small image of its own (data URL, e.g. a
// KeePass custom icon). Stored per vault as { [folder path]: symbol }; no entry = the plain folder.

// Offered in the picker, in this order.
export const FOLDER_ICONS = ['folder', 'star', 'key', 'lock', 'shield', 'vault', 'users', 'user', 'briefcase', 'home', 'globe', 'cloud',
  'server', 'monitor', 'terminal', 'database', 'wifi', 'phone', 'mail', 'card', 'coin', 'cart', 'certificate', 'note', 'book', 'archive',
  'wrench', 'settings', 'printer', 'camera', 'heart', 'flag', 'clock', 'ac-id', 'ac-apps'];

// Own images: PNG, JPEG, GIF or WebP (no SVG – it could carry script), small enough for the folder list of a Key Vault.
export const MAX_FOLDER_IMAGE = 6000;
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** A valid symbol or '' (the plain folder). */
export function normalizeFolderIcon(value) {
  const v = String(value || '').trim();
  if (!v || v === 'folder') return '';
  if (FOLDER_ICONS.includes(v)) return v;
  return v.length <= MAX_FOLDER_IMAGE && IMAGE_URL.test(v) ? v : '';
}

export const isFolderImage = (value) => String(value || '').startsWith('data:');

// KeePass standard group icons (IconID 0–68) → the nearest own symbol; folder icons (48, 49) and those without a match
// stay the plain folder.
const KEEPASS = {
  0: 'key', 1: 'globe', 2: 'flag', 3: 'server', 5: 'users', 6: 'wrench', 7: 'note', 8: 'globe', 9: 'ac-id', 10: 'note', 11: 'camera',
  12: 'wifi', 13: 'key', 15: 'printer', 16: 'star', 17: 'database', 18: 'monitor', 19: 'mail', 20: 'settings', 21: 'note', 22: 'note',
  23: 'monitor', 25: 'mail', 26: 'database', 27: 'database', 28: 'note', 29: 'terminal', 30: 'terminal', 31: 'printer', 32: 'ac-apps',
  34: 'settings', 35: 'monitor', 36: 'archive', 37: 'coin', 38: 'monitor', 39: 'clock', 40: 'mail', 41: 'flag', 42: 'database', 43: 'archive',
  44: 'note', 45: 'clock', 46: 'flag', 47: 'archive', 50: 'archive', 51: 'lock', 52: 'lock', 53: 'shield', 54: 'note', 55: 'camera',
  56: 'book', 57: 'note', 58: 'user', 59: 'wrench', 60: 'home', 61: 'star', 62: 'terminal', 63: 'note', 65: 'book', 66: 'coin',
  67: 'certificate', 68: 'phone',
};

export const keepassIcon = (id) => KEEPASS[Number(id)] || '';

/** Moves the symbols of a folder tree along with a rename ("A" → "B" also moves "A/x" → "B/x"); to '' drops them. */
export function moveFolderIcons(icons, from, to) {
  const patch = {};
  for (const [path, value] of Object.entries(icons || {})) {
    if (path !== from && !path.startsWith(`${from}/`)) continue;
    patch[path] = '';
    if (to) patch[to + path.slice(from.length)] = value;
  }
  return patch;
}
