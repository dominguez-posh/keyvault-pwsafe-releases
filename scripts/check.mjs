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

// ---------------------------------------------------------------- structure rules (docs/ARCHITEKTUR.md, "Code-Struktur")
// Who may import whom. The first area that matches a file decides. allow/deny: folders or files a relative import may
// (not) point to; bare: packages and node: modules (true, false or a list). Keeps the layers apart when several
// people work on the code: the shared core has no dependencies, the window never reaches for Node or Electron.
const AREAS = [
  { match: 'extension/core/', allow: ['extension/core/'], bare: false, hint: 'gemeinsamer Kern (Browser und Node): nur extension/core, keine Pakete' },
  { match: 'desktop/renderer/', allow: ['desktop/renderer/', 'extension/core/'], deny: ['desktop/renderer/app.js'], bare: false, hint: 'Fenster (Sandbox): nur desktop/renderer und extension/core, kein Node/Electron; Hauptprozess über app/ipc.js' },
  { match: 'desktop/passkey/', allow: ['desktop/passkey/', 'extension/core/'], bare: ['electron'], hint: 'Passkey-Fenster: nur eigener Ordner und extension/core' },
  { match: 'desktop/main/', allow: ['desktop/', 'extension/core/', 'scripts/release-notes.mjs'], deny: ['desktop/main.js', 'desktop/renderer/'], bare: true, hint: 'Hauptprozess-Module: nicht die Startdatei main.js und nichts aus dem Fenster importieren' },
  { match: 'desktop/main.js', allow: ['desktop/', 'extension/core/'], deny: ['desktop/renderer/'], bare: true, hint: 'Startdatei: nichts aus dem Fenster importieren' },
  { match: 'desktop/', allow: ['desktop/', 'extension/core/'], deny: ['desktop/main/', 'desktop/main.js', 'desktop/renderer/'], bare: true, hint: 'Dienste des Hauptprozesses (auth, files, bridge …) kennen weder desktop/main/ noch das Fenster' },
  { match: 'extension/', allow: ['extension/'], bare: false, hint: 'Erweiterung: nur extension/, keine Pakete (kein Build-Schritt)' },
];
// How long a file may get (lines). A file that reaches its limit is split by subject instead of growing – no new
// monoliths. The listed files are the known exceptions: they may shrink, and their limit is only raised on purpose.
const MAX_LINES = 600;
const LINE_LIMITS = {
  'desktop/main.js': 250, // start-up only – features go into desktop/main/
  'desktop/renderer/app.js': 60, // start only – features go into desktop/renderer/app/
  'extension/lib/jsqr.js': Infinity, // third-party library
  'extension/core/i18n-en.js': Infinity, // translations
  'extension/core/session.js': 1400,
  'extension/content/content.js': 1300,
  'desktop/smoke-features.js': 1300,
  'extension/background.js': 1100,
  'desktop/main/smoke.js': 900,
  'extension/core/ui-item.js': 900,
  'extension/core/filevault.js': 800,
  'scripts/extension-smoke.mjs': 800,
};
const posixRel = (p) => relative(root, p).replace(/\\/g, '/');
const under = (rel, prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix);
for (const file of files) {
  if (!/\.(m|c)?js$/.test(file)) continue;
  const rel = posixRel(file);
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
  const limit = LINE_LIMITS[rel] ?? MAX_LINES;
  if (lines > limit) problems.push(`${rel}: ${lines} Zeilen, erlaubt sind ${limit} – nach Thema in Module aufteilen (docs/ARCHITEKTUR.md, „Code-Struktur“)`);
  const area = AREAS.find((a) => under(rel, a.match));
  if (!area) continue;
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!spec.startsWith('.')) {
      const ok = area.bare === true || (Array.isArray(area.bare) && area.bare.includes(spec));
      if (!ok) problems.push(`${rel}: Import von „${spec}“ nicht erlaubt – ${area.hint}`);
      continue;
    }
    const target = posixRel(resolve(dirname(file), spec));
    if (!area.allow.some((p) => under(target, p)) || area.deny?.some((p) => under(target, p))) problems.push(`${rel}: Import von ${target} nicht erlaubt – ${area.hint}`);
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
