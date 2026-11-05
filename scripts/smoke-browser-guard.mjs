// Keeps a Keevault installed by policy out of the extension smoke (#346). ExtensionInstallForcelist applies to every
// profile, the test profile included, and that extension talks to the real app. Two layers: the test browser has no
// network, so a fresh profile cannot download it; if it shows up anyway, the smoke stops before it opens a test page.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Browser flag value: the imitated hosts go to the local server, everything else fails to resolve. */
export function hostResolverRules(mappedHosts) {
  return [
    ...mappedHosts.map((host) => `MAP ${host} 127.0.0.1`),
    'EXCLUDE localhost',
    'EXCLUDE 127.0.0.1',
    'EXCLUDE [::1]',
    'MAP * ~NOTFOUND',
  ].join(',');
}

/** Extension ID that a manifest `key` (base64 public key) produces. */
export function extensionIdFromKey(key) {
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function installedNames(idDir) {
  const names = [];
  for (const version of readdirSync(idDir)) {
    try {
      names.push(String(JSON.parse(readFileSync(join(idDir, version, 'manifest.json'), 'utf8')).name));
    } catch {
      // Still being unpacked, or not an extension version.
    }
  }
  return names;
}

/**
 * The foreign Keevault in the test browser, or null. Looks at the installed extensions of the profile and at the
 * running targets. The copy under test is loaded unpacked from another folder and has its own ID.
 */
export function foreignKeevault({ profile, targets = [], realId }) {
  const running = targets.find((t) => String(t.url).startsWith(`chrome-extension://${realId}/`));
  if (running) return `${realId} läuft (${running.url})`;
  const dir = join(profile, 'Default', 'Extensions');
  if (!existsSync(dir)) return null;
  for (const id of readdirSync(dir)) {
    if (id === 'Temp') continue;
    if (id === realId) return `${realId} ist installiert`;
    const idDir = join(dir, id);
    if (installedNames(idDir).some((name) => /keevault/i.test(name))) return `${id} ist installiert (Name Keevault)`;
  }
  return null;
}
