// Packs the extension into dist/ as ZIP files:
//   kvpwsafe-extension-<version>.zip        for "Load unpacked"/self-hosting (keeps the fixed ID)
//   kvpwsafe-extension-<version>-store.zip  for Edge Add-ons / Chrome Web Store (without "key")
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const out = join(root, 'dist');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(src).map((p) => ({ name: relative(src, p).split(sep).join('/'), data: readFileSync(p) }));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const storeManifest = { ...manifest };
delete storeManifest.key;
// Stores update their extensions themselves and reject a foreign update URL.
delete storeManifest.update_url;
const storeFiles = files.map((f) => (f.name === 'manifest.json' ? { name: f.name, data: Buffer.from(`${JSON.stringify(storeManifest, null, 2)}\n`) } : f));
// Firefox (MV3): event page instead of a service worker, no offscreen documents, gecko ID for native messaging.
const firefoxManifest = { ...storeManifest, background: { scripts: [manifest.background.service_worker], type: manifest.background.type || 'module' } };
firefoxManifest.permissions = (firefoxManifest.permissions || []).filter((p) => p !== 'offscreen');
firefoxManifest.browser_specific_settings = { gecko: { id: 'keevault@keevault.de', strict_min_version: '128.0' } };
const firefoxFiles = files.map((f) => (f.name === 'manifest.json' ? { name: f.name, data: Buffer.from(`${JSON.stringify(firefoxManifest, null, 2)}\n`) } : f));

mkdirSync(out, { recursive: true });
const base = `kvpwsafe-extension-${manifest.version}`;
writeFileSync(join(out, `${base}.zip`), zip(files));
writeFileSync(join(out, `${base}-store.zip`), zip(storeFiles));
writeFileSync(join(out, `${base}-firefox.zip`), zip(firefoxFiles));
console.log(`dist/${base}.zip, dist/${base}-store.zip und dist/${base}-firefox.zip erstellt (${files.length} Dateien)`);
