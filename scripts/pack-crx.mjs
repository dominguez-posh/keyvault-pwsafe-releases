// Builds dist/kvpwsafe-extension.crx and dist/update.xml from the self-hosting ZIP (npm run ext:pack first).
// Needs the extension's private key extension-key.pem (local only, never in the repository).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCrx, updateManifest } from './crx.mjs';
import { EXTENSION_UPDATE } from './release-urls.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const zipPath = join(root, 'dist', `kvpwsafe-extension-${version}.zip`);
const keyPath = join(root, 'extension-key.pem');
if (!existsSync(zipPath)) throw new Error(`${zipPath} fehlt – zuerst npm run ext:pack`);
if (!existsSync(keyPath)) throw new Error('extension-key.pem fehlt – der Schlüssel der Erweiterung liegt nur lokal (npm run ext:key)');

const { crx, id } = buildCrx(readFileSync(zipPath), readFileSync(keyPath, 'utf8'));
writeFileSync(join(root, 'dist', 'kvpwsafe-extension.crx'), crx);
writeFileSync(join(root, 'dist', 'update.xml'), updateManifest({ id, version, codebase: EXTENSION_UPDATE.crx }));
console.log(`CRX ${version} für ${id}: dist/kvpwsafe-extension.crx, dist/update.xml`);
