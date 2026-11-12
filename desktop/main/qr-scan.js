// QR code on the screen (#492): screenshots of all screens, read with jsQR in the main process. The images stay here;
// the window only gets the decoded text (the TOTP editor checks it is an otpauth:// link or a Base32 secret).

import { desktopCapturer, screen } from 'electron';
import jsQR from 'jsqr';
import { bgraToRgba, findQrText, getSmokeScreens, scanThrottle } from '../qr-decode.js';
import { t } from '../../extension/core/i18n.js';
import { smokeTest } from './boot.js';
import { requireOpen } from './guards.js';

const throttle = scanThrottle(); // #497

async function captureScreens() {
  const displays = screen.getAllDisplays();
  const width = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const height = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  return sources.map((s) => ({ bitmap: s.thumbnail.toBitmap(), ...s.thumbnail.getSize() }));
}

export async function scanScreenQr() {
  requireOpen(); // #497: only in the unlocked app, at most one screenshot every 2 s
  if (!throttle.take()) throw new Error(t('Bitte kurz warten und dann erneut scannen.'));
  const capture = (smokeTest && getSmokeScreens()) || captureScreens;
  for (const shot of await capture()) {
    if (!shot.width || !shot.height) continue;
    const text = findQrText(jsQR, bgraToRgba(shot.bitmap), shot.width, shot.height);
    if (text) return text;
  }
  return '';
}
