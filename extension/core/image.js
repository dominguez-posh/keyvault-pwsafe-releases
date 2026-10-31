// Logos and entry icons: images are scaled down in the page and stored as base64 data URL (WebP, PNG as
// fallback), small enough for a Key Vault secret (25 KB value limit).

import { t } from './i18n.js';

export const ICON_MAX_CHARS = 12_000;
export const LOGO_MAX_CHARS = 20_000;
const DATA_URL = /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/;

/** Only raster images as data URL (no SVG: it could carry scripts or external references). */
export const isImageDataUrl = (value, max = LOGO_MAX_CHARS) => typeof value === 'string' && value.length <= max && DATA_URL.test(value);

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('Das Bild lässt sich nicht lesen')));
    };
    img.src = url;
  });
}

/** Scales an image file to at most size×size pixels and returns a data URL of at most maxChars characters. */
export async function imageToDataUrl(file, { size = 64, maxChars = ICON_MAX_CHARS } = {}) {
  if (!file || !/^image\//.test(file.type)) throw new Error(t('Bitte eine Bilddatei wählen'));
  const { img, done } = await loadImage(file);
  try {
    const width = img.naturalWidth || size;
    const height = img.naturalHeight || size;
    for (let s = size; s >= 16; s = Math.round(s * 0.75)) {
      const scale = Math.min(s / width, s / height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.75, 0.6]) {
        const url = canvas.toDataURL('image/webp', quality);
        if (url.startsWith('data:image/webp') && isImageDataUrl(url, maxChars)) return url;
      }
      const png = canvas.toDataURL('image/png');
      if (isImageDataUrl(png, maxChars)) return png;
    }
  } finally {
    done();
  }
  throw new Error(t('Das Bild ist zu groß'));
}

/**
 * The website's own icon (the tab's favicon, as the browser reports it) as entry icon: fetched from the site itself
 * or taken from the browser's data URL – no third-party icon service, so no other party learns the vault's hosts.
 * Works in pages and in the service worker (OffscreenCanvas). → data URL or '' (no icon, SVG, too big, error).
 */
export async function faviconToDataUrl(url, { size = 64, maxChars = ICON_MAX_CHARS } = {}) {
  try {
    if (!url || !/^(https:|data:image\/(png|x-icon|vnd\.microsoft\.icon|webp|jpeg|gif))/i.test(url)) return '';
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) return '';
    const blob = await res.blob();
    if (blob.size > 512_000 || /svg/i.test(blob.type)) return '';
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(size / bitmap.width, size / bitmap.height, 1);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    for (const [type, quality] of [['image/webp', 0.9], ['image/png', undefined]]) {
      const out = await canvas.convertToBlob({ type, quality });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataUrl = `data:${out.type};base64,${btoa(bin)}`;
      if (isImageDataUrl(dataUrl, maxChars)) return dataUrl;
    }
  } catch {
    // No icon is fine.
  }
  return '';
}

/** File picker → data URL (null if cancelled). */
export function pickImage(options) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml';
    input.onchange = () => (input.files[0] ? imageToDataUrl(input.files[0], options).then(resolve, reject) : resolve(null));
    input.click();
  });
}
