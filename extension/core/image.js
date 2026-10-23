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
