// Where this build comes from (#445): "release" only when scripts/release.mjs built it. It writes the kind into the
// packaged package.json (electron-builder -c.extraMetadata.kvBuild, no extra file, so nothing the commit does not know
// ends up in app.asar). Anything else is a Developer build: a source run, `npm run dist`, an unstamped package.
// The local release build of phase 2 (build, sign in the app, --publish-only) is built by release.mjs, so it is a release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

let cached = null;

/** The commit is stored with a leading "g" (as in git describe): the builder's command line would read digits as a number. */
export const stampCommit = (hash) => `g${hash}`;

/** Pure part: kvBuild of package.json (or undefined), whether the app runs packaged, a git lookup for source runs only. */
export function kindFrom(kvBuild, { packaged, git }) {
  if (kvBuild?.kind === 'release') return { developer: false, commit: '' };
  const stamped = String(kvBuild?.commit || '').replace(/^g/, '');
  let commit = /^[0-9a-f]{7,40}$/.test(stamped) ? stamped.slice(0, 7) : '';
  // #420: a Dev release (first stage, private repo only); its stage is fixed in the build (extension/core/channel.js).
  // Not a Developer build: it updates like a release, only from its own feed (part B of #420).
  if (kvBuild?.kind === 'dev') return { developer: false, dev: true, commit };
  if (!commit && !packaged) commit = git() || ''; // a packaged build never starts git
  return { developer: true, commit };
}

/** Whether a module directory lies inside app.asar; Windows paths use "\", macOS and Linux "/" (#461). */
export const isPackagedDir = (dir) => /[\\/]app\.asar(?:[\\/]|$)/i.test(String(dir));

/** Smoke only: pretends the build is a release (or, with null, undoes it), so the Stable/Early Access label can be checked. */
export function overrideBuildKindForSmoke(kind) {
  cached = kind;
}

export function buildKind() {
  if (cached) return cached;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let kvBuild;
  try {
    kvBuild = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')).kvBuild;
  } catch { /* no package.json */ }
  const packaged = isPackagedDir(dir);
  const git = () => {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
  };
  return (cached = kindFrom(kvBuild, { packaged, git }));
}
