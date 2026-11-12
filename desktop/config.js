// Desktop settings. An organization file kvpwsafe.config.json (next to the program, in
// %ProgramData%\Keevault or in the repository root during development) can preset tenantId,
// clientId, containers and language; values from that file cannot be changed in the app.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readPolicy } from './policy.js';
import { readJson, readOrgFile } from './org-file.js';

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
  windowHello: false, // #512: Windows Hello lifts the window lock besides the PIN – only through setWindowHello (with the PIN)
  passkeyPin: true, // #439: every passkey use asks for the app PIN (on by default; the policy RequirePin makes it fixed)
  trayHintShown: false,
  autoTypeKeys: 'CommandOrControl+Shift',
  // Start with Windows (tray only): the browser extension and AI agents find the app without starting it.
  startWithWindows: false,
  signInWindows: true,
  machineSetupHint: '',
  entraUsed: false,
  fileIds: {},
  fileIdNotes: {}, // per path: name, creator and safety code of the vault seen there (#404)
  fileEmail: '',
  approvedBrowsers: [],
  extensionIds: ['pbkjijhihclckeeefbepoedgdmajioip'],
  // Updates: ask (default: check at start, offer the new version in the app), auto (keep up to date), off (manual only).
  updateMode: 'ask',
  // Update channel: 'stable' (released versions) or 'beta' (Early Access: also versions still in the field test).
  updateChannel: 'stable',
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
  // Entries an agent reads without asking ("never ask again"), revoked from the entry's context menu.
  mcpTrusted: [], // [{ agent, vaultId, entryId, title }]
  // Agents may sign one sign-in with a stored passkey (#308) / ask for a Microsoft sign-in (#315) – each use confirmed.
  mcpPasskeys: false,
  mcpMicrosoft: false,
  // Offline read mode: encrypted mirror of the vault answers (needs the app PIN); off by default, policy can forbid it.
  offlineMirror: false,
  // View (main menu): zoom factor of the window and see-through ground (off | light | strong, Windows 11 acrylic).
  zoom: 1,
  transparency: 'light',
  // View: colour scheme – 'system' follows Windows' app mode, 'light' / 'dark' fix it.
  theme: 'system',
  // Version for which Keevault.exe was excluded from Windows Error Reporting (no crash dumps).
  werExcluded: '',
  // View: small marks before the vaults – cloud for Azure Key Vault, drive for local files.
  sourceBadges: true,
  // View: "PIM" button top right (opens aka.ms/pim to activate an eligible Azure role).
  pimButton: false,
  // View: "PIM" button on the unlock screen (activate a role before signing in) – off until turned on in the menu.
  pimOnLock: false,
  // View: PIM button in the sidebar head while admin mode is on (between the brand and the lock) – off by default.
  adminPim: false,
  // Admin mode offered (Settings → View): only then its switch sits next to Help – off, nobody sees it.
  adminOffered: false,
  // View: admin tools top right – PIM, Microsoft 365 admin centers, servers (replaces the single PIM button).
  adminTools: false,
  // #476: in admin mode, Verwalter see other people's "Nur für mich" entries – off by default, off again with admin mode.
  showOthersPrivate: false,
  // Break-glass accounts per tenant ({ [tenantId]: [{ id, type, displayName, detail }] }): preset when creating a vault.
  breakGlass: {},
  // Second installation found (path|version) the user chose not to be told about again.
  otherInstallDismissed: '',
  // Personal vault: file path (OneDrive / synced folder / network drive) and its key bound to this device and the PIN.
  // Personal vaults (paths; several, e.g. private and business) and their keys bound to this device and the PIN.
  personalVaults: [],
  // Order of the vaults in the sidebar (container ids, by drag and drop); vaults not listed follow in their own order.
  containerOrder: [],
  personalDeviceKeys: {},
  // Personal vaults whose recovery key was not confirmed yet: vault id → id of its recovery entry, never a key (#399). Device only.
  personalRecoveryPending: {},
  // Of those, the ones whose key was renewed in the app and shown once: vault id → same entry id. "I have stored it" is no answer there.
  personalRecoveryRenewed: {},
  personalOffered: false, // the wizard opened once by itself
  setupOffered: false, // the setup wizard for a team vault opened once by itself (first start on this device)
  // Connect every Key Vault marked as a Keevault vault after signing in (off: only vaults added by hand or policy).
  autoDiscover: false,
  // Settings of this app saved in the personal vault: a new device takes them over (vaults, view, behaviour).
  settingsSync: true,
  settingsSyncedAt: 0, // time of the settings last taken from or written to the personal vault
  settingsLocalAt: 0, // time of the last change here to a setting that travels with the personal vault
  // #478: a copy of the travelling settings (no secrets) in OneDrive\Keevault\Keevault-Einstellungen.json. Device only.
  // null = not asked yet: nothing is written until the user says yes (asked once, also after the update).
  settingsCopy: null,
  settingsCopyPending: false, // the first start still asks whether to take the settings found there: no copy until then
};
// Travel with the personal vault to the user's other devices. Not: PIN, device keys, what is installed on this device
// (browser integration, passkey provider, autostart), admin mode and the approvals for AI agents.
export const SYNC_KEYS = ['containers', 'hiddenContainers', 'containerOrder', 'defaultContainer', 'tenantId', 'clientId', 'autoLockMinutes',
  'clipboardSeconds', 'unlockPrompt', 'language', 'zoom', 'transparency', 'theme', 'sourceBadges', 'autoTypeKeys', 'updateMode',
  'updateChannel', 'breakGlass', 'autoDiscover', 'signInWindows', 'pimOnLock', 'adminPim', 'adminOffered'];
const ORG_KEYS = ['tenantId', 'clientId', 'autoLockMinutes', 'clipboardSeconds', 'unlockPrompt', 'language', 'extensionIds', 'requirePin', 'updateMode', 'updateChannel', 'mcpEnabled', 'offlineMirror',
  'selfUpdate', 'browserIntegration', 'windowsProvider', 'signInWindows', 'mcpScope', 'defaultContainer',
  'windowHello']; // #512: only false is enforced (the organization forbids Windows Hello; switching on stays the user's, with the PIN)

export class Config {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.user = readJson(this.file) || {};
    // One personal vault (0.9.3 and earlier) → the list; written with the next update of the settings.
    if (this.user.personalVault && !Array.isArray(this.user.personalVaults)) {
      this.user.personalVaults = [this.user.personalVault];
      if (this.user.personalDeviceKey) this.user.personalDeviceKeys = { [this.user.personalVault]: this.user.personalDeviceKey };
    }
    delete this.user.personalVault;
    delete this.user.personalDeviceKey;
    // Up to 0.9.18 every marked Key Vault was connected by itself: installations that signed in keep that.
    if (this.user.entraUsed && !Object.hasOwn(this.user, 'autoDiscover')) this.user.autoDiscover = true;
    this.org = readOrgFile({ execPath: process.execPath, programData: process.env.ProgramData, appPath: app.getAppPath() });
    // Group Policy / Intune (registry) over the file; vaults from both.
    const policy = readPolicy();
    this.org = { ...this.org, ...policy.settings, containers: [...(Array.isArray(this.org.containers) ? this.org.containers : []), ...policy.containers] };
    if (process.env.KVPWSAFE_TENANT_ID) this.org.tenantId = process.env.KVPWSAFE_TENANT_ID;
    if (process.env.KVPWSAFE_CLIENT_ID) this.org.clientId = process.env.KVPWSAFE_CLIENT_ID;
  }

  get() {
    // "defaults" in the organization file (e.g. written by the installer) preset values the user may change.
    const presets = Object.fromEntries(Object.entries(this.org.defaults || {}).filter(([k]) => k in DEFAULTS));
    // The installed app sets up the browser integration unless the user turns it off. The Windows passkey provider
    // (a package of its own) is only installed when someone turns it on – the extension's passkeys work without it.
    const installed = app.isPackaged ? { browserIntegration: true } : {};
    const s = { ...DEFAULTS, ...installed, ...presets, ...this.user };
    const enforced = [];
    for (const key of ORG_KEYS) {
      if (key === 'windowHello' && this.org[key] !== false) continue; // #512: never forced on
      if (this.org[key] !== undefined && this.org[key] !== '') {
        s[key] = this.org[key];
        enforced.push(key);
      }
    }
    s.policyContainers = Array.isArray(this.org.containers) ? this.org.containers : [];
    s.enforced = enforced;
    return s;
  }

  /** Whether the user (not a default or preset) set this key. */
  has(key) {
    return Object.hasOwn(this.user, key);
  }

  /** synced: the values come from the personal vault (not a change here that has to go there). */
  update(patch, { synced = false } = {}) {
    const before = this.get();
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && !before.enforced.includes(k)) this.user[k] = v;
    }
    const travels = !synced && SYNC_KEYS.some((k) => Object.hasOwn(patch || {}, k) && JSON.stringify(before[k]) !== JSON.stringify(this.user[k]));
    if (travels) this.user.settingsLocalAt = Date.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.user, null, 2));
    if (travels) this.onSyncChange?.();
    this.onChange?.();
    return this.get();
  }

  /** The travelling settings the user set here (defaults stay out, so another device keeps its own). */
  syncSnapshot() {
    return Object.fromEntries(SYNC_KEYS.filter((k) => Object.hasOwn(this.user, k)).map((k) => [k, this.user[k]]));
  }
}
