// electron-builder afterPack hook: flips Electron fuses in the packaged binary (Electron security checklist).
// RunAsNode stays on – the native-messaging host and the MCP host start Keevault with ELECTRON_RUN_AS_NODE=1.
// Off: NODE_OPTIONS and --inspect/--inspect-brk, so nothing can be injected into the installed app that way.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

module.exports = async function afterPack(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  const name = packager.appInfo.productFilename;
  const binary = platform === 'darwin'
    ? path.join(appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
    : platform === 'win32'
      ? path.join(appOutDir, `${name}.exe`)
      : path.join(appOutDir, packager.executableName);
  // asar integrity: electron-builder embeds the hash of app.asar (Windows resource / Info.plist); with the fuse on,
  // Electron refuses a modified archive. Linux has no integrity resource, there the fuse stays off.
  const integrity = platform === 'win32' || platform === 'darwin';
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrity,
    [FuseV1Options.OnlyLoadAppFromAsar]: integrity,
  });
  console.log(`  • fuses flipped in ${path.basename(binary)}`);
};
