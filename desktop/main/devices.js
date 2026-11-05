// Assets (servers, VMs): their linked accounts and the connections – remote desktop, SSH, TeamViewer.

import { app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { t } from '../../extension/core/i18n.js';
import { resolveLogin } from '../../extension/core/model.js';
import { smokeTest } from './boot.js';
import { vault } from './state.js';
import { copyToClipboard } from './clipboard.js';
import { helperExe } from './typing.js';
import { showHint } from './hint-window.js';

export const splitEntryKey = (key) => {
  const i = String(key).indexOf('/');
  if (i < 1) throw new Error(t('Verknüpfter Eintrag nicht gefunden'));
  return [key.slice(0, i), key.slice(i + 1)];
};

const DEVICE_LINKS = { rdpLink: 'RDP-Konto', tvLink: 'TeamViewer-Passwort', bastionLoginLink: 'Microsoft-Anmeldung (Bastion)', bastionVmLink: 'Konto auf dem Server (Bastion)' };

/** Linked accounts of a device must lie in the device's own vault (same readers – no access through the back door). */
export function checkDeviceLinks(containerId, s) {
  for (const [field, label] of Object.entries(DEVICE_LINKS)) {
    if (s[field] && splitEntryKey(s[field])[0] !== containerId) {
      throw new Error(t('„{field}“ zeigt auf einen Eintrag in einem anderen Tresor. Verknüpfte Einträge müssen im selben Tresor liegen wie das Asset.', { field: t(label) }));
    }
  }
}

/**
 * Before connecting (#328): links into another vault (asset restored or copied from there) are repaired when this vault
 * has the same entry; the others are named with the vault they point to and how to fix them.
 */
export async function deviceLinksHere(containerId, item) {
  const s = { ...item.server };
  const own = new Set((await vault.summaries({ maxAgeMs: Infinity })).filter((x) => x.containerId === containerId).map((x) => x.id));
  let repaired = false;
  for (const [field, label] of Object.entries(DEVICE_LINKS)) {
    if (!s[field]) continue;
    const [cid, id] = splitEntryKey(s[field]);
    if (cid === containerId) continue;
    if (own.has(id)) {
      s[field] = `${containerId}/${id}`;
      repaired = true;
      continue;
    }
    const other = (await vault.containers()).find((c) => c.id === cid)?.name;
    throw new Error(t('„{field}“ dieses Assets zeigt auf einen Eintrag im Tresor „{vault}“. Verknüpfte Einträge müssen im selben Tresor liegen wie das Asset – Asset bearbeiten und „{field}“ neu auswählen.',
      { field: t(label), vault: other || t('nicht verfügbar') }));
  }
  if (repaired) await vault.saveItem(containerId, { ...item, server: s }, { expectedVersion: item.version }).catch(() => {});
  return s;
}

/** Entry with the sign-in it uses: a login linked to another (domain or Microsoft login) gets that one's values. */
export const usableItem = async (containerId, id) => resolveLogin(await vault.getItem(containerId, id), (c, i) => vault.getItem(c, i));

/** Account of a server connection: the linked entry, else the server entry's own user name and password. */
export async function serverAccount(item, link) {
  if (link) {
    try {
      return await usableItem(...splitEntryKey(link));
    } catch {
      throw new Error(t('Der verknüpfte Eintrag ist nicht verfügbar (gelöscht oder kein Zugriff auf seinen Tresor).'));
    }
  }
  return { username: item.username, password: item.password };
}

/**
 * SSH in its own console window (Windows OpenSSH client, no shell in between). ssh takes no password on the command
 * line: it goes to the clipboard (history/cloud markers, cleared after the set time) for pasting at the prompt.
 * Host and user are checked strictly – nothing that ssh could read as an option or a shell could interpret.
 */
export async function launchSsh(host, port, username, password) {
  if (!/^[\w[][\w.:[\]-]*$/.test(host)) throw new Error(t('Ungültige Serveradresse'));
  if (username && !/^[\w.@\\-]+$/.test(username)) throw new Error(t('Ungültiger Benutzername für SSH'));
  if (smokeTest) return { copied: !!password };
  if (process.platform !== 'win32') throw new Error(t('SSH-Verbindungen gibt es zurzeit nur unter Windows.'));
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  try { statSync(exe); } catch { throw new Error(t('OpenSSH-Client nicht gefunden – unter Einstellungen → System → Optionale Features „OpenSSH-Client“ hinzufügen.')); }
  // detached: a console program gets its own window on Windows.
  spawn(exe, [...(username ? ['-l', username] : []), '-p', String(port || 22), host], { detached: true, stdio: 'ignore' }).unref();
  if (password) await copyToClipboard(password);
  return { copied: !!password };
}

/**
 * Remote desktop: the helper (windows/Setup, Rdp.cs) puts the account into a temporary Windows credential for this
 * server, starts mstsc and removes it again after the connection was made (a credential saved before is restored).
 * The password goes through stdin, never onto a command line.
 */
export async function launchRdp(host, port, username, password) {
  if (smokeTest) {
    // Smoke: KVPWSAFE_TEST_CREDENTIAL_GUARD=1 takes the Credential Guard way (nothing is started).
    if (process.env.KVPWSAFE_TEST_CREDENTIAL_GUARD === '1' && password) {
      await copyToClipboard(password);
      showHint({ kind: 'rdp', user: username });
      return { prompt: true, copied: true, credentialGuard: true };
    }
    return { prompt: !password };
  }
  if (process.platform !== 'win32') throw new Error(t('Remotedesktop gibt es nur unter Windows.'));
  const target = port && port !== 3389 ? `${host}:${port}` : host;
  // Credential Guard forbids saved credentials for remote desktop ("Windows Defender Credential Guard lässt die
  // Verwendung von gespeicherten Anmeldeinformationen nicht zu", #29): mstsc with the user name filled in, the password
  // on the clipboard (cleared as usual) for the Windows dialog. That dialog drops every typed input – Unicode, real
  // keys and UI Automation alike (tested 2026-11-05, #336) –, so typing it in (#189) never worked: Ctrl+V it is.
  if (password && (await credentialGuardRunning())) {
    await copyToClipboard(password);
    const file = path.join(app.getPath('temp'), `keevault-rdp-${process.pid}.rdp`);
    await fs.writeFile(file, [`full address:s:${target}`, `username:s:${username}`, 'prompt for credentials:i:1', ''].join('\r\n'), 'utf8');
    spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => fs.rm(file, { force: true }).catch(() => {}), 60_000).unref?.();
    // The window explains why there is no automatic sign-in and what to do (#338).
    showHint({ kind: 'rdp', user: username });
    return { prompt: true, copied: true, credentialGuard: true };
  }
  const exe = helperExe();
  if (!exe || !password) {
    spawn('mstsc.exe', [`/v:${target}`], { detached: true, stdio: 'ignore' }).unref();
    return { prompt: !!username };
  }
  const child = spawn(exe, ['--rdp'], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end([host, String(port || 3389), username, password].join('\n'));
  child.unref();
  return { prompt: false };
}


/** Is Windows Defender Credential Guard running (Win32_DeviceGuard: security service 1)? Asked once per start. */
let credentialGuard = null;
function credentialGuardRunning() {
  if (credentialGuard) return credentialGuard;
  credentialGuard = new Promise((resolve) => {
    execFileCb('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance -Namespace root\\Microsoft\\Windows\\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop).SecurityServicesRunning -contains 1'],
    { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && /True/i.test(String(out))));
  });
  return credentialGuard;
}

/** TeamViewer with ID (and password when stored); without the program installed: its link, password to clipboard. */
export async function launchTeamViewer(id, password) {
  if (smokeTest) return { copied: false };
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const exe = process.platform === 'win32' ? dirs.map((d) => path.join(d, 'TeamViewer', 'TeamViewer.exe')).find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) : null;
  if (exe) {
    spawn(exe, ['-i', id, ...(password ? ['--Password', password] : [])], { detached: true, stdio: 'ignore' }).unref();
    return { copied: false };
  }
  await shell.openExternal(`teamviewer10://control?device=${encodeURIComponent(id)}`);
  if (password) await copyToClipboard(password);
  return { copied: !!password };
}
