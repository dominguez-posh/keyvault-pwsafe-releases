// Builds the per-machine MSI for admins (GPO, Intune, SCCM) from release/win-unpacked:
//   release/Keevault-<version>.msi    msiexec /i Keevault-<version>.msi /qn  [KV_NO_POLICY=1]
// Installs to C:\Program Files\Keevault for all users and runs installer/setup.ps1 -Scope Machine as SYSTEM:
// trust for the passkey provider's certificate and the browser extension policy (KV_NO_POLICY=1 skips the policy).
// Removing the product (not an upgrade) undoes both. Per-user parts (passkey provider, browser connection) are set up
// by the app on its first start, as with the EXE installer.
// WiX 3 tools (candle/light) come from electron-builder's cache (downloaded by its "msi" target).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'release', 'win-unpacked');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// Never change: Windows recognizes the product (and replaces older versions) by it.
const UPGRADE_CODE = '{86BFB281-FD2C-4C9A-9BF5-A8A1B3EEEFA4}';
const SHORTCUT_GUID = '{70A92108-8D35-4F6F-B75B-CC5FFE5F33BD}';

function findWix() {
  const cache = join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const stack = [cache];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    if (existsSync(join(dir, 'candle.exe')) && existsSync(join(dir, 'light.exe'))) return dir;
    for (const n of readdirSync(dir)) if (/wix/i.test(n) && statSync(join(dir, n)).isDirectory()) stack.push(join(dir, n));
  }
  throw new Error('WiX nicht gefunden – einmal "npx electron-builder --win msi --dir" ausführen, das lädt die Werkzeuge herunter');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const id = (prefix, path) => `${prefix}${createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 24)}`;

if (!existsSync(join(source, 'Keevault.exe'))) throw new Error(`${source}\\Keevault.exe fehlt – zuerst electron-builder ausführen`);
const components = [];
function directory(dir, depth) {
  const pad = '  '.repeat(depth);
  let xml = '';
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(source, full);
    if (statSync(full).isDirectory()) {
      xml += `${pad}<Directory Id="${id('d', rel)}" Name="${esc(name)}">\n${directory(full, depth + 1)}${pad}</Directory>\n`;
    } else {
      const cid = id('c', rel);
      components.push(cid);
      xml += `${pad}<Component Id="${cid}" Guid="*" Win64="yes"><File Id="${id('f', rel)}" Name="${esc(name)}" Source="${esc(full)}" KeyPath="yes" /></Component>\n`;
    }
  }
  return xml;
}
const files = directory(source, 5);

const ps = '&quot;[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe&quot; -NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLFOLDER]resources\\setup.ps1&quot;';
const cert = '-CertificatePath &quot;[INSTALLFOLDER]resources\\provider\\KvPwSafe-Test.cer&quot;';
const wxs = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Product Id="*" Name="Keevault" Language="1033" Codepage="65001" Version="${version}" Manufacturer="Keevault" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64" Description="Keevault ${version}" Comments="Passwort- und Passkey-Manager für Azure Key Vault" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of Keevault is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Icon Id="keevault.ico" SourceFile="${esc(join(root, 'desktop', 'assets', 'icon.ico'))}" />
    <Property Id="ARPPRODUCTICON" Value="keevault.ico" />
    <Property Id="ARPURLINFOABOUT" Value="https://keevault.de" />
    <Property Id="KV_NO_POLICY" Secure="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="Keevault">
${files}        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder" />
    </Directory>

    <Component Id="StartMenu" Directory="ProgramMenuFolder" Guid="${SHORTCUT_GUID}" Win64="yes">
      <Shortcut Id="KeevaultShortcut" Name="Keevault" Target="[INSTALLFOLDER]Keevault.exe" WorkingDirectory="INSTALLFOLDER" />
      <RegistryValue Root="HKLM" Key="Software\\Keevault" Name="InstallDir" Type="string" Value="[INSTALLFOLDER]" KeyPath="yes" />
    </Component>

    <Feature Id="Main" Title="Keevault" Level="1">
${components.map((c) => `      <ComponentRef Id="${c}" />`).join('\n')}
      <ComponentRef Id="StartMenu" />
    </Feature>

    <!-- Device setup as SYSTEM (certificate trust + browser policy). Deferred EXE actions format their command line
         when the script is written, so [INSTALLFOLDER] resolves. Failures are logged in ProgramDataKeevaultsetup.log
         and never abort the installation. -->
    <CustomAction Id="DeviceSetup" Directory="INSTALLFOLDER" Execute="deferred" Impersonate="no" Return="ignore"
      ExeCommand="${ps} -Action Install -Scope Machine ${cert}" />
    <CustomAction Id="DeviceSetupNoPolicy" Directory="INSTALLFOLDER" Execute="deferred" Impersonate="no" Return="ignore"
      ExeCommand="${ps} -Action Install -Scope Machine ${cert} -SkipExtensionPolicy" />
    <CustomAction Id="DeviceCleanup" Directory="INSTALLFOLDER" Execute="deferred" Impersonate="no" Return="ignore"
      ExeCommand="${ps} -Action Uninstall -Scope Machine ${cert}" />
    <CustomAction Id="DeviceCleanupNoPolicy" Directory="INSTALLFOLDER" Execute="deferred" Impersonate="no" Return="ignore"
      ExeCommand="${ps} -Action Uninstall -Scope Machine ${cert} -SkipExtensionPolicy" />

    <InstallExecuteSequence>
      <Custom Action="DeviceSetup" Before="InstallFinalize">NOT REMOVE AND NOT KV_NO_POLICY</Custom>
      <Custom Action="DeviceSetupNoPolicy" Before="InstallFinalize">NOT REMOVE AND KV_NO_POLICY</Custom>
      <Custom Action="DeviceCleanup" Before="RemoveFiles">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND NOT KV_NO_POLICY</Custom>
      <Custom Action="DeviceCleanupNoPolicy" Before="RemoveFiles">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND KV_NO_POLICY</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
`;

const work = join(root, 'release', 'msi-build');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'Keevault.wxs'), wxs);
const wix = findWix();
const out = join(root, 'release', `Keevault-${version}.msi`);
execFileSync(join(wix, 'candle.exe'), ['-nologo', '-arch', 'x64', '-out', join(work, 'Keevault.wixobj'), join(work, 'Keevault.wxs')], { stdio: 'inherit' });
// ICE validation needs a running Windows Installer service with admin rights in some environments – skipped (-sval).
execFileSync(join(wix, 'light.exe'), ['-nologo', '-sval', '-out', out, join(work, 'Keevault.wixobj')], { stdio: 'inherit' });
console.log(`MSI: ${out} (${components.length} Dateien)`);
