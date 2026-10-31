import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseTotp } from '../extension/core/totp.js';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-generator');

// The popup scans the website's two-factor QR code with the vendored jsQR (extension/lib/jsqr.js). The copy in the
// extension must stay identical to the pinned npm package, and it must read an otpauth:// code of typical size.
test('vendored jsQR equals the pinned package and decodes an otpauth QR code', () => {
  const vendored = readFileSync(new URL('../extension/lib/jsqr.js', import.meta.url), 'utf8');
  const packaged = readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8');
  assert.equal(vendored, packaged, 'extension/lib/jsqr.js differs from node_modules/jsqr/dist/jsQR.js – copy it again');

  const jsQR = require('jsqr');
  const uri = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=6&period=30';
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  const modules = qr.getModuleCount();
  const scale = 4;
  const quiet = 4 * scale;
  const size = modules * scale + 2 * quiet;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.isDark(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((quiet + y * scale + dy) * size + quiet + x * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const found = jsQR(data, size, size, { inversionAttempts: 'attemptBoth' });
  assert.equal(found?.data, uri);
  assert.equal(parseTotp(found.data).secret.length > 0, true, 'the decoded text is accepted as TOTP configuration');
});
