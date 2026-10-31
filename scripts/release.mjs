// Release runner without PowerShell – the same steps as scripts/release.ps1 (which stays as documentation and
// fallback). Reason: Sophos on the build machine blocks file writes of pwsh.exe/powershell.exe since 2026-10-30/31
// (CryptoGuard reported the build scripts as ransomware), node is not affected.
//   node scripts/release.mjs                 build everything locally (release/Keevault-Setup-<version>.exe, MSI, MSIX)
//   node scripts/release.mjs --publish       plus: source to the public repo, GitHub release v<version>
//   node scripts/release.mjs --previews      also attach macOS/Linux (release/ci) and the Android APK (off since
//                                            2026-10-31: the website offers Windows only)
// Local on purpose: extension-key.pem and update-key.pem never leave this machine.

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const publish = process.argv.includes('--publish');
const previews = process.argv.includes('--previews');
// VS Code's terminal sets this; child processes (npx, electron-builder) must not inherit it.
delete process.env.ELECTRON_RUN_AS_NODE;
process.chdir(root);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const extVersion = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version;
if (version !== extVersion) throw new Error(`Version in package.json (${version}) und extension/manifest.json (${extVersion}) unterscheiden sich.`);

const R = (...p) => join(root, ...p);
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });
const shell = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const BOM = '\uFEFF';
function step(name, fn) {
  console.log(`\x1b[36m== ${name}\x1b[0m`);
  try {
    return fn();
  } catch (e) {
    throw new Error(`${name} fehlgeschlagen: ${e.message}`);
  }
}
/** Replace instead of overwrite: deleting and creating looks less like encryption to CryptoGuard than rewriting in place. */
function copyFresh(from, to) {
  if (existsSync(to)) rmSync(to, { force: true });
  copyFileSync(from, to);
}
function findFile(dir, name, mustInclude = '') {
  if (!existsSync(dir)) return null;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      const r = findFile(p, name, mustInclude);
      if (r) return r;
    } else if (n.toLowerCase() === name && p.includes(mustInclude)) return p;
  }
  return null;
}

// --- Windows SDK build tools (MakeAppx/SignTool from the NuGet package, downloaded once by windows/build.ps1) -------
const tools = R('windows/out/tools');
const makeappx = findFile(tools, 'makeappx.exe', `${'\\'}x64${'\\'}`);
const signtool = findFile(tools, 'signtool.exe', `${'\\'}x64${'\\'}`);
if (!makeappx || !signtool) throw new Error('MakeAppx/SignTool fehlen – einmal windows/build.ps1 ausführen (lädt Microsoft.Windows.SDK.BuildTools).');

/** Thumbprint of the newest valid signing certificate with this subject in CurrentUser\My (certutil, any locale). */
function certThumbprint(subject) {
  const text = out('certutil', ['-user', '-store', 'My']);
  const blocks = text.split(/^=+ .* =+\r?$/m).filter((b) => b.includes(subject));
  const candidates = blocks.map((b) => {
    const hash = /\(sha1\):\s*([0-9a-f]{40})/i.exec(b)?.[1];
    const notAfter = /^\s*(?:NotAfter|Nicht nach):\s*(.+)$/im.exec(b)?.[1] || '';
    const year = Number(/(\d{4})/.exec(notAfter)?.[1] || 0);
    return { hash, year };
  }).filter((c) => c.hash && c.year >= new Date().getFullYear());
  candidates.sort((a, b) => b.year - a.year);
  if (!candidates.length) throw new Error(`Zertifikat ${subject} fehlt oder ist abgelaufen (windows/build.ps1 legt es an).`);
  return candidates[0].hash;
}
const publisher = pkg.build.appx.publisher; // "CN=KeyVault PwSafe Test" – same certificate as the passkey provider
const thumbprint = certThumbprint(publisher);
const sign = (file) => run(signtool, ['sign', '/fd', 'SHA256', '/sha1', thumbprint, '/s', 'My', file]);

/** First dotnet with an SDK 10 or newer (the provider targets net10.0; SDK 8 may come first on PATH). */
function findDotnet() {
  const candidates = ['dotnet', join(process.env.ProgramFiles || '', 'dotnet/dotnet.exe'), join(process.env.LOCALAPPDATA || '', 'Microsoft/dotnet/dotnet.exe')];
  const found = candidates.find((d) => {
    try { return out(d, ['--list-sdks']).split('\n').some((l) => Number.parseInt(l, 10) >= 10); } catch { return false; }
  });
  if (!found) throw new Error('.NET SDK 10 nicht gefunden (https://dot.net).');
  return found;
}

/** Setup/update window (windows/Setup, .NET Framework 4.8 WPF); payload = NSIS setup to embed, or none. */
function buildSetupWindow(outDir, payload) {
  rmSync(outDir, { recursive: true, force: true });
  const args = ['build', R('windows/Setup'), '-c', 'Release', '-o', outDir, '--nologo', '--no-incremental'];
  if (payload) args.push(`-p:Payload=${payload}`);
  run(findDotnet(), args);
  return join(outDir, 'Keevault-Setup.exe');
}

// --- 1. Passkey provider (MSIX) --------------------------------------------------------------------------------------
step('Passkey-Anbieter (MSIX)', () => {
  const project = R('windows/PasskeyProvider');
  const outDir = R('windows/out');
  const stage = join(outDir, 'stage');
  mkdirSync(outDir, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  // First dotnet with an SDK 10 or newer (the project targets net10.0; SDK 8 may come first on PATH).
  const candidates = ['dotnet', join(process.env.ProgramFiles || '', 'dotnet/dotnet.exe'), join(process.env.LOCALAPPDATA || '', 'Microsoft/dotnet/dotnet.exe')];
  const dotnet = candidates.find((d) => {
    try { return out(d, ['--list-sdks']).split('\n').some((l) => Number.parseInt(l, 10) >= 10); } catch { return false; }
  });
  if (!dotnet) throw new Error('.NET SDK 10 nicht gefunden (https://dot.net).');
  run(dotnet, ['publish', project, '-c', 'Release', '-o', stage, '--nologo']);
  for (const n of readdirSync(stage)) if (n.endsWith('.pdb')) rmSync(join(stage, n), { force: true });
  cpSync(join(project, 'Assets'), join(stage, 'Assets'), { recursive: true });
  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // replaceAll: the placeholders also appear in the manifest's comment.
  writeFileSync(join(stage, 'AppxManifest.xml'), readFileSync(join(project, 'AppxManifest.xml'), 'utf8').replaceAll('__PUBLISHER__', escXml(publisher)).replaceAll('__VERSION__', `${version}.0`));
  const msix = join(outDir, 'KvPwSafe.PasskeyProvider.msix');
  if (existsSync(msix)) rmSync(msix, { force: true });
  run(makeappx, ['pack', '/d', stage, '/p', msix, '/o', '/nv']);
  // Public part of the certificate: devices must trust it before the MSIX installs.
  const cer = join(outDir, 'KvPwSafe-Test.cer');
  if (existsSync(cer)) rmSync(cer, { force: true });
  run('certutil', ['-user', '-store', 'My', thumbprint, cer]);
  if (!existsSync(cer)) throw new Error('Zertifikat konnte nicht exportiert werden.');
  sign(msix);
});

// The app ships the update window without payload: it hands updates over to it (desktop/updater.js).
step('Update-Fenster (Keevault-Update.exe)', () => {
  copyFresh(buildSetupWindow(R('windows/out/setup-update'), null), R('windows/out/Keevault-Update.exe'));
});

// --- 2. Browser extension ---------------------------------------------------------------------------------------------
step('Erweiterung (ZIP)', () => run(process.execPath, [R('scripts/pack-extension.mjs')]));
step('Erweiterung (CRX + update.xml)', () => run(process.execPath, [R('scripts/pack-crx.mjs')]));

// --- 3. Installers (EXE + MSIX) ---------------------------------------------------------------------------------------
let unpacked = R('release/win-unpacked');
step('Installer (EXE + MSIX)', () => {
  // electron-builder empties release/win-unpacked first. A test build still running from there locks the folder
  // (EBUSY); then build next to it in release/build and copy the installers over.
  let output = 'release';
  if (existsSync(unpacked)) {
    try {
      renameSync(unpacked, `${unpacked}.old`);
      rmSync(`${unpacked}.old`, { recursive: true, force: true });
    } catch {
      console.warn('release/win-unpacked ist gesperrt (läuft Keevault.exe daraus?) – baue nach release/build');
      output = 'release/build';
    }
  }
  shell(`npx electron-builder --win nsis appx --publish never -c.directories.output=${output}`);
  if (output !== 'release') {
    unpacked = R(output, 'win-unpacked');
    for (const n of readdirSync(R(output))) {
      if (/^(Keevault-.*\.(exe|msix|blockmap)|latest\.yml)$/.test(n)) copyFresh(R(output, n), R('release', n));
    }
  }
});
// Release notes (CHANGELOG.md) go into the manifest before it is signed: the app shows them in its update dialog.
step('Release-Notes aus CHANGELOG.md', () => run(process.execPath, [R('scripts/release-notes.mjs')]));
// The app only accepts update manifests signed with update-key.pem (desktop/update-verify.js).
step('Update-Manifest signieren (Ed25519)', () => run(process.execPath, [R('scripts/update-key.mjs'), 'sign', 'release/latest.yml']));
step('Installer für Administratoren (MSI)', () => run(process.execPath, [R('scripts/build-msi.mjs')], { env: { ...process.env, KV_UNPACKED_DIR: unpacked } }));
step('MSIX signieren', () => sign(R(`release/Keevault-${version}.msix`)));

// --- 4. IT material ---------------------------------------------------------------------------------------------------
step('Geräte-Skript für IT/Intune (Zertifikat eingebettet)', () => {
  const cer = readFileSync(R('windows/out/KvPwSafe-Test.cer')).toString('base64');
  // BOM: Windows PowerShell 5.1 (Intune) reads the umlauts correctly only with it.
  writeFileSync(R('release/Keevault-Geraet-Einrichten.ps1'), BOM + readFileSync(R('installer/setup.ps1'), 'utf8').replace(/^\uFEFF/, '').replace('__CERTIFICATE_BASE64__', cer));
});
step('Richtlinien-Vorlagen (ADMX für GPO/Intune + Intune-Skript)', () => {
  const stage = R('release/policy');
  rmSync(stage, { recursive: true, force: true });
  cpSync(R('installer/policy'), stage, { recursive: true });
  const ps = join(stage, 'Keevault-Richtlinie-Intune.ps1');
  writeFileSync(ps, BOM + readFileSync(ps, 'utf8').replace(/^\uFEFF/, ''));
  const zip = R('release/Keevault-Richtlinien.zip');
  if (existsSync(zip)) rmSync(zip, { force: true });
  // Windows' own bsdtar writes ZIP files (-a by extension); Git's GNU tar on PATH does not.
  run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', stage, ...readdirSync(stage)]);
});

// --- 5. Assets ------------------------------------------------------------------------------------------------------
const setup = R(`release/Keevault-Setup-${version}.exe`);
// The website links to releases/latest/download/Keevault-Setup.exe: the setup window in Keevault's design with the
// NSIS setup embedded (windows/Setup). The versioned NSIS setup stays the update package: latest.yml (+ blockmap) is
// what the app's update check reads via https://keevault.de/update/ (website/php/api/dl.php).
step('Setup im Keevault-Design (Keevault-Setup.exe)', () => copyFresh(buildSetupWindow(R('windows/out/setup-full'), setup), R('release/Keevault-Setup.exe')));
const msi = R(`release/Keevault-${version}.msi`);
const msix = R(`release/Keevault-${version}.msix`);
copyFresh(msi, R('release/Keevault.msi'));
copyFresh(msix, R('release/Keevault.msix'));
copyFresh(R('windows/out/KvPwSafe-Test.cer'), R('release/Keevault-Zertifikat.cer'));
const assets = [setup, R('release/Keevault-Setup.exe'), msi, R('release/Keevault.msi'), msix, R('release/Keevault.msix'), R('release/Keevault-Zertifikat.cer'),
  R('release/latest.yml'), R('release/latest.yml.sig'), `${setup}.blockmap`, R('release/Keevault-Geraet-Einrichten.ps1'), R('release/Keevault-Richtlinien.zip'),
  R('dist/kvpwsafe-extension.crx'), R('dist/update.xml'), R(`dist/kvpwsafe-extension-${version}-firefox.zip`)];
if (previews) {
  // Mobile app (preview): the Android debug APK goes along when it was built (mobile/README.md).
  const apk = R('mobile/android/app/build/outputs/apk/debug/app-debug.apk');
  if (existsSync(apk)) {
    const mobileVersion = JSON.parse(readFileSync(R('mobile/package.json'), 'utf8')).version;
    const target = R(`release/Keevault-Mobile-${mobileVersion}.apk`);
    copyFresh(apk, target);
    assets.push(target);
  }
  // macOS/Linux (preview, unsigned): built by the GitHub workflow "Desktop macOS/Linux" and downloaded with
  // `gh run download <id> -D release/ci`; attached when present, plus copies under stable names for the website.
  const ci = R('release/ci');
  if (existsSync(ci)) {
    const stable = { [`Keevault-${version}-mac-arm64.dmg`]: 'Keevault-mac-arm64.dmg', [`Keevault-${version}-mac-x64.dmg`]: 'Keevault-mac-x64.dmg',
      [`Keevault-${version}-linux-x86_64.AppImage`]: 'Keevault-linux-x86_64.AppImage', [`Keevault-${version}-linux-amd64.deb`]: 'Keevault-linux-amd64.deb' };
    const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(ci).filter((f) => basename(f).startsWith(`Keevault-${version}-`))) {
      const target = R('release', basename(f));
      copyFresh(f, target);
      assets.push(target);
      if (stable[basename(f)]) {
        const copy = R('release', stable[basename(f)]);
        copyFresh(f, copy);
        assets.push(copy);
      }
    }
  }
}
for (const a of assets) if (!existsSync(a)) throw new Error(`${a} fehlt`);

// Software bill of materials (CycloneDX, production dependencies) and SHA-256 checksums of every asset: published
// with the release and on the download page, so a download can be checked against what was built here.
step('SBOM (CycloneDX)', () => {
  const sbom = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(R(`release/Keevault-${version}-sbom.cdx.json`), sbom);
  assets.push(R(`release/Keevault-${version}-sbom.cdx.json`));
});
step('Prüfsummen (SHA256SUMS.txt)', () => {
  const lines = assets.map((a) => `${createHash('sha256').update(readFileSync(a)).digest('hex')}  ${basename(a)}`);
  writeFileSync(R('release/SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  assets.push(R('release/SHA256SUMS.txt'));
});
console.log(`\x1b[32mFertig: ${setup}\x1b[0m`);

// --- 6. Publish -----------------------------------------------------------------------------------------------------
if (publish) {
  // Public repository = source-available code + releases (browsers fetch update.xml/CRX from it without signing in).
  // The private repository keeps website, license tool and notes; scripts/export-public.mjs leaves them out.
  const publicRepo = 'dominguez-posh/keyvault-pwsafe-releases';
  const pub = join(dirname(root.replace(/[\\/]$/, '')), 'keevault-public');
  step('Quellcode ins öffentliche Repo', () => {
    if (!existsSync(join(pub, '.git'))) run('git', ['clone', `https://github.com/${publicRepo}.git`, pub]);
    run('git', ['-C', pub, 'pull', '--ff-only']);
    run(process.execPath, [R('scripts/export-public.mjs'), pub]);
    run('git', ['-C', pub, 'add', '-A']);
    const changed = execFileSync('git', ['-C', pub, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    if (changed) run('git', ['-C', pub, 'commit', '-m', `Keevault ${version}`]);
    run('git', ['-C', pub, 'push', 'origin', 'HEAD']);
  });
  const commit = out('git', ['-C', pub, 'rev-parse', 'HEAD']).trim();
  let notes = 'EXE (pro Benutzer), MSI (pro Gerät, GPO/Intune: msiexec /i Keevault.msi /qn) und MSIX (Zertifikat Keevault-Zertifikat.cer vorher vertrauen). Installer mit Passkey-Anbieter und Browser-Erweiterung (Edge/Chrome per Richtlinie).';
  const previewNames = [];
  if (assets.some((a) => a.endsWith('mac-arm64.dmg'))) previewNames.push('macOS (DMG, unsigniert: „Trotzdem öffnen“)');
  if (assets.some((a) => a.endsWith('.AppImage'))) previewNames.push('Linux (AppImage/deb)');
  if (assets.some((a) => a.endsWith('.apk'))) previewNames.push('Android (APK, Debug-Build)');
  if (previewNames.length) notes += ` Vorschau: ${previewNames.join(', ')} – siehe https://keevault.de/download.html.`;
  notes += ` Quellcode dieser Version: Tag v${version}.`;
  // Changelog (scripts/release-notes.mjs) plus the fixed text, as a UTF-8 file.
  const notesFile = R('release/release-notes.md');
  writeFileSync(notesFile, `${readFileSync(notesFile, 'utf8').trim()}\n\n${notes}\n`);
  step(`GitHub-Release v${version}`, () => {
    // The tag points at exactly the source the installer was built from (verifiable, see README).
    run('gh', ['release', 'create', `v${version}`, ...assets, '--repo', publicRepo, '--target', commit, '--title', `Keevault ${version}`, '--notes-file', notesFile]);
  });
}
