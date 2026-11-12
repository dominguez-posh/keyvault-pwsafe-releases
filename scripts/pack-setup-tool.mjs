// Packs the portable setup tool (#501 part e) as release/Keevault-Einrichtungstool-<version>.zip:
//   setup-tool/            the module, the wizard and the start script (without tests/)
//   setup-tool/policy/     installer/policy (ADMX/ADML, Intune script) for the device policy package
//   setup-tool/version.json  version and commit; the updater compares and checks it
//   setup-tool/KeevaultSetup/Data/update-keys.json  the keys of desktop/update-verify.js (the same check as the app)
//   extension/styles/app.css  the app's styles the wizard uses
// Only files under version control (git ls-files), never ignored local files.
// The ZIP is a release asset, so SHA256SUMS.txt and with it the signed latest.yml cover it. PowerShell files get a
// UTF-8 BOM (Windows PowerShell 5.1). Authenticode signing of the scripts follows with 1.0.
//   node scripts/pack-setup-tool.mjs [--out=<dir>] [--version=<x.y.z>]
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.mjs';
import { UPDATE_KEYS } from '../desktop/update-verify.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const version = arg('version') || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version ${version} ist nicht x.y.z`);
const out = arg('out') || join(root, 'release');
let commit = '';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { commit = ''; }

// Only versioned files: an ignored local file (a key, kvpwsafe.config.json, notes) never ends up in the package.
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  .map((f) => join(root, ...f.split('/')))
  .filter((f) => existsSync(f));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (name, data) => (/\.ps(m|d)?1$/i.test(name) && !data.subarray(0, 3).equals(BOM) ? Buffer.concat([BOM, data]) : data);
const rel = (base, p) => relative(base, p).split(sep).join('/');

const files = [];
const add = (name, data) => files.push({ name, data: withBom(name, data) });
const tool = join(root, 'setup-tool');
for (const p of tracked('setup-tool')) {
  const name = rel(tool, p);
  if (name.startsWith('tests/') || name === 'version.json' || name === 'KeevaultSetup/Data/update-keys.json') continue;
  add(`setup-tool/${name}`, readFileSync(p));
}
const policy = join(root, 'installer', 'policy');
for (const p of tracked('installer/policy')) add(`setup-tool/policy/${rel(policy, p)}`, readFileSync(p));
add('setup-tool/version.json', Buffer.from(`${JSON.stringify({ version, commit }, null, 2)}\n`));
add('setup-tool/KeevaultSetup/Data/update-keys.json', Buffer.from(`${JSON.stringify(UPDATE_KEYS.map(({ id, alg, publicKey }) => ({ id, alg, publicKey })), null, 2)}\n`));
add('extension/styles/app.css', readFileSync(join(root, 'extension', 'styles', 'app.css')));
files.sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(out, { recursive: true });
const target = join(out, `Keevault-Einrichtungstool-${version}.zip`);
writeFileSync(target, zip(files));
console.log(`${target} erstellt (${files.length} Dateien)`);
