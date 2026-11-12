// QR code on the screen (#492): the desktop editor reads the two-factor setup code a website shows (e.g. Microsoft's
// "other authenticator app" QR) from a screenshot, like the extension does with the visible tab. Only the decoded text
// leaves the main process. No Electron here: the unit test feeds it its own images.

// Smoke run only (desktop/smoke-otp-secret.js): screenshots of its own instead of the real screens; main/qr-scan.js
// takes them only in a smoke run.
let smokeScreens = null;
export const setSmokeScreens = (fn) => { smokeScreens = fn; };
export const getSmokeScreens = () => smokeScreens;

/** Electron's NativeImage.toBitmap() on Windows: BGRA. jsQR wants RGBA. */
export function bgraToRgba(bgra) {
  const out = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = 255;
  }
  return out;
}

/** The image at factor f (< 1), each target pixel the mean of its source block. */
export function shrink(rgba, width, height, f) {
  const w = Math.max(1, Math.round(width * f));
  const h = Math.max(1, Math.round(height * f));
  const out = new Uint8ClampedArray(w * h * 4);
  const step = 1 / f;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * step);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * step)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * step);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * step)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Text of the first QR code found: full size, then half size for very large codes. '' when there is none. */
export function findQrText(jsQR, rgba, width, height) {
  for (const f of [1, 0.5]) {
    const img = f === 1 ? { data: rgba, width, height } : shrink(rgba, width, height, f);
    const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (found?.data) return found.data;
  }
  return '';
}

/**
 * #497: at most one screenshot per interval. The window asks for a scan only on a click on the scan button; a script in
 * the window (XSS) must not photograph the screen in a loop. take() → true when a scan may run now.
 */
export const SCAN_INTERVAL_MS = 2000;
export function scanThrottle(intervalMs = SCAN_INTERVAL_MS, now = Date.now) {
  let last = -Infinity;
  return {
    take() {
      const t = now();
      if (t - last < intervalMs) return false;
      last = t;
      return true;
    },
  };
}
