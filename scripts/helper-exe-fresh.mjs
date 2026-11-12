// #526: the smoke run copies, types and clears the clipboard through windows/out/Keevault-Update.exe. A copy built from
// older windows/Setup sources fails these checks in ways that look like product bugs (0.9.33: clipboard red three times
// with a helper from four commits back). On Windows a smoke run starts only with a helper at least as new as its sources.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const HELPER = 'windows/out/Keevault-Update.exe';
export const SETUP_SOURCES = 'windows/Setup';
const SOURCE = /\.(cs|csproj|manifest)$/i;

export const BUILD_HINT = [
  'dotnet build windows/Setup -c Release -o windows/out/setup-update --nologo --no-incremental',
  'copy windows\\out\\setup-update\\Keevault-Setup.exe windows\\out\\Keevault-Update.exe',
  '(dotnet: %LOCALAPPDATA%\\Microsoft\\dotnet)',
].join('\n  ');

/** Newest modification time (ms) of the helper's sources below dir, 0 without any. */
export function newestSource(dir, { list = readdirSync, stat = statSync } = {}) {
  let newest = 0;
  for (const name of list(dir)) {
    const p = join(dir, name);
    const s = stat(p);
    if (s.isDirectory()) {
      if (!/^(bin|obj)$/i.test(name)) newest = Math.max(newest, newestSource(p, { list, stat }));
    } else if (SOURCE.test(name)) {
      newest = Math.max(newest, s.mtimeMs);
    }
  }
  return newest;
}

/** Why the smoke run must not start with this helper, or null. Only Windows uses it. */
export function helperExeProblem(root, { platform = process.platform, list = readdirSync, stat = statSync } = {}) {
  if (platform !== 'win32') return null;
  let built;
  try {
    built = stat(join(root, HELPER)).mtimeMs;
  } catch {
    return `${HELPER} fehlt. Erst bauen:\n  ${BUILD_HINT}`;
  }
  const sources = newestSource(join(root, SETUP_SOURCES), { list, stat });
  if (sources > built) {
    return `${HELPER} ist älter als die Quellen in ${SETUP_SOURCES} (${new Date(built).toISOString()} < ${new Date(sources).toISOString()}). Neu bauen:\n  ${BUILD_HINT}`;
  }
  return null;
}
