// Company settings from the registry – set by Group Policy (ADMX in installer/policy) or Intune:
//   HKLM\SOFTWARE\Policies\Keevault          (computer, wins)  values: see VALUES below (strings and DWORDs)
//   HKCU\SOFTWARE\Policies\Keevault          (user)
//   …\Keevault\Vaults                        value name = display name, data = vault URL[;tenant ID]
// Read with "reg export" (UTF-16 file): exact strings incl. umlauts, no dependency on the console code page.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POLICY_KEY = 'SOFTWARE\\Policies\\Keevault';

// Registry value → setting (and its type).
const VALUES = {
  TenantId: { setting: 'tenantId', type: 'string' },
  ClientId: { setting: 'clientId', type: 'string' },
  UnlockPrompt: { setting: 'unlockPrompt', type: 'string' },
  Language: { setting: 'language', type: 'string' },
  UpdateMode: { setting: 'updateMode', type: 'string' },
  AutoLockMinutes: { setting: 'autoLockMinutes', type: 'number' },
  ClipboardSeconds: { setting: 'clipboardSeconds', type: 'number' },
  RequirePin: { setting: 'requirePin', type: 'boolean' },
  McpEnabled: { setting: 'mcpEnabled', type: 'boolean' },
  OfflineMirror: { setting: 'offlineMirror', type: 'boolean' },
  // 0.7.10
  SelfUpdate: { setting: 'selfUpdate', type: 'boolean' }, // 0: the app never checks or installs updates itself
  BrowserIntegration: { setting: 'browserIntegration', type: 'boolean' },
  WindowsProvider: { setting: 'windowsProvider', type: 'boolean' },
  SignInWindows: { setting: 'signInWindows', type: 'boolean' },
  McpScope: { setting: 'mcpScope', type: 'string' }, // selected | all
  ExtensionIds: { setting: 'extensionIds', type: 'list' }, // comma/semicolon/space separated extension IDs
  DefaultVault: { setting: 'defaultContainer', type: 'vault' }, // vault URL → container id (host name)
};

const unescape = (s) => s.replace(/\\(["\\])/g, '$1');

/** Parses the text of a .reg export → { '<key>': { name: string | number } } (REG_SZ and REG_DWORD). */
export function parseRegExport(text) {
  const keys = {};
  let current = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const key = /^\[(.+)\]$/.exec(line);
    if (key) {
      current = keys[key[1].toUpperCase()] = {};
      continue;
    }
    if (!current) continue;
    const sz = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (sz) {
      current[unescape(sz[1])] = unescape(sz[2]);
      continue;
    }
    const dword = /^"((?:[^"\\]|\\.)*)"=dword:([0-9a-fA-F]{8})$/.exec(line);
    if (dword) current[unescape(dword[1])] = Number.parseInt(dword[2], 16);
  }
  return keys;
}

/** Settings from one parsed hive: { settings, containers }. root e.g. 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Keevault'. */
export function policyFromKeys(keys, root) {
  const base = keys[root.toUpperCase()] || {};
  const settings = {};
  for (const [name, { setting, type }] of Object.entries(VALUES)) {
    const v = base[name];
    if (v === undefined || v === '') continue;
    if (type === 'number') settings[setting] = Number(v);
    else if (type === 'boolean') settings[setting] = Number(v) !== 0 && v !== 'false';
    else if (type === 'list') settings[setting] = String(v).split(/[\s,;]+/).filter((x) => /^[a-p]{32}$/.test(x));
    else if (type === 'vault') {
      const host = /^https:\/\/([a-z0-9-]+\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de))\/?$/i.exec(String(v).trim())?.[1];
      if (host) settings[setting] = host.toLowerCase();
    } else settings[setting] = String(v).trim();
  }
  const containers = [];
  for (const [name, value] of Object.entries(keys[`${root}\\Vaults`.toUpperCase()] || {})) {
    const [url, tenantId] = String(value).split(';').map((x) => x.trim());
    // Without explicit names (list policy without display names) the value name is a number.
    if (/^https:\/\/[a-z0-9-]+\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)\/?$/i.test(url)) {
      containers.push({ name: /^\d+$/.test(name) ? '' : name, vaultUrl: url.replace(/\/?$/, '/'), ...(tenantId ? { tenantId } : {}) });
    }
  }
  return { settings, containers };
}

function exportHive(hive) {
  const file = path.join(os.tmpdir(), `keevault-policy-${process.pid}-${hive}.reg`);
  try {
    execFileSync('reg', ['export', `${hive}\\${POLICY_KEY}`, file, '/y'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return parseRegExport(fs.readFileSync(file, 'utf16le'));
  } catch {
    return {}; // key missing: no policy
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Computer and user policy combined: computer values win, vaults of both are listed (computer first). */
export function readPolicy() {
  if (process.platform !== 'win32') return { settings: {}, containers: [] };
  const user = policyFromKeys(exportHive('HKCU'), `HKEY_CURRENT_USER\\${POLICY_KEY}`);
  const machine = policyFromKeys(exportHive('HKLM'), `HKEY_LOCAL_MACHINE\\${POLICY_KEY}`);
  const seen = new Set();
  const containers = [...machine.containers, ...user.containers].filter((c) => {
    const id = c.vaultUrl.toLowerCase();
    return !seen.has(id) && seen.add(id);
  });
  return { settings: { ...user.settings, ...machine.settings }, containers };
}
