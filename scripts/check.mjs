// Static checks without dependencies: syntax of every JS file, relative imports resolve, files referenced by
// the manifest and by HTML pages exist, JSON files parse.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['extension', 'desktop', 'scripts', 'test', 'setup-tool'];
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
  { match: 'setup-tool/', allow: ['setup-tool/'], bare: false, hint: 'Einrichtungstool (#501): eigenständig, keine Pakete, nichts aus der App' },
];
// How long a file may get (lines). A file that reaches its limit is split by subject instead of growing – no new
// monoliths. The listed files are the known exceptions: they may shrink, and their limit is only raised on purpose.
const MAX_LINES = 600;
const LINE_LIMITS = {
  'desktop/main.js': 250, // start-up only – features go into desktop/main/
  'desktop/renderer/app.js': 60, // start only – features go into desktop/renderer/app/
  'extension/lib/jsqr.js': Infinity, // third-party library
  'extension/core/i18n-en.js': Infinity, // translations
  'extension/core/session.js': 1445,
  'extension/content/content.js': 1300,
  'desktop/smoke-features.js': 1445, // #469 + #464 + #471 + #472 + #458 + #476 combined (measured), +2 for #491, +1 for #487, +1 for #478, +1 for #486, +1 for #500, +1 for #480, +1 for #517, +1 for #515, +1 for #529
  'extension/background.js': 1113, // #462/#467/#464 + #468 + #459 combined (measured), +2 for #495
  'desktop/mcp.js': 602, // +1 for #480 (required fields of the vault), +1 for #517
  'desktop/main/smoke.js': 947, // measured after merging main into #455 (#470/#471/#472), +2 for #507, +5 for #519, +2 for #435, +2 for #512, +3 for #526
  'extension/core/ui-item.js': 900,
  'extension/core/filevault.js': 823, // +11 for #435 (key change within the same generation, refusal code), +12 for #521 (check in key-proof.js, own proof before saving)
  'scripts/extension-smoke.mjs': 854, // #458 + #476 + popup-url + #459 + #463 + #502 + smoke-limit cleanup combined (measured), +3 for #495, +2 for #509
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

// ---------------------------------------------------------------- release signing (#378)
// Nothing but the API route may reach the signing key: no MCP tool, bridge, browser or Windows-provider module and no
// script imports the signing modules. A new importer fails the check and needs a decision, not a quick fix.
const SIGNING_IMPORTS = {
  'desktop/main/release-sign.js': ['desktop/main/api/release.js'],
  'desktop/release-key.js': ['desktop/main/release-sign.js'],
  'desktop/main/api/release.js': ['desktop/main/api/index.js', 'desktop/main/smoke.js'],
};
for (const file of files) {
  if (!/\.(m|c)?js$/.test(file)) continue;
  const rel = posixRel(file);
  if (rel.startsWith('test/')) continue; // tests read the modules to check them
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = posixRel(resolve(dirname(file), m[1] || m[2] || m[3]));
    if (SIGNING_IMPORTS[target] && !SIGNING_IMPORTS[target].includes(rel)) problems.push(`${rel}: importiert ${target} – nur ${SIGNING_IMPORTS[target].join(', ')} dürfen das (Signierschlüssel, #378)`);
  }
}
for (const rel of ['desktop/main/release-sign.js', 'desktop/release-key.js']) {
  const src = readFileSync(join(root, rel), 'utf8').replace(/\/\/.*$/gm, '');
  if (/\.pem|process\.env|KEY_PEM/i.test(src)) problems.push(`${rel}: liest Schlüsselmaterial aus Datei oder Umgebung – der Schlüssel liegt nur im verschlüsselten Speicher der App (#378)`);
}

// The command and bridge modules never name the signing functions at all (an import is not the only way: a handler
// could call api.signRelease). The two API names live in api/release.js and the menu.
for (const rel of ['desktop/main/browser.js', 'desktop/main/agents.js', 'desktop/main/windows-passkeys.js', 'desktop/bridge.js', 'desktop/mcp.js']) {
  const src = readFileSync(join(root, rel), 'utf8').replace(/\/\/.*$/gm, '');
  if (/signRelease|setupReleaseKey|releaseApi|release-sign|release-key/.test(src)) problems.push(`${rel}: nennt eine Signierfunktion – Agenten, Browser und Windows-Anbieter haben keinen Weg dorthin (#378)`);
}
// A file of the app that .gitignore swallows is not in the commit (desktop/release/ was, #378 B4): a fresh checkout would lack it.
try {
  const swallowed = execFileSync('git', ['ls-files', '-o', '-i', '--exclude-standard', 'desktop', 'extension'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of swallowed) problems.push(`${f}: von .gitignore verschluckt – gehört die Datei zur App, Ordner umbenennen oder Ausnahme eintragen`);
} catch { /* no git here (unpacked source): nothing to compare */ }

// ---------------------------------------------------------------- setup tool (#501)
// The PowerShell module must run in Windows PowerShell 5.1, which reads files without BOM as ANSI: a file with umlauts
// needs a UTF-8 BOM. Every exported function exists, and every script parses (where PowerShell is installed).
const psFiles = files.filter((f) => /\.ps(m|d)?1$/.test(f) && posixRel(f).startsWith('setup-tool/'));
for (const f of psFiles) {
  const buf = readFileSync(f);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!bom && buf.some((b) => b > 0x7f)) problems.push(`${posixRel(f)}: Umlaute ohne UTF-8-BOM – Windows PowerShell 5.1 liest die Datei sonst falsch`);
}
const psd1 = join(root, 'setup-tool', 'KeevaultSetup', 'KeevaultSetup.psd1');
if (existsSync(psd1)) {
  const exported = [...readFileSync(psd1, 'utf8').replace(/^[\s\S]*FunctionsToExport\s*=\s*@\(([\s\S]*?)\)[\s\S]*$/, '$1').matchAll(/'([A-Za-z-]+)'/g)].map((m) => m[1]);
  const defined = new Set(psFiles.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^function\s+([A-Za-z-]+)/gm)].map((m) => m[1])));
  if (!exported.length) problems.push('setup-tool/KeevaultSetup/KeevaultSetup.psd1: FunctionsToExport ist leer');
  for (const name of exported) if (!defined.has(name)) problems.push(`setup-tool/KeevaultSetup/KeevaultSetup.psd1: exportiert ${name}, die Funktion fehlt`);
}
if (process.platform === 'win32' && psFiles.length) {
  const parse = 'foreach ($f in $args) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { "$f`:$($x.Extent.StartLineNumber): $($x.Message)" } }';
  try {
    const command = `& { ${parse} } ${psFiles.map((f) => `'${f.replace(/'/g, "''")}'`).join(' ')}`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/).filter(Boolean)) problems.push(relative(root, line));
  } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`setup-tool: PowerShell-Syntaxprüfung fehlgeschlagen: ${String(e.stderr || e.message).split('\n')[0]}`);
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

// The origins of the extension smoke's fake sign-in pages are set only in the smoke's own copy (#381, #367).
if (!/^const SIGN_IN_TEST_ORIGINS = \[\];$/m.test(readFileSync(join(root, 'extension', 'core', 'pagefit.js'), 'utf8'))) {
  problems.push('extension/core/pagefit.js: SIGN_IN_TEST_ORIGINS muss leer sein (nur die Testkopie des Smoke setzt Ursprünge)');
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.length} Dateien geprüft`);
