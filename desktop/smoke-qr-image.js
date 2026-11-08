// Test image (#492): a screenshot as Electron gives it (BGRA) with a two-factor setup QR code in the style of
// Microsoft's "other authenticator app" page – a dialog on a dimmed page, the code drawn at a size that is no whole
// multiple of the screen pixels (display scaling). Fantasy secret only. For the unit test and the smoke run.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const MS_STYLE_URI = 'otpauth://totp/Contoso%3Afake.user%40contoso.example?secret=abcdefghijklmnop&issuer=Microsoft';

/**
 * @param {{ text?: string, module?: number, scale?: number, width?: number, height?: number, dark?: boolean }} [o]
 *   module: CSS pixels per QR module, scale: the display's scaling, width/height: the screen in CSS pixels.
 */
export function screenWithQr({ text = MS_STYLE_URI, module = 3.66, scale = 1.25, width = 1280, height = 720, dark = false } = {}) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const side = n * module;
  const qx = Math.round(width / 2 - side / 2);
  const qy = Math.round(height / 2 - side / 2);
  const box = { x: qx - 40, y: qy - 90, w: side + 80, h: side + 180 };
  const page = dark ? 20 : 140; // the page behind the dialog, dimmed
  const lum = (cx, cy) => {
    if (cx < box.x || cy < box.y || cx >= box.x + box.w || cy >= box.y + box.h) return (Math.floor(cx / 9) + Math.floor(cy / 15)) % 7 === 0 ? page + 40 : page;
    const mx = Math.floor((cx - qx) / module);
    const my = Math.floor((cy - qy) / module);
    const isDark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
    return isDark ? 0 : 255; // Microsoft draws its code dark on white, also in dark mode
  };
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const bitmap = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) sum += lum((x + ox) / scale, (y + oy) / scale);
      const v = Math.round(sum / 4);
      const i = (y * w + x) * 4;
      bitmap[i] = v; bitmap[i + 1] = v; bitmap[i + 2] = v; bitmap[i + 3] = 255; // BGRA, grey
    }
  }
  return { bitmap, width: w, height: h };
}
