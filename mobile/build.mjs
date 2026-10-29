// Builds the mobile web bundle: www/app.js (+ shared extension/core + Capacitor plugins) → www/bundle.js, plus the
// shared stylesheet and the app logo. Then `npx cap sync android` copies www into the native project.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const www = join(here, 'www');

mkdirSync(join(www, 'core', 'styles'), { recursive: true });
copyFileSync(join(root, 'extension', 'styles', 'app.css'), join(www, 'core', 'styles', 'app.css'));
copyFileSync(join(root, 'desktop', 'assets', 'icon.png'), join(www, 'logo.png'));

const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
await build({
  entryPoints: [join(www, 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(www, 'bundle.js'),
  sourcemap: false,
  minify: false,
  define: { __KEEVAULT_MOBILE_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
console.log(`mobile bundle ${version} → www/bundle.js`);
