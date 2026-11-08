import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bgraToRgba, findQrText } from '../desktop/qr-decode.js';
import { MS_STYLE_URI, screenWithQr } from '../desktop/smoke-qr-image.js';
import { parseTotp } from '../extension/core/totp.js';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');

// #492: the desktop editor reads the setup QR code from a screenshot of the screen (BGRA, as Electron gives it).
const read = (shot) => findQrText(jsQR, bgraToRgba(shot.bitmap), shot.width, shot.height);

test('#492 screenshot BGRA becomes RGBA', () => {
  assert.deepEqual([...bgraToRgba(Uint8Array.from([1, 2, 3, 9, 10, 20, 30, 0]))], [3, 2, 1, 255, 30, 20, 10, 255]);
});

test('#492 a Microsoft-style setup QR on a scaled screen is read and accepted as TOTP', () => {
  for (const [scale, module] of [[1, 3.66], [1.25, 3.66], [1.5, 3], [2, 4]]) {
    const text = read(screenWithQr({ scale, module }));
    assert.equal(text, MS_STYLE_URI, `scaling ${scale}, ${module} px per module`);
    const cfg = parseTotp(text);
    assert.equal(cfg.issuer, 'Microsoft');
    assert.equal(cfg.account, 'fake.user@contoso.example');
    assert.equal(cfg.secret.length, 10, 'lower-case Base32 secret of 16 characters');
  }
  assert.equal(read(screenWithQr({ dark: true })), MS_STYLE_URI, 'page in dark mode');
});

test('#492 a screen without a QR code gives no text', () => {
  const shot = screenWithQr();
  shot.bitmap.fill(200);
  assert.equal(read(shot), '');
});
