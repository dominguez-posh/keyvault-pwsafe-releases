// Desktop settings. An organization file kvpwsafe.config.json (next to the program, in
// %ProgramData%\Keevault or in the repository root during development) can preset tenantId,
// clientId, containers and language; values from that file cannot be changed in the app.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readPolicy } from './policy.js';

const DEFAULTS = {
  tenantId: '',
  clientId: '',
  containers: [],
  hiddenContainers: [],
  autoLockMinutes: 15,
  clipboardSeconds: 30,
  // Silent sign-in when the token cache allows it (SSO); the account picker is a convenience, not a factor.
  unlockPrompt: 'none',
  defaultContainer: '',
  language: 'auto',
  fileContainers: [],
  browserIntegration: false,
  windowsProvider: false,
  windowsProviderHint: false,
  appPin: null,
  pinGuard: null, // wrong PIN attempts { failures, blockedUntil } – survives a restart
  requirePin: false,
  trayHintShown: false,
  autoTypeKeys: 'CommandOrControl+Shift',
  // Start with Windows (tray only): the browser extension and AI agents find the app without starting it.
  startWithWindows: false,
  signInWindows: true,
  machineSetupHint: '',
  entraUsed: false,
  fileIds: {},
  fileEmail: '',
  approvedBrowsers: [],
  extensionIds: ['pbkjijhihclckeeefbepoedgdmajioip'],
  // Updates: ask (default: check at start, offer the new version in the app), auto (keep up to date), off (manual only).
  updateMode: 'ask',
  // Policy SelfUpdate=0: the app never checks or installs updates itself (IT distributes them) – not a user setting.
  selfUpdate: true,
  // AI agents (MCP): off by default; approved MCP client names.
  mcpEnabled: false,
  approvedAgents: [],
  // What agents may see: 'selected' (only mcpScopes – nothing until released) or 'all' (every vault).
  mcpScope: 'selected',
  mcpScopes: [], // [{ vaultId, folder }] – folder '' = whole vault
  // Per agent: may it write (create/change), and until when the approval holds (null = until removed).
  agentRules: {}, // { [agent]: { write: boolean, until: ISO string | null } }
  // Offline read mode: encrypted mirror of the vault answers (needs the app PIN); off by default, policy can forbid it.
  offlineMirror: false,
};
const ORG_KEYS = ['tenantId', 'clientId', 'autoLockMinutes', 'clipboardSeconds', 'unlockPrompt', 'language', 'extensionIds', 'requirePin', 'updateMode', 'mcpEnabled', 'offlineMirror',
  'selfUpdate', 'browserIntegration', 'windowsProvider', 'signInWindows', 'mcpScope', 'defaultContainer'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export class Config {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.user = readJson(this.file) || {};
    const candidates = [
      path.join(path.dirname(process.execPath), 'kvpwsafe.config.json'),
      process.env.ProgramData && path.join(process.env.ProgramData, 'Keevault', 'kvpwsafe.config.json'),
      // Folder of the old product name (KeyVault PwSafe), still honored for existing deployments.
      process.env.ProgramData && path.join(process.env.ProgramData, 'KeyVault PwSafe', 'kvpwsafe.config.json'),
      path.join(app.getAppPath(), 'kvpwsafe.config.json'),
    ].filter(Boolean);
    this.org = candidates.map(readJson).find(Boolean) || {};
    // Group Policy / Intune (registry) over the file; vaults from both.
    const policy = readPolicy();
    this.org = { ...this.org, ...policy.settings, containers: [...(Array.isArray(this.org.containers) ? this.org.containers : []), ...policy.containers] };
    if (process.env.KVPWSAFE_TENANT_ID) this.org.tenantId = process.env.KVPWSAFE_TENANT_ID;
    if (process.env.KVPWSAFE_CLIENT_ID) this.org.clientId = process.env.KVPWSAFE_CLIENT_ID;
  }

  get() {
    // "defaults" in the organization file (e.g. written by the installer) preset values the user may change.
    const presets = Object.fromEntries(Object.entries(this.org.defaults || {}).filter(([k]) => k in DEFAULTS));
    // The installed app sets itself up: browser integration and passkey provider on unless the user turns them off.
    const installed = app.isPackaged ? { browserIntegration: true, windowsProvider: true } : {};
    const s = { ...DEFAULTS, ...installed, ...presets, ...this.user };
    const enforced = [];
    for (const key of ORG_KEYS) {
      if (this.org[key] !== undefined && this.org[key] !== '') {
        s[key] = this.org[key];
        enforced.push(key);
      }
    }
    s.policyContainers = Array.isArray(this.org.containers) ? this.org.containers : [];
    s.enforced = enforced;
    return s;
  }

  update(patch) {
    const enforced = this.get().enforced;
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && !enforced.includes(k)) this.user[k] = v;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.user, null, 2));
    return this.get();
  }
}
