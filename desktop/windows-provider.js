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

/** Package shipped with the installer (resources\provider). */
export const bundledPackage = () => path.join(process.resourcesPath || '', 'provider', 'KvPwSafe.PasskeyProvider.msix');

const bundledCertificate = () => path.join(process.resourcesPath || '', 'provider', 'KvPwSafe-Test.cer');
const setupScript = () => path.join(process.resourcesPath || '', 'setup.ps1');
const EXTENSION_ID = 'pbkjijhihclckeeefbepoedgdmajioip';
const UPDATE_URL = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml';
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
  let outdated = false;
  if (status.installed && expectedVersion && fs.existsSync(bundledPackage())) {
    // Update: the package carries the app version (x.y.z.0); install the bundled one if ours is newer.
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name KvPwSafe.PasskeyProvider).Version'], { windowsHide: true }).catch(() => ({ stdout: '' }));
    outdated = !!String(stdout).trim() && isNewerVersion(expectedVersion, stdout);
  }
  if ((!status.installed || outdated) && fs.existsSync(bundledPackage())) {
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-AppxPackage -Path ${psQuote(bundledPackage())}`], { windowsHide: true });
    } catch (e) {
      return { ...status, installError: String(e.stderr || e.message).split('\n').find((l) => l.trim()) || e.message };
    }
    status = await providerStatus();
  }
  if (status.installed && !status.registered) {
    await registerProvider();
    status = await providerStatus();
  }
  return status;
}

/**
 * Device-wide parts that need an administrator (or IT via Intune): trust for the self-signed certificate of
 * the provider package and the browser policy that installs the extension.
 */
export async function machineSetupStatus() {
  if (process.platform !== 'win32') return { supported: false };
  let certTrusted = true;
  if (fs.existsSync(bundledCertificate())) {
    const thumb = new crypto.X509Certificate(fs.readFileSync(bundledCertificate())).fingerprint.replace(/:/g, '');
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[bool](Get-ChildItem Cert:\\LocalMachine\\TrustedPeople, Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq '${thumb}')`], { windowsHide: true });
      certTrusted = /true/i.test(stdout);
    } catch {
      certTrusted = false;
    }
  }
  const policy = async (key) => {
    try {
      const { stdout } = await run('reg', ['query', key], { windowsHide: true });
      // Present and pointing to the current source (an old URL counts as missing – the setup replaces it).
      return stdout.includes(`${EXTENSION_ID};${UPDATE_URL}`);
    } catch {
      return false;
    }
  };
  return {
    supported: true,
    certTrusted,
    edgePolicy: await policy('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist'),
    chromePolicy: await policy('HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist'),
    canRunSetup: fs.existsSync(setupScript()),
  };
}

/** Runs the machine part of the setup elevated (UAC prompt, started by the user). Resolves with the exit code. */
export async function runMachineSetup() {
  const args = `-NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(setupScript())} -Action Install -Scope Machine -CertificatePath ${JSON.stringify(bundledCertificate())}`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psQuote(args)}; $p.ExitCode`], { windowsHide: true });
  return Number(String(stdout).trim()) || 0;
}

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
  /** vault(): VaultSession, isOpen(): bool, actor(): string, show(): bring the app to the front, notify(): UI update */
  constructor({ vault, isOpen, actor, show, notify }) {
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
          info.logins = (await vault.summaries()).filter((s) => s.type === 'login' && (s.rpIds.includes(p.rpId) || s.hosts.some((h) => hostMatches(h, p.rpId))))
            .map((s) => ({ containerId: s.containerId, id: s.id, title: s.title, username: s.username, container: names.get(s.containerId) || '' }));
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
