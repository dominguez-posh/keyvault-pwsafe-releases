// Windows 11 passkey provider: requests from the packaged COM provider (windows/PasskeyProvider) arrive over the
// bridge pipe as CTAP2 messages. The user confirms in the desktop app, which signs with keys from the vault.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { parseMakeCredential, parseGetAssertion, encodeMakeCredentialResponse, encodeGetAssertionResponse } from '../extension/core/ctap.js';
import { makeCredentialData, signAssertionData } from '../extension/core/webauthn.js';
import { hostMatches } from '../extension/core/match.js';
import { t } from '../extension/core/i18n.js';

export const ORIGIN = 'windows-provider';
const run = promisify(execFile);

export const aliasPath = () => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'kvpwsafe-passkeys.exe');

// App execution aliases are reparse points that fs.existsSync/stat do not see – look into the directory instead.
export function aliasExists() {
  try {
    return fs.readdirSync(path.dirname(aliasPath())).some((n) => n.toLowerCase() === 'kvpwsafe-passkeys.exe');
  } catch {
    return false;
  }
}

function runProvider(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(aliasPath(), args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out || '{}'));
      } catch {
        reject(new Error(out || 'no output'));
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function providerStatus() {
  if (process.platform !== 'win32') return { supported: false };
  if (!aliasExists()) return { supported: true, installed: false };
  try {
    return { supported: true, installed: true, ...(await runProvider(['--status'])) };
  } catch (e) {
    return { supported: true, installed: true, error: e.message };
  }
}

export const registerProvider = () => runProvider(['--register']);

/** Package shipped with the installer (resources\provider): identity only, the program lies beside it. */
export const bundledPackage = () => path.join(process.resourcesPath || '', 'provider', 'KvPwSafe.PasskeyProvider.msix');
const bundledProgram = () => path.join(process.resourcesPath || '', 'provider', 'KvPwSafe.PasskeyProvider.exe');
// Since 0.9.1 a package with external location (no entry of its own under Settings → Apps); up to 0.9.0 a stand-alone
// package "Keevault Passkeys" that is replaced on the first start.
const PACKAGE = 'Keevault.Passkeys';
const OLD_PACKAGE = 'KvPwSafe.PasskeyProvider';

async function packageVersion(name) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AppxPackage -Name ${name}).Version`], { windowsHide: true }).catch(() => ({ stdout: '' }));
  return String(stdout).trim();
}

const removePackage = (name) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-AppxPackage -Name ${name} | Remove-AppxPackage`], { windowsHide: true }).catch(() => {});

/** "0.4.0.0" newer than "0.3.1.0"? */
export function isNewerVersion(a, b) {
  const x = String(a).trim().split('.').map(Number);
  const y = String(b).trim().split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * First start (and every start until it worked): installs the bundled passkey provider for this user – no
 * administrator rights needed once Windows trusts its certificate – and registers it with Windows.
 * Returns the status plus installError if the package could not be installed.
 */
export async function ensureProvider(expectedVersion) {
  let status = await providerStatus();
  if (!status.supported) return status;
  if (!fs.existsSync(bundledPackage()) || !fs.existsSync(bundledProgram())) return status;
  // The stand-alone package of 0.9.0 and earlier: sign it out of Windows and remove it (same alias and COM class).
  let migrated = false;
  if (await packageVersion(OLD_PACKAGE)) {
    if (aliasExists()) await runProvider(['--unregister']).catch(() => {});
    await removePackage(OLD_PACKAGE);
    status = await providerStatus();
    migrated = true;
  }
  // Update: the package carries the app version (x.y.z.0); register the bundled one if ours is newer.
  const current = await packageVersion(PACKAGE);
  const outdated = !!current && !!expectedVersion && isNewerVersion(expectedVersion, current);
  if (!current || outdated) {
    try {
      // The installation folder (resources\provider\…exe inside) is the package's external location.
      const external = path.dirname(path.dirname(path.dirname(bundledProgram())));
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-AppxPackage -Path ${psQuote(bundledPackage())} -ExternalLocation ${psQuote(external)} -ForceApplicationShutdown`], { windowsHide: true });
    } catch (e) {
      return { ...status, installError: String(e.stderr || e.message).split('\n').find((l) => l.trim()) || e.message };
    }
    status = await providerStatus();
  }
  if (status.installed && !status.registered) {
    await registerProvider();
    status = await providerStatus();
  }
  return migrated ? { ...status, migrated } : status;
}

/**
 * Device-wide parts that need an administrator (or IT via Intune): trust for the self-signed certificate of
 * the provider package and the browser policy that installs the extension.
 */
/** Turned off: unregister from Windows and remove the package, so no "Keevault Passkeys" stays in the app list. */
export async function removeProvider() {
  if (process.platform !== 'win32') return;
  if (aliasExists()) await run(aliasPath(), ['--unregister'], { windowsHide: true }).catch(() => {});
  await removePackage(PACKAGE);
  await removePackage(OLD_PACKAGE);
}

// Device-wide setup (certificate trust, browser policy) lives in machine-setup.js: only fixed system programs run elevated.
export { machineSetupStatus, runMachineSetup } from './machine-setup.js';

/** The provider starts the desktop app with this command line when it is not running. */
export async function rememberDesktopCommand(executable, args) {
  if (process.platform !== 'win32') return;
  const key = 'HKCU\\Software\\KeyVault PwSafe';
  await run('reg', ['add', key, '/v', 'DesktopExecutable', '/t', 'REG_SZ', '/d', executable, '/f'], { windowsHide: true });
  await run('reg', ['add', key, '/v', 'DesktopArguments', '/t', 'REG_SZ', '/d', args, '/f'], { windowsHide: true });
}

class ProviderError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

export class WindowsProvider {
  /**
   * vault(): VaultSession, isOpen(): bool, actor(): string, show(): bring the app to the front, notify(): UI update,
   * pin: { state() → { required, pinSet }, check(pin) } – the app PIN that every passkey use needs (#439)
   */
  constructor({ vault, isOpen, actor, show, notify, pin }) {
    if (!pin) throw new Error('WindowsProvider needs the passkey PIN check');
    this.pin = pin;
    this.vault = vault;
    this.isOpen = isOpen;
    this.actor = actor;
    this.show = show;
    this.notify = notify;
    this.pending = new Map();
    this.syncTimer = null;
  }

  status() {
    return { unlocked: this.isOpen() };
  }

  /** kind: create | get; msg: { request (base64 CTAP), transactionId } → resolves with { response (base64) }. */
  request(kind, msg) {
    const bytes = Buffer.from(String(msg.request || ''), 'base64');
    const parsed = kind === 'create' ? parseMakeCredential(bytes) : parseGetAssertion(bytes);
    const rpId = kind === 'create' ? parsed.rp.id : parsed.rpId;
    if (!rpId) throw new ProviderError('Error', 'missing RP ID');
    return new Promise((resolve, reject) => {
      const id = String(msg.transactionId || crypto.randomUUID());
      const timer = setTimeout(() => this.finish(id, new ProviderError('Cancelled', t('Passkey-Vorgang abgebrochen oder abgelaufen'))), 5 * 60_000);
      this.pending.set(id, { id, kind, rpId, parsed, resolve, reject, timer, created: Date.now() });
      this.show();
      this.notify();
    });
  }

  finish(id, error, result) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve(result);
    this.notify();
  }

  cancel(transactionId) {
    this.finish(String(transactionId), new ProviderError('Cancelled', t('Vom Benutzer abgebrochen')));
  }

  /** Pending requests with what the confirmation dialog needs (only when the vault is open). */
  async list() {
    const out = [];
    for (const p of this.pending.values()) {
      const info = {
        id: p.id, kind: p.kind, rpId: p.rpId, rpName: p.parsed.rp?.name || p.rpId,
        user: p.kind === 'create' ? { name: p.parsed.user.name, displayName: p.parsed.user.displayName } : null,
        locked: !this.isOpen(),
        pin: this.pin.state(),
      };
      if (this.isOpen()) {
        const vault = this.vault();
        const containers = await vault.containers();
        const names = new Map(containers.map((c) => [c.id, c.name]));
        if (p.kind === 'get') {
          info.candidates = (await vault.passkeyCandidates(p.rpId, p.parsed.allowList)).map((c) => ({
            containerId: c.containerId, itemId: c.itemId, credentialId: c.passkey.credentialId,
            title: c.title, userName: c.passkey.userName || c.passkey.userDisplayName || '', container: names.get(c.containerId) || '',
          }));
        } else {
          info.containers = containers.filter((c) => c.access?.write !== false && !c.locked && !c.error).map((c) => ({ id: c.id, name: c.name }));
          // Offered as save target: logins of the site, and logins with the account's user name – a Microsoft account
          // entry usually carries portal or admin addresses, not login.microsoft.com (2026-11-01). Same user name first.
          const user = String(p.parsed.user?.name || '').trim().toLowerCase();
          const sameUser = (s) => !!user && String(s.username || '').trim().toLowerCase() === user;
          info.logins = (await vault.summaries()).filter((s) => s.type === 'login'
            && (sameUser(s) || s.rpIds.includes(p.rpId) || s.hosts.some((h) => hostMatches(h, p.rpId))))
            .sort((a, b) => sameUser(b) - sameUser(a))
            .map((s) => ({ containerId: s.containerId, id: s.id, title: s.title, username: s.username, container: names.get(s.containerId) || '', sameUser: sameUser(s) }));
          info.excluded = p.parsed.excludeList.length ? (await vault.passkeyCandidates(p.rpId, p.parsed.excludeList)).length > 0 : false;
        }
        info.lockedContainers = containers.filter((c) => c.protected && c.locked).map((c) => c.name);
      }
      out.push(info);
    }
    return out;
  }

  /** decision: { cancel } | create: { containerId, itemId?, title } | get: { containerId, itemId, credentialId } */
  async decide(id, decision) {
    const p = this.pending.get(id);
    if (!p) throw new Error(t('Die Anfrage ist abgelaufen'));
    if (decision.cancel) {
      this.finish(id, new ProviderError('Cancelled', t('Vom Benutzer abgebrochen')));
      return;
    }
    const vault = this.vault();
    if (p.kind === 'create') {
      if (p.parsed.excludeList.length && (await vault.passkeyCandidates(p.rpId, p.parsed.excludeList)).length) {
        this.finish(id, new ProviderError('Excluded', t('Für dieses Konto ist bereits ein Passkey registriert')));
        return;
      }
      const { passkey, authData } = await makeCredentialData({
        rpId: p.rpId, rpName: p.parsed.rp.name, user: p.parsed.user, pubKeyCredParams: p.parsed.pubKeyCredParams,
      });
      if (decision.itemId) {
        const item = await vault.getItem(decision.containerId, decision.itemId, { fresh: true });
        await vault.saveItem(decision.containerId, {
          ...item, passkeys: [...item.passkeys, passkey], username: item.username || p.parsed.user.name,
        }, { expectedVersion: item.version });
      } else {
        await vault.saveItem(decision.containerId, {
          type: 'login', title: decision.title || p.parsed.rp.name || p.rpId, username: p.parsed.user.name, urls: [`https://${p.rpId}`], passkeys: [passkey],
        });
      }
      this.finish(id, null, { response: Buffer.from(encodeMakeCredentialResponse(authData)).toString('base64') });
      this.scheduleSync();
      return;
    }
    // #439: the PIN for this one use – wrong, missing or none set: nothing is signed and the request stays open.
    await this.pin.check(decision.pin);
    const candidate = (await vault.passkeyCandidates(p.rpId, p.parsed.allowList))
      .find((c) => c.containerId === decision.containerId && c.itemId === decision.itemId && c.passkey.credentialId === decision.credentialId);
    if (!candidate) throw new Error(t('Passkey nicht gefunden'));
    const { authData, signature, signCount } = await signAssertionData({ rpId: p.rpId, clientDataHash: p.parsed.clientDataHash, passkey: candidate.passkey });
    if (signCount > 0) {
      const item = await vault.getItem(candidate.containerId, candidate.itemId, { fresh: true });
      await vault.saveItem(candidate.containerId, {
        ...item, passkeys: item.passkeys.map((k) => (k.credentialId === candidate.passkey.credentialId ? { ...k, signCount } : k)),
      }).catch(() => {});
    }
    const response = encodeGetAssertionResponse({
      credentialId: candidate.passkey.credentialId, authData, signature,
      user: { id: candidate.passkey.userHandle, name: candidate.passkey.userName, displayName: candidate.passkey.userDisplayName },
    });
    this.finish(id, null, { response: Buffer.from(response).toString('base64') });
  }

  /** Hands the passkey list (names only, no keys) to Windows for its picker. */
  scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync().catch(() => {}), 3000);
  }

  async sync() {
    if (!this.isOpen() || !aliasExists()) return null;
    const vault = this.vault();
    const list = [];
    for (const s of (await vault.summaries()).filter((x) => x.rpIds.length)) {
      const item = await vault.getItem(s.containerId, s.id).catch(() => null);
      for (const k of item?.passkeys || []) {
        // Windows needs a user ID; imported passkeys may lack one – those cannot be shown, skip them.
        if (!k.credentialId || !k.rpId || !k.userHandle) continue;
        list.push({ credentialId: k.credentialId, rpId: k.rpId, rpName: k.rpName || k.rpId, userId: k.userHandle, userName: k.userName || '', userDisplayName: k.userDisplayName || '' });
      }
    }
    return runProvider(['--sync'], JSON.stringify(list));
  }
}
