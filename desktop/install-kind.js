// How this copy of Keevault was installed – decides whether the app may update itself (desktop/updater.js).
// No Electron import: unit-tested with plain inputs.

/**
 * 'nsis'  per-user EXE installer: updates itself (electron-updater)
 * 'msix'  Windows Store / MSIX package: updated by the package
 * 'msi'   per-machine MSI: updated by software deployment
 * 'other' macOS/Linux previews
 * 'dev'   not packaged
 *
 * The NSIS uninstaller lies next to the executable as "Uninstall <productName>.exe". Its name is matched loosely:
 * app.getName() returns the package name (keyvault-pwsafe), not the product name (Keevault), which made every
 * EXE installation look like an MSI until 0.7.10.
 */
export function detectInstallKind({ packaged, windowsStore, platform, filesNextToExe }) {
  if (!packaged) return 'dev';
  if (windowsStore) return 'msix';
  if (platform !== 'win32') return 'other';
  return filesNextToExe.some((n) => /^Uninstall .+\.exe$/i.test(n)) ? 'nsis' : 'msi';
}
