// Release notes of the current version from CHANGELOG.md ("## <version>" up to the next "## ").
//   node scripts/release-notes.mjs    appends them as "releaseNotes: |" to release/latest.yml (replacing an earlier
//                                     block) – run before update-key.mjs signs the manifest, so the text the app
//                                     shows in its update dialog is covered by the signature – and writes
//                                     release/release-notes.md (without the heading) for the GitHub release text
// Fails when CHANGELOG.md has no section for the version in package.json: every release needs its notes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

export function sectionFor(changelog, ver) {
  const lines = String(changelog).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## ${ver.replace(/\./g, '\\.')}(\\s|$)`).test(l));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

/** latest.yml with the notes as a literal block scalar (two-space indent, empty lines kept). */
export function withReleaseNotes(manifest, notes) {
  const base = String(manifest).replace(/\r\n/g, '\n').replace(/^releaseNotes:\s*\|-?[ \t]*\n(?:(?:[ \t]+[^\n]*)?\n)*/m, '').replace(/\n*$/, '\n');
  const block = notes.split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n');
  return `${base}releaseNotes: |\n${block}\n`;
}

/**
 * The newest `count` sections up to and including `ver` (newest first): an app that skips versions shows the
 * changes of every version it missed – it picks the ones newer than itself.
 */
export function recentSections(changelog, ver, count = 15) {
  const text = String(changelog).replace(/\r\n/g, '\n');
  const heads = [...text.matchAll(/^## (\d+\.\d+\.\d+)\b.*$/gm)];
  const start = heads.findIndex((m) => m[1] === ver);
  if (start < 0) return '';
  return heads.slice(start, start + count).map((m) => sectionFor(text, m[1])).join('\n\n');
}

// Run as a script (release); imported by the unit tests only for the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const notes = sectionFor(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md hat keinen Abschnitt "## ${version}" – bitte vor dem Release nachtragen.`);
  const file = join(root, 'release', 'latest.yml');
  // The manifest carries the newest sections (skipped versions too), the GitHub release text only this version.
  writeFileSync(file, withReleaseNotes(readFileSync(file, 'utf8'), recentSections(changelog, version)));
  writeFileSync(join(root, 'release', 'release-notes.md'), `${notes.replace(/^## .*\n/, '').trim()}\n`);
  console.log(`Release-Notes ${version} in ${file} und release/release-notes.md eingetragen.`);
}
