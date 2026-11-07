// Checks the packed app against the commit (used by scripts/release.mjs, tested in test/release-verify.test.js).
import { execFileSync, execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The packed app must be exactly the committed code: every file in app.asar that git knows is compared byte for byte
 * with HEAD, and every .js file must parse. Runs right after electron-builder, before anything is signed or published.
 */
export async function verifyPackage(asarPath, root, tmp = join(root, "release", "asar-check")) {
  const { extractAll } = await import('@electron/asar');
  const dir = tmp;
  rmSync(dir, { recursive: true, force: true });
  try { extractAll(asarPath, dir); } catch { /* native modules may stay unpacked – the JavaScript is extracted */ }
  const tracked = new Set(execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const problems = [];
  let checked = 0;
  for (const file of walk(dir)) {
    const rel = file.slice(dir.length + 1).split('\\').join('/');
    // A file of the app's own code that git does not know (ignored by .gitignore, #378 B4) is not in the commit: stop.
    if (!tracked.has(rel) && /^(desktop|extension)\//.test(rel)) { problems.push(`${rel}: im Paket, aber nicht im Commit (git kennt die Datei nicht)`); continue; }
    if (!tracked.has(rel) || rel === 'package.json') continue;
    checked++;
    const head = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (!head.equals(readFileSync(file))) problems.push(`${rel}: weicht vom Commit ab`);
    else if (/\.(m?js|cjs)$/.test(rel)) {
      try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (e) { problems.push(`${rel}: Syntaxfehler ${String(e.stderr || '').split('\n').find((l) => /Error/.test(l)) || ''}`); }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  if (!checked) throw new Error('app.asar enthält keine bekannten Dateien');
  if (problems.length) throw new Error(`Paket fehlerhaft:\n${problems.join('\n')}`);
  console.log(`app.asar geprüft: ${checked} Dateien wie im Commit`);
}
