// Static checks without dependencies: syntax of every JS file, relative imports resolve, files referenced by
// the manifest and by HTML pages exist, JSON files parse.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['extension', 'desktop', 'scripts', 'test'];
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = dirs.flatMap((d) => walk(join(root, d)));
for (const file of files) {
  const rel = relative(root, file);
  if (/\.(m|c)?js$/.test(file)) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
      problems.push(`${rel}: ${e.stderr.toString().split('\n').slice(0, 5).join(' ')}`);
    }
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = resolve(dirname(file), m[1] || m[2]);
      if (!existsSync(target)) problems.push(`${rel}: Import nicht gefunden: ${m[1] || m[2]}`);
    }
  }
  if (file.endsWith('.json')) {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${rel}: ${e.message}`);
    }
  }
  if (file.endsWith('.html')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      if (!existsSync(resolve(dirname(file), m[1]))) problems.push(`${rel}: Datei nicht gefunden: ${m[1]}`);
    }
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.storage.managed_schema,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((c) => c.js),
];
for (const f of referenced) if (!existsSync(join(root, 'extension', f))) problems.push(`manifest.json: Datei fehlt: ${f}`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.length} Dateien geprüft`);
