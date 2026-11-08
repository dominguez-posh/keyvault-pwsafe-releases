// QR code on the screen (#492): screenshots of all screens, read with jsQR in the main process. The images stay here;
// the window only gets the decoded text (the TOTP editor checks it is an otpauth:// link or a Base32 secret).

import { desktopCapturer, screen } from 'electron';
import jsQR from 'jsqr';
import { bgraToRgba, findQrText, getSmokeScreens } from '../qr-decode.js';
import { smokeTest } from './boot.js';

async function captureScreens() {
  const displays = screen.getAllDisplays();
  const width = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const height = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  return sources.map((s) => ({ bitmap: s.thumbnail.toBitmap(), ...s.thumbnail.getSize() }));
}

export async function scanScreenQr() {
  const capture = (smokeTest && getSmokeScreens()) || captureScreens;
  for (const shot of await capture()) {
    if (!shot.width || !shot.height) continue;
    const text = findQrText(jsQR, bgraToRgba(shot.bitmap), shot.width, shot.height);
    if (text) return text;
  }
  return '';
}
